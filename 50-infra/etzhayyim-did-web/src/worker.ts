import didDoc from "../did.json";
import {
  UNISPSC_HANDLES,
  UNISPSC_GENERATED_AT,
  UNISPSC_TOTAL_COUNT,
} from "./registry/unispsc-handles.gen";
import {
  INFRA_ACTORS,
  INFRA_ACTOR_HANDLES,
  getInfraActor,
} from "./registry/infra-actors";
import {
  actorHandleFromParam,
  compiledActorRecord,
  toDidDoc,
  toGetProfileView,
  didDocCid,
  COMPILED_ACTOR_HANDLES,
  type ActorRecord,
} from "./registry/actor-profiles";
import {
  isEntityHandle,
  isEntityHandleShape,
  entityActorRecord,
  searchEntityActors,
  entityNamespaceSummary,
  ENTITY_TOTAL_COUNT,
} from "./registry/entity-actors";
import {
  GOV_PROCEDURES_BY_OWNER,
  GOV_PROCEDURE_LIST,
  GOV_PROCEDURES_TOTAL,
  GOV_PROCEDURES_OWNER_COUNT,
  GOV_PROCEDURES_JURISDICTION_COUNT,
  GOV_PROCEDURES_GENERATED_AT,
} from "./registry/gov-procedures.gen";
import { fetchKotobaActorRecord, relayKotobaWrite } from "./kotoba";
import { cacaoToCborBase64 } from "./cbor";
import { handleBlockPut, handleBlockHas, handleRootGet, handleStatsGet, serveBlockFromKv } from "./kotoba-publish";
import { isRawCidV1, isDagPbCidV1, verifyRawCid } from "./cid";
import { verifyCarToBytes } from "./car";
import { fetchOnChainVm } from "./erc725";
import { handleVerifyCacao, handleAccountWrite } from "./session";

// kotoba wasm assets — served through Worker to ensure HSTS headers (Issue #1561)
// The Cloudflare [assets] binding serves static files from edge cache without
// invoking the Worker, so we bundle these assets in the Worker and serve them
// with proper security headers including Strict-Transport-Security.
// Type declarations for asset imports (inline to avoid new file under frozen layer)
declare module "./kotoba-wasm/kotoba_wasm.js" {
  const content: string;
  export default content;
}
declare module "./kotoba-wasm/kotoba_wasm_bg.wasm" {
  const content: Uint8Array;
  export default content;
}
import kotobaWasmJs from "./kotoba-wasm/kotoba_wasm.js";
import kotobaWasmBg from "./kotoba-wasm/kotoba_wasm_bg.wasm";

/**
 * etzhayyim did:web Worker + apex reverse proxy
 *
 * Three responsibilities:
 *
 * 1) Entity DID Document — served at `https://etzhayyim.com/.well-known/did.json`
 *    per the W3C did:web spec. Resolves `did:web:etzhayyim.com`.
 *
 * 2) Per-actor DID Document — served at
 *    `https://etzhayyim.com/actor/<handle>/did.json`. Resolves
 *    `did:web:etzhayyim.com:actor:<handle>` per W3C did:web colon-to-slash
 *    path syntax. Per ADR-2605212030 §D2, the canonical public-facing
 *    DID is `did:web:<handle>.etzhayyim.com` (subdomain form); the
 *    path-based form here is the immediate stand-in until wildcard DNS
 *    + a wildcard CF route are provisioned. Both forms MUST resolve to
 *    the same actor (bidirectional pointer in the returned document).
 *
 * 3) Apex landing & all other paths — reverse-proxied to UPSTREAM_HOST
 *    (default `yoro.etzhayyim.com`). This unblocks `https://etzhayyim.com/`
 *    while a dedicated etzhayyim landing page is being authored. yoro
 *    is a SvelteKit app served from Cloudflare; assets use relative URLs
 *    so the proxy is transparent.
 *
 * Route binding (wrangler.toml):
 *   pattern = "etzhayyim.com/*"
 *   zone_name = "etzhayyim.com"
 *
 * Excluded from proxy (always served locally by this Worker):
 *   - /.well-known/did.json                — entity DID Document
 *   - /actor/<handle>/did.json             — per-actor DID Document
 *   - /actors                              — actor registry index (HTML, human-facing)
 *   - /.well-known/actors.json             — actor registry (machine-readable)
 *   - /donate                              — donation declaration (HTML, ADR-2606012100)
 *   - /.well-known/donation.json           — donation policy (machine-readable)
 *   - future: /.well-known/atproto-did, /.well-known/security.txt, etc.
 */

const UPSTREAM_HOST = "yoro.etzhayyim.com";

// ─── Donation policy (ADR-2606012100) ──────────────────────────────────────
//
// etzhayyim is a 宗教法人 operated ONLY on donation (non_profit_only +
// donation_only constitutional constants, ADR-2605192100 §2 / ADR-2605192115).
// This Worker serves the public declaration locally (cookie-free, tracker-free)
// at two routes — the human page `/donate` and the machine policy
// `/.well-known/donation.json` — satisfying the ADR-2605192115 §6 public-proof
// requirement on the always-on apex surface (alongside the DID document).
//
// Two donation media: CASH (USDC via TitheRouter, 90/10 split) and in-kind
// COMPUTE (joining the Murakumo mesh + kotoba substrate as a donated node).
// Compute donation is uncompensated, non-titheable, and grants the donor
// nothing (anti-class G4). See ADR-2606012100.
const DONATION_POLICY = {
  entity: "etzhayyim",
  entityDid: "did:web:etzhayyim.com",
  form: "宗教法人 (任意団体 / unincorporated religious voluntary association)",
  fundedBy: "donation-only",
  invariants: {
    nonProfitOnly: true,
    donationOnly: true,
    advertising: "none",
    sells: "nothing",
    adherentCashStipend: 0, // Basic High Income N1: cashStipendUsd ≡ 0 (ADR-2605301020)
    tracking: "none",
    cookies: "none",
  },
  media: [
    {
      medium: "cash",
      asset: "USDC",
      rail: "TitheRouter.donate() on Base L2",
      split: "90% recipient program / 10% Public Fund (ADR-2605192130)",
      purposes: ["donation", "kisha", "grant"],
      status: "Base L2 testnet pending Council (CLAUDE.md §Live governance)",
    },
    {
      // ADR-2606111800 §C — curated crypto-asset allowlist, held as-is (per-asset tithe).
      medium: "crypto",
      assets: ["ETH", "WETH", "USDC", "USDT", "DAI"],
      heldAsIs: true,
      rail: "on-chain donation to the same address (Base L2; or L1 where un-bridgeable)",
      split: "90/10 tithe computed per-asset at receipt",
      purposes: ["donation", "kisha", "grant"],
      note: "Curated liquid-majors allowlist (Council Tier-2). No memecoins / no algorithmic stablecoins. TitheRouter per-asset support is a follow-up (until then: recorded + manually tithed).",
      status: "pending the same Council ratification + testnet as cash",
    },
    {
      // ADR-2606111800 §B — non-custodial fiat on-ramp settling immediately to USDC on-chain.
      medium: "fiat",
      kind: "non-custodial-onramp",
      custodial: false,
      retainsDonorPii: false,
      settlesTo: "USDC on-chain (immediate)",
      split: "arrives as an ordinary on-chain donation → 90/10 tithe",
      purposes: ["donation"],
      description:
        "Give in fiat via a NON-CUSTODIAL on-ramp that settles immediately to USDC on-chain. etzhayyim holds no fiat balance, retains NO donor PII (any KYC is donor↔on-ramp only), and the processor can never freeze etzhayyim's treasury. CUSTODIAL fiat (Stripe/PayPal holding our balance, KYC-on-etzhayyim, PII retention) stays prohibited (ADR-2605172100 / 2606111800 §B).",
      status: "permitted (ADR-2606111800 §B); on-ramp wiring follows the cash address going live",
    },
    {
      // ADR-2606111800 §A — fiat IN-KIND: paying the mission's fiat bills directly (no inflow).
      medium: "fiat-in-kind",
      kind: "in-kind",
      titheable: false,
      compensated: false,
      grantsBenefit: false,
      description:
        "Pay the mission's real-world fiat costs directly to the vendor (servers / cloud / domains / bandwidth / hardware), for the mission. No money flows to etzhayyim — like donating compute. Imputed-valued for transparency only (toritate, aggregate, no leaderboard); non-titheable; earns the donor nothing. This is how the founder already donates (JPY server costs).",
      record: "com.etzhayyim.give.infrastructureDonationAttestation",
      status: "recognized (ADR-2606111800 §A); no amendment needed — already charter-clean",
    },
    {
      medium: "compute",
      kind: "in-kind",
      titheable: false,
      compensated: false,
      grantsBenefit: false,
      bestEffort: true,
      description:
        "Donate compute/storage to the Murakumo mesh + kotoba substrate as a donated first-party node. Uncompensated gift; earns the donor nothing (anti-class). Murakumo-only — never commercial GPU rental.",
      nodes: [
        {
          class: "ameno",
          how: "Open a consent-gated browser tab; WebGPU/WebNN inference on frozen baien edge models. Zero install (WASM-32, iPhone 12+ / Android 4GB).",
          gates: ["consent-only", "device-power-budget", "frozen-edge-models"],
        },
        {
          class: "e7m",
          how: "`e7m node join` — register a laptop/workstation as an Ollama (gemma3:4b) / WASM inference node.",
          gates: ["donor-held-key", "murakumo-mesh-only"],
        },
        {
          class: "kotoba",
          how: "Run a kotoba pod (IPFS block backend + Datom replication, optional Ollama) joining the substrate.",
          gates: ["donor-hardware", "best-effort"],
        },
      ],
      enrollment: "R0 design; live external mesh-enrollment gated on Council + operator (ADR-2606012100 §6 G9)",
    },
  ],
  // Active solicitation (募集). Benefit-free by construction: a gift earns the donor
  // nothing — no perk, tier, priority, governance weight, or recognition leaderboard
  // (anti-class G4, ADR-2606012100). Soliciting support for etzhayyim's own religious
  // activity is 案内, not advertising (ADR-2605192115 §1.2).
  solicitation: {
    open: true,
    callToAction:
      "etzhayyim runs only on donation. Give money (USDC on Base L2) or compute (join the Murakumo mesh). A gift earns you nothing — no perks, no tiers, no priority — and is never required.",
    grantsBenefit: false, // G4 — no quid-pro-quo
    tiers: "none", // no perk/sponsor tiers (would be a quid-pro-quo)
    leaderboard: "none", // no per-donor ranking (no class formation)
    sponsorButton:
      "GitHub repo Sponsor button (.github/FUNDING.yml) points here — NOT to GitHub Sponsors / Patreon / Stripe (fiat processors prohibited, ADR-2605172100).",
    addressStatus:
      "On-chain donate address is published in THIS document (field media[0]) once live — single source of truth, no second place to drift. Currently pending Council ratification + Base L2 testnet.",
  },
  adr: ["2606012100", "2606111700", "2606111800", "2605192115", "2605192130", "2605172100", "2605215000", "2605301020", "2605241900"],
  references: {
    page: "https://etzhayyim.com/donate",
    howToGive: "https://github.com/etzhayyim/root/blob/main/DONATE.md",
    sponsorButton: "https://github.com/etzhayyim/root/blob/main/.github/FUNDING.yml",
    didDocument: "https://etzhayyim.com/.well-known/did.json",
    repo: "https://github.com/etzhayyim/root",
  },
} as const;

// Static, dependency-free, cookie-free. No external resource, no inline script
// (Charter Rider §2(c) — the page itself must not track). Information about
// etzhayyim's own religious activity = not advertising (ADR-2605192115 §1.2).
const DONATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Donate · etzhayyim</title>
<meta name="description" content="etzhayyim is a religious corp operated only on donation. Give money or compute.">
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;max-width:48rem;padding:2.5rem 1.25rem;margin-inline:auto}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .25rem}
.sub{opacity:.7;margin:0 0 2rem}
h2{font-size:1.15rem;margin:2rem 0 .5rem;border-bottom:1px solid currentColor;padding-bottom:.25rem}
.card{border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:.6rem;padding:1rem 1.1rem;margin:.75rem 0}
.tag{display:inline-block;font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;opacity:.65;border:1px solid currentColor;border-radius:1rem;padding:.05rem .55rem;margin-right:.4rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:color-mix(in srgb,currentColor 10%,transparent);padding:.1rem .35rem;border-radius:.3rem}
ul{margin:.4rem 0 .4rem 1.1rem;padding:0}
footer{margin-top:2.5rem;font-size:.85rem;opacity:.7}
a{color:inherit}
</style>
</head>
<body>
<h1>etzhayyim is operated <em>only</em> on donation.</h1>
<p class="sub">A 宗教法人 (unincorporated religious association). We take no advertising, sell nothing, and never pay any member cash. You can give <strong>money</strong> (USDC, other crypto, or fiat) or <strong>compute</strong> — or pay one of our bills.</p>

<h2>Give money</h2>
<div class="card">
<span class="tag">USDC</span><span class="tag">Base L2</span>
<p>Donations settle on-chain through <strong>TitheRouter</strong>: 90% to the recipient program, 10% auto-split to the Public Fund. No fiat processor, no fees skimmed by middlemen.</p>
<p style="opacity:.7;margin:.25rem 0 0">Status: Base L2 testnet pending Council ratification — on-chain donate address published here when live.</p>
</div>
<div class="card">
<span class="tag">ETH · stablecoins</span><span class="tag">held as-is</span>
<p>We also accept a curated allowlist of liquid crypto — <strong>ETH / WETH / USDC / USDT / DAI</strong> — held in its native asset, tithed 90/10 per asset. No memecoins, no algorithmic stablecoins. (ADR-2606111800 §C.)</p>
</div>
<div class="card">
<span class="tag">fiat</span><span class="tag">non-custodial</span>
<p>Prefer your card or bank? Give in <strong>fiat through a non-custodial on-ramp</strong> that settles immediately to USDC on-chain. We hold no fiat balance, keep <em>none</em> of your personal data (any KYC is between you and the on-ramp), and no processor can ever freeze our funds. (ADR-2606111800 §B.)</p>
</div>

<h2>Pay one of our bills (fiat, in-kind)</h2>
<div class="card">
<span class="tag">fiat · in-kind</span><span class="tag">no inflow</span>
<p>The most direct fiat gift: <strong>pay one of the mission's real-world costs</strong> — a server, cloud, domain, bandwidth, or hardware bill — straight to the vendor, for the mission. No money passes through etzhayyim at all (just like donating compute). It is imputed-valued for transparency only, earns you nothing, and is never tithed. This is how the founder already supports the work — paying server costs in yen. (ADR-2606111800 §A.)</p>
</div>

<h2>Give compute</h2>
<p>Our inference runs on the <strong>Murakumo mesh</strong> only — we deliberately do <em>not</em> rent commercial GPUs. So the most valuable gift you can make is your own compute. It is an <strong>uncompensated gift</strong>: it earns you nothing, buys no benefit, and is never required.</p>

<div class="card">
<span class="tag">ameno</span><span class="tag">browser · zero install</span>
<p>Open a consent-gated tab and your browser runs inference (WebGPU/WebNN) on frozen edge models — on a phone (iPhone 12+ / Android 4GB) or laptop. Runs only while the tab is open and you've opted in; respects a battery/thermal budget.</p>
</div>

<div class="card">
<span class="tag">e7m</span><span class="tag">CLI</span>
<p>Donate a laptop or workstation as a mesh node: <code>e7m node join</code> (and <code>e7m node leave</code> to stop). You hold your own key; we hold none.</p>
</div>

<div class="card">
<span class="tag">kotoba</span><span class="tag">pod · storage</span>
<p>Run a kotoba pod to contribute substrate durability — IPFS block storage and Datom replication (with optional inference). Your hardware, your keys.</p>
</div>

<p style="opacity:.75">Compute you donate joins the Murakumo fleet as a first-party node — never a commercial cloud. It is valued (imputed, for transparency only) but no money ever moves to or from you, and donating more grants you no priority. Live enrollment for external nodes is being rolled out under Council oversight.</p>

<h2>Sponsor on GitHub</h2>
<div class="card">
<span class="tag">github</span><span class="tag">on-chain only</span>
<p>The <a href="https://github.com/etzhayyim/root">etzhayyim/root</a> repo carries a <strong>Sponsor</strong> button — it links straight back to this page. We deliberately do <em>not</em> use GitHub Sponsors, Patreon, or any fiat rail (those route through prohibited fiat processors). See <a href="https://github.com/etzhayyim/root/blob/main/DONATE.md">DONATE.md</a> for the full how-to.</p>
</div>

<p style="opacity:.85"><strong>A gift earns you nothing</strong> — no perks, no tiers, no priority, no recognition leaderboard. We say so plainly: you give because the mission (人類の構造的労働解放) is worth it, not for a benefit.</p>

<footer>
Machine-readable policy: <a href="/.well-known/donation.json">/.well-known/donation.json</a> · How to give: <a href="https://github.com/etzhayyim/root/blob/main/DONATE.md">DONATE.md</a> · Entity DID: <a href="/.well-known/did.json">did:web:etzhayyim.com</a><br>
Design: ADR-2606012100 + ADR-2606111700 · non-profit / donation-only / ad-free / no-adherent-cash are constitutional invariants.
</footer>
</body>
</html>
`;

// ─── Actor registry index (/actors + /.well-known/actors.json) ─────────────
//
// The apex surface lists every actor whose DID resolves at
// `/actor/<handle>/did.json`. INFRA_ACTORS (registry/infra-actors.ts) is the
// single source of truth — adding an actor there makes it both DID-resolvable
// AND appear here, with no second edit. Two media, mirroring /donate:
//   - `/actors`               human page (static HTML, cookie-free, no script)
//   - /.well-known/actors.json machine policy (the registry, JSON)
//
// Glyphed entries (紡ぎ / 綿津綱 …) are the named Tier-B / knowledge-graph
// actors; un-glyphed entries are the substrate plumbing service DIDs.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildActorsJson() {
  const actors = Object.entries(INFRA_ACTORS).map(([handle, e]) => ({
    handle,
    did: `did:web:etzhayyim.com:actor:${handle}`,
    didDocument: `https://etzhayyim.com/actor/${handle}/did.json`,
    glyph: e.glyph ?? null,
    displayName: e.displayName ?? null,
    kind: e.glyph ? "actor" : "substrate-service",
    description: e.description,
    primaryLexicon: e.primaryLexicon ?? null,
    primarySchema: e.primarySchema ?? null,
    adr: e.adrs,
  }));
  // Entity-as-actor mirror namespaces (ADR-2606042330). Society-scale public/
  // power entities each resolve a keyless mirror-actor; enumerated by namespace
  // + count (not row-by-row — there are thousands) and searchable via
  // app.bsky.actor.searchActors.
  const entityNamespaces = entityNamespaceSummary().map((n) => ({
    ...n,
    handleShape: `${n.ns}-<...>`,
    didExample: `did:web:etzhayyim.com:actor:${n.ns}-<...>`,
    note: "keyless observational mirror — NOT the entity itself (no impersonation, G1); public/power entities only (G2); person-excluded (G3)",
  }));
  return {
    entity: "etzhayyim",
    entityDid: "did:web:etzhayyim.com",
    count: actors.length,
    entityActorCount: ENTITY_TOTAL_COUNT,
    totalResolvableActors: actors.length + ENTITY_TOTAL_COUNT + UNISPSC_TOTAL_COUNT,
    note: "Actors whose DID resolves at /actor/<handle>/did.json. INFRA_ACTORS is the named/service SoT; entityNamespaces (ADR-2606042330) are society-scale keyless mirror-actors counted by namespace; UNSPSC commodity agents add unispscActorCount. Free-form member/council handles also resolve but are not enumerated here.",
    unispscActorCount: UNISPSC_TOTAL_COUNT,
    entityNamespaces,
    page: "https://etzhayyim.com/actors",
    adr: ["2605241800", "2605212030", "2606042330", "2605171300"],
    actors,
  };
}

// Attach the content-addressed DID-doc CID per actor so a client can retrieve +
// verify each did.json from any IPFS gateway (`didDocumentIpfs`), not just over
// TLS. The handle→CID binding stays anchored here (TLS) — IPFS makes the bytes
// tamper-evident + mirrorable (ADR-2606015400).
async function buildActorsJsonWithCids(env: DidDocEnvLite) {
  const base = buildActorsJson();
  const actors = await Promise.all(
    base.actors.map(async (a) => {
      const rec = compiledActorRecord(a.handle);
      if (!rec) return a;
      const cid = await didDocCid(rec, env);
      return {
        ...a,
        didDocumentCid: cid,
        didDocumentIpfs: `ipfs://${cid}`,
        didDocumentGateway: `https://etzhayyim.com/ipfs/${cid}`,
      };
    }),
  );
  return { ...base, didResolution: "did:web (TLS) + IPFS (content-addressed)", actors };
}

interface DidDocEnvLite {
  readonly AUTHZ_CONTRACT_ADDRESS?: string;
}

function renderActorCard(handle: string): string {
  const e = INFRA_ACTORS[handle];
  const title = e.glyph
    ? `<span class="glyph">${escapeHtml(e.glyph)}</span> <code>${escapeHtml(handle)}</code>`
    : `<code>${escapeHtml(handle)}</code>`;
  const name = e.displayName
    ? `<p class="name">${escapeHtml(e.displayName)}</p>`
    : "";
  const lex = e.primaryLexicon
    ? `<span class="tag">${escapeHtml(e.primaryLexicon)}</span>`
    : "";
  const schema = e.primarySchema
    ? `<span class="tag">kotoba EDN</span>`
    : "";
  const adrs = e.adrs
    .map((a) => `<span class="tag">ADR-${escapeHtml(a)}</span>`)
    .join("");
  return `<div class="card">
<h3>${title}</h3>
${name}
<p>${escapeHtml(e.description)}</p>
<p class="meta">${lex}${schema}${adrs}</p>
<p class="did"><a href="/actor/${escapeHtml(handle)}/did.json">did:web:etzhayyim.com:actor:${escapeHtml(handle)}</a></p>
</div>`;
}

function buildActorsHtml(): string {
  const handles = Object.keys(INFRA_ACTORS);
  const named = handles.filter((h) => INFRA_ACTORS[h].glyph);
  const infra = handles.filter((h) => !INFRA_ACTORS[h].glyph);
  const namedCards = named.map(renderActorCard).join("\n");
  const infraCards = infra.map(renderActorCard).join("\n");
  const nsRows = entityNamespaceSummary()
    .map(
      (n) =>
        `<div class="card"><h3><span class="glyph">${escapeHtml(n.glyph)}</span> <code>${escapeHtml(n.ns)}-&lt;…&gt;</code> · ${n.count.toLocaleString("en-US")}</h3>
<p>${escapeHtml(n.kindLabel)} — keyless observational <strong>mirror</strong> of each public entity (NOT the entity itself; no impersonation). Maintained by ${n.owners.map((o) => `<code>${escapeHtml(o)}</code>`).join(", ")}.</p>
<p class="meta"><span class="tag">searchActors</span><span class="tag">did:web:…:actor:${escapeHtml(n.ns)}-&lt;…&gt;</span></p></div>`,
    )
    .join("\n");
  const entityTotal = ENTITY_TOTAL_COUNT.toLocaleString("en-US");
  const unispscTotal = UNISPSC_TOTAL_COUNT.toLocaleString("en-US");
  const grandTotal = (
    named.length + infra.length + ENTITY_TOTAL_COUNT + UNISPSC_TOTAL_COUNT
  ).toLocaleString("en-US");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Actors · etzhayyim</title>
<meta name="description" content="Actors registered on etzhayyim — each resolves a did:web DID and is kotoba-native.">
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;max-width:52rem;padding:2.5rem 1.25rem;margin-inline:auto}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .25rem}
.sub{opacity:.7;margin:0 0 2rem}
h2{font-size:1.15rem;margin:2.25rem 0 .5rem;border-bottom:1px solid currentColor;padding-bottom:.25rem}
h3{font-size:1.05rem;margin:0 0 .15rem;font-weight:600}
.glyph{font-size:1.2em}
.name{opacity:.85;margin:.1rem 0 .5rem;font-size:.95rem}
.card{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:.6rem;padding:1rem 1.1rem;margin:.75rem 0}
.meta{margin:.6rem 0 .4rem;line-height:2}
.tag{display:inline-block;font-size:.72rem;letter-spacing:.03em;opacity:.7;border:1px solid currentColor;border-radius:1rem;padding:.05rem .55rem;margin:0 .35rem .15rem 0}
.did{margin:.4rem 0 0;font-size:.82rem;opacity:.75}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:color-mix(in srgb,currentColor 10%,transparent);padding:.1rem .35rem;border-radius:.3rem}
footer{margin-top:2.5rem;font-size:.85rem;opacity:.7}
a{color:inherit}
</style>
</head>
<body>
<h1>Actors on etzhayyim</h1>
<p class="sub">Each actor resolves a <code>did:web:etzhayyim.com:actor:&lt;handle&gt;</code> DID and is kotoba-native (state lives in the kotoba Datom log; inference is Murakumo-only). Below is the registry — the same data is machine-readable at <a href="/.well-known/actors.json">/.well-known/actors.json</a>.</p>

<p class="sub"><strong>${grandTotal}</strong> resolvable actors: ${named.length} named + ${infra.length} substrate services + <strong>${entityTotal}</strong> entity mirrors (below) + ${unispscTotal} UNSPSC agents. The named actors are the operators; the entity mirrors are the world they datafy, each given its own DID + profile + searchable presence.</p>

<h2>Knowledge-graph &amp; Tier-B actors</h2>
<p class="sub" id="kotoba-verify" data-enhance="actors-v1" hidden></p>
${namedCards}

<h2>Society-scale entity mirrors · ${entityTotal} <span style="font-weight:400;font-size:.8em;opacity:.7">(ADR-2606042330)</span></h2>
<p class="sub">Every public/power entity a knowledge-graph actor datafies — governments, public companies, submarine cables, landing stations, ships &amp; aircraft — resolves its own <code>did:web:etzhayyim.com:actor:&lt;ns&gt;-&lt;…&gt;</code> <strong>keyless mirror-actor</strong> and is searchable via <code>app.bsky.actor.searchActors</code>. A mirror is etzhayyim's public-fact record of the entity, <strong>never the entity itself, never an official channel, never a target-list</strong>. Natural persons are excluded by construction. Counted by namespace (there are thousands), not listed row-by-row:</p>
${nsRows}

<h2>Substrate service DIDs</h2>
${infraCards}

<footer>
Registry source of truth: <code>50-infra/etzhayyim-did-web/src/registry/infra-actors.ts</code> + generated <code>entity-handles.&lt;ns&gt;.gen.ts</code> · Entity DID: <a href="/.well-known/did.json">did:web:etzhayyim.com</a> · <a href="/donate">Donate</a><br>
Per ADR-2605241800 (single did-web Worker) + ADR-2605212030 + ADR-2606042330 (entity-as-actor) + ADR-2605171300 (UNSPSC). Free-form member/council handles also resolve but are not listed here.
</footer>
<!-- Progressive enhancement: first-party, same-origin, zero-egress ES module
     (CSP connect-src 'self') resolves the named actors + self-verifies each DID
     from the content-addressed /kotoba blocks in the visitor's own browser. The
     page is fully functional without it. Not surveillance (ADR-2606064500). -->
<script type="module" src="/kotoba/actors-enhance.js"></script>
</body>
</html>
`;
}

// `/organism` — visualizes the artificial-organism self-evolution ecosystem:
// the UNSPSC organism fleet + the Kaizen self-evolution loop (observe → propose
// → PR → score → prune) including the meta self-reflection layer (Beta fitness
// from PR outcomes → pruning). Self-contained, Charter-compliant (no external
// resource, no cookie, no tracker; inline SVG + CSS only). ADR-2605240200
// (Kaizen self-reflection) + 2605232345/2605240000 (organism) + 2605270930
// (axes A–H) + the meta-fitness layer (rule fitness = PR-acceptance Beta mean).
function buildOrganismHtml(): string {
  const handles = Object.keys(INFRA_ACTORS);
  const named = handles.filter((h) => INFRA_ACTORS[h].glyph).length;
  const unispsc = UNISPSC_TOTAL_COUNT.toLocaleString("en-US");
  const entity = ENTITY_TOTAL_COUNT.toLocaleString("en-US");

  // Six stages of the self-evolution loop, rendered as a ring of nodes.
  const stages = [
    { k: "観測", e: "OBSERVE", d: "joucho 情緒 5-axis cadence + shard /healthz + queue tails" },
    { k: "分析", e: "ANALYSE", d: "Kaizen rule registry (latency / LRU / error / leak …)" },
    { k: "提案", e: "PROPOSE", d: "KaizenProposal → append-only NDJSON queue" },
    { k: "実行", e: "ACTUATE", d: "pr-agent: patch → commit → push → PR / issue" },
    { k: "採点", e: "SCORE", d: "rule fitness = Beta(α,β) mean of PR acceptance" },
    { k: "剪定", e: "PRUNE", d: "MetaReflector disables low-fitness rules" },
  ];
  const cx = 260, cy = 230, r = 168;
  const nodeSvg = stages
    .map((s, i) => {
      const a = (-90 + i * 60) * (Math.PI / 180);
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
<circle r="34" class="node"/>
<text class="nk" y="-3">${s.k}</text><text class="ne" y="13">${s.e}</text>
</g>`;
    })
    .join("");
  // arrows around the ring
  const arcs = stages
    .map((_, i) => {
      const a0 = (-90 + i * 60) * (Math.PI / 180);
      const a1 = (-90 + (i + 1) * 60) * (Math.PI / 180);
      const x0 = cx + (r - 36) * Math.cos(a0 + 0.28), y0 = cy + (r - 36) * Math.sin(a0 + 0.28);
      const x1 = cx + (r - 36) * Math.cos(a1 - 0.28), y1 = cy + (r - 36) * Math.sin(a1 - 0.28);
      return `<path class="arc" d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r - 36} ${r - 36} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" marker-end="url(#ah)"/>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artificial Organism · etzhayyim 自己進化</title>
<meta name="description" content="etzhayyim の人工オーガニズム自己進化ループ — 観測→提案→PR→採点→剪定 の可視化。">
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;max-width:60rem;padding:2.5rem 1.25rem;margin-inline:auto}
h1{font-size:1.7rem;line-height:1.25;margin:0 0 .25rem}
.sub{opacity:.72;margin:0 0 1.5rem}
h2{font-size:1.15rem;margin:2.5rem 0 .6rem;border-bottom:1px solid currentColor;padding-bottom:.25rem}
.stats{display:flex;flex-wrap:wrap;gap:.6rem;margin:1rem 0 1.5rem}
.stat{flex:1 1 8rem;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:.6rem;padding:.7rem .9rem}
.stat b{display:block;font-size:1.5rem;line-height:1.1}
.stat span{font-size:.8rem;opacity:.7}
.diagram{display:block;margin:0 auto;max-width:100%;height:auto}
.node{fill:color-mix(in srgb,currentColor 8%,transparent);stroke:currentColor;stroke-width:1.4}
.nk{font-size:15px;font-weight:700;text-anchor:middle;fill:currentColor}
.ne{font-size:8.5px;letter-spacing:.08em;text-anchor:middle;fill:currentColor;opacity:.65}
.arc{fill:none;stroke:currentColor;stroke-width:1.6;opacity:.5}
.hub{fill:none;stroke:currentColor;stroke-width:1;opacity:.25;stroke-dasharray:3 4}
.hubt{font-size:11px;text-anchor:middle;fill:currentColor;opacity:.6}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:.7rem;margin:.8rem 0}
.card{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:.6rem;padding:.85rem 1rem}
.card h3{font-size:1rem;margin:0 0 .3rem}
.card p{margin:.2rem 0;font-size:.9rem;opacity:.85}
.axes{display:flex;flex-wrap:wrap;gap:.5rem;margin:.6rem 0}
.axis{border:1px solid currentColor;border-radius:1rem;padding:.1rem .7rem;font-size:.85rem;opacity:.85}
table{border-collapse:collapse;width:100%;font-size:.86rem;margin:.5rem 0}
td,th{border:1px solid color-mix(in srgb,currentColor 20%,transparent);padding:.35rem .55rem;text-align:left}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:color-mix(in srgb,currentColor 10%,transparent);padding:.1rem .35rem;border-radius:.3rem}
.flow{font-size:.92rem;opacity:.9}
.tag{display:inline-block;font-size:.72rem;opacity:.7;border:1px solid currentColor;border-radius:1rem;padding:.05rem .55rem;margin:0 .3rem .15rem 0}
footer{margin-top:2.5rem;font-size:.83rem;opacity:.7}
a{color:inherit}
</style>
</head>
<body>
<h1>人工オーガニズム — 自己進化エコシステム</h1>
<p class="sub">etzhayyim は ~${unispsc} 体の UNSPSC オーガニズムを、情緒(joucho)で駆動する心拍カデンスで動かし、生態系全体を <strong>自己反省ループ</strong>で進化させます。状態は kotoba Datom ログに、推論は Murakumo に。本ページは外部リソース・cookie・トラッカー無しの自己完結可視化です。</p>

<div class="stats">
<div class="stat"><b>${unispsc}</b><span>UNSPSC オーガニズム (個体)</span></div>
<div class="stat"><b>${named}</b><span>Tier-B / KG アクター</span></div>
<div class="stat"><b>${entity}</b><span>society-scale entity ミラー</span></div>
<div class="stat"><b>5</b><span>joucho 情緒軸</span></div>
</div>

<h2>自己進化ループ (Kaizen self-evolution)</h2>
<p class="flow">観測 → 分析 → 提案 → 実行(PR) → 採点 → 剪定 の閉ループ。<strong>採点・剪定</strong>がメタ自己反省層で、PR の受理/却下を学習信号にしてループ自身を評価・剪定します。</p>
<svg class="diagram" viewBox="0 0 520 470" role="img" aria-label="self-evolution loop">
<defs><marker id="ah" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="currentColor" opacity="0.6"/></marker></defs>
<circle class="hub" cx="${cx}" cy="${cy}" r="${r}"/>
<text class="hubt" x="${cx}" y="${cy - 6}">self-evolution</text>
<text class="hubt" x="${cx}" y="${cy + 10}">loop</text>
${arcs}
${nodeSvg}
</svg>

<h2>情緒 (joucho) — 5 軸の心拍カデンス</h2>
<p class="sub">固定タイマーではなく、5 軸の情緒 mood が各個体の行動(投稿/分析/関与/修復)とクールダウンを駆動。</p>
<div class="axes">
<span class="axis">joy 喜</span><span class="axis">calm 静</span><span class="axis">stress 緊 (≥70 で回復モード)</span><span class="axis">gratitude 謝</span><span class="axis">focus 集</span>
</div>

<h2>ライフサイクル (剪定の機構)</h2>
<div class="grid">
<div class="card"><h3>INACTIVE → ACTIVE</h3><p>birth で稼働開始 (cell 発火 = 誕生)。</p></div>
<div class="card"><h3>CLONED</h3><p>負荷分散・複製。親 DID を継承。</p></div>
<div class="card"><h3>RETIRED</h3><p>退役 (reason 付き)。</p></div>
<div class="card"><h3>EXCOMMUNICATED</h3><p>Council 4/7 attestation + chigiri 手続きで破門。</p></div>
</div>

<h2>メタ自己反省 — 採点 &amp; 剪定</h2>
<table>
<tr><th>メタ能力</th><th>仕組み</th></tr>
<tr><td>採点 (score)</td><td>各ルールの fitness = PR 受理の <code>Beta(α,β)</code> 事後平均 (merge=accept / close=reject)</td></tr>
<tr><td>能動推論 (active inference)</td><td>PR 結果を観測 → Beta 信念更新 → policy(剪定) の閉ループ</td></tr>
<tr><td>剪定 (prune)</td><td>fitness が閾値未満のルールを <code>MetaReflector</code> が無効化 → observer が emit 停止 + LRU warm-set eviction</td></tr>
</table>

<h2>フリート常駐 (Murakumo Mac mini fleet)</h2>
<div class="grid">
<div class="card"><h3><span class="tag">levi/naphtali</span> kaizen-observer</h3><p>10 分カデンスで観測→提案を NDJSON キューへ。</p></div>
<div class="card"><h3><span class="tag">同居</span> kaizen-pr-agent</h3><p>キューを drain → PR/issue を開き、PR 結果を fitness 台帳へ。</p></div>
<div class="card"><h3><span class="tag">joseph/issachar/dan</span> organism shards</h3><p>~${unispsc} 個体を心拍で tick (DaemonSet)。</p></div>
</div>

<footer>
自己進化ループ実装: <code>40-engine/kotoba/crates/kotoba-kotodama/py/src/kotodama/organism/</code> (kaizen / fitness / lifecycle / joucho)<br>
ADR-2605240200 (Kaizen self-reflection) + 2605232345 / 2605240000 (organism) + 2605270930 (axes A–H) · アクター一覧: <a href="/actors">/actors</a> · Entity DID: <a href="/.well-known/did.json">did:web:etzhayyim.com</a><br>
観測者 DID: <code>did:web:etzhayyim.com:actor:kaizen-observer</code> · 状態は kotoba Datom ログ (canonical) · 推論は Murakumo-only (ADR-2605215000)。
</footer>
</body>
</html>
`;
}

// Service binding name — populated from wrangler.toml [[services]] block.
interface Env {
  YORO: Fetcher;
  // Substrate-side XRPC adapter (rw-free reference impl). Service binding
  // to `yoro-xrpc-adapter` — bypasses the public HTTP hop and CF Bot
  // Management. Per ADR-2605172000: reads MUST resolve through MST/IPFS/L2,
  // never through the etzhayyim.com PDS+AppView+RisingWave chain.
  YORO_XRPC?: Fetcher;
  // Phase α P1 (ADR-2605212030): chain config for per-actor DID resolution.
  // Set in wrangler.toml [vars] once EtzhayyimAuthz is deployed to Base Sepolia.
  AUTHZ_CONTRACT_ADDRESS?: string;
  BASE_RPC_URL?: string;
  CHAIN_ID?: string;
  // Actor-profile dynamic issuance (ADR-2606013800). KV holds materialized
  // ActorRecord JSON per actor (`actor:<handle>`), refreshed by the publisher
  // from the kotoba `actors-v1` graph. KOTOBA_ENDPOINT is the best-effort pull
  // fallback when KV misses. Both optional — absent → compiled INFRA_ACTORS
  // fallback keeps did:web resolution live.
  ACTOR_KV?: KVNamespace;
  // Operator oversight key (base64 32 bytes) for encrypting published-edit IP
  // attestations. Optional — absent → pseudonymous hash only (see kotoba-publish).
  KOTOBA_ATTEST_KEY?: string;
  KOTOBA_ENDPOINT?: string;
  // Same-origin account publish (ADR-2606061800). When set, the verify-only
  // `registerAccount` relay writes the member's handle↔did:key alias + profile
  // to the kotoba node here. Absent → the relay reports `gated` (honest R0): the
  // member is still authenticated locally, the account just isn't published yet.
  KOTOBA_WRITE_ENDPOINT?: string;
  // The kotoba node's `operator_did` — the REQUIRED CACAO `aud` for member
  // account writes (ADR-2606061800). The frontend fetches it from the config GET
  // below so the kotoba-write CACAO binds to the node; the node enforces an exact
  // aud match. Keychain-stable, so it survives node restarts.
  KOTOBA_OPERATOR_DID?: string;
  // Trustless IPFS gateway (ADR-2606014600). Comma-separated upstream gateway
  // templates; `{cid}` is substituted, else `<gw>/ipfs/<cid>` is used. Fetched
  // bytes are CID-verified before serving, so these are UNTRUSTED upstreams.
  IPFS_GATEWAYS?: string;
  // Per-NSID-family XRPC upstream origins (populated from wrangler.toml [vars]).
  // New actors are added here, NOT as new subdomains — this Worker is the
  // single etzhayyim.com endpoint per ADR-2605212030 §D2.
  XRPC_UNISPSC_UPSTREAM?: string;
  // AT Protocol / Bluesky stack — apex etzhayyim.com/xrpc/* proxy targets
  // for the yoro frontend (which currently embeds relative `/xrpc/...` paths).
  XRPC_BSKY_UPSTREAM?: string;
  XRPC_ATPROTO_UPSTREAM?: string;
  XRPC_CHAT_UPSTREAM?: string;
  XRPC_etzhayyim_UPSTREAM?: string;
  // kotoba graph query/MV surface (com.etzhayyim.apps.kotoba.* / .kotobase.*) →
  // the kotoba node behind the cloudflared tunnel. Read-only proxy; the client's
  // CACAO / Authorization passes through unchanged (no server key injected).
  XRPC_KOTOBA_UPSTREAM?: string;
}

// ─── Substrate NSID alias map ──────────────────────────────────────────
//
// Per ADR-2605172000, app.bsky.* read NSIDs MUST resolve through the
// MST/IPFS/L2 substrate via `yoro-xrpc-adapter` (which exposes the
// rw-free reference impl under the `com.etzhayyim.yoro.*` NSID family). The
// yoro frontend still sends the standard `app.bsky.*` NSIDs unchanged;
// this Worker rewrites them to the substrate-side equivalent before
// dispatching through the service binding.
//
// Reads enumerated here SHORT-CIRCUIT the etzhayyim.com PDS proxy below.
// Writes (createRecord, like, repost, follow, etc.) still flow through
// the legacy path until the rw-free write path lands — they are not in
// this map.
const SUBSTRATE_NSID_ALIASES: Record<string, string> = {
  // NOTE: the feed/profile read NSIDs (getTimeline / getDiscoverFeed /
  // getAuthorFeed / getPostThread / actor.getProfile) were previously aliased
  // to com.etzhayyim.yoro.* and forwarded to yoro-xrpc-adapter, which does NOT
  // implement them (404 MethodNotFound) — that is why etzhayyim.com showed no
  // posts. They are now served browser-locally by kotoba-sw.js from the kotoba
  // Datom log; when the Service Worker is inactive/misses, these requests fall
  // through here to the standard app.bsky.* → AppView route (XRPC_ATPROTO_UPSTREAM,
  // GET→POST normalized) which returns real data. So they are intentionally NOT
  // aliased anymore — removing the dead 404 path AND giving a working
  // server-side fallback. (ADR-2605312345 / 2606013800.)
  "app.bsky.actor.searchActors":   "com.etzhayyim.yoro.actor.searchActors",
  "app.bsky.graph.getFollowers":   "com.etzhayyim.yoro.graph.getFollowers",
  "app.bsky.graph.getFollows":     "com.etzhayyim.yoro.graph.getFollows",
};

// Identity-passthrough prefixes that route to YORO_XRPC unchanged. Used for
// NSID families already in their canonical rw-free shape (no app.bsky.* →
// com.etzhayyim.yoro.* rewrite needed). The xrpc-adapter exposes these directly.
const SUBSTRATE_PASSTHROUGH_PREFIXES: readonly string[] = [
  "com.etzhayyim.apps.unispsc.",
];

// ─── XRPC routing ───────────────────────────────────────────────────────
//
// All `/xrpc/{NSID}` requests are routed by NSID *prefix* to the upstream
// declared in env. Keeping this as a static map (rather than a generic
// "look up the NSID owner" call) means the Worker stays a single fetch hop
// and a misconfigured upstream is a deploy-time error, not a runtime one.

interface NsidRoute {
  prefix: string;
  upstream: keyof Env; // must point to a string-valued Env field
}

const XRPC_ROUTES: NsidRoute[] = [
  { prefix: "com.etzhayyim.apps.unispsc.", upstream: "XRPC_UNISPSC_UPSTREAM" },
  // AT Protocol / Bluesky read+write (PDS handles both write paths and
  // pipethrough to AppView for reads). yoro frontend sends app.bsky.feed.*,
  // app.bsky.actor.*, app.bsky.graph.*, com.atproto.* via these routes.
  { prefix: "app.bsky.",             upstream: "XRPC_ATPROTO_UPSTREAM" },
  { prefix: "com.atproto.",          upstream: "XRPC_ATPROTO_UPSTREAM" },
  { prefix: "chat.bsky.",            upstream: "XRPC_CHAT_UPSTREAM" },
  // kotoba graph query / SPARQL / MaterializedView surface → the kotoba node
  // (more specific than the com.etzhayyim. catch-all below, so it must come
  // first — findXrpcRoute returns the first matching prefix).
  { prefix: "com.etzhayyim.apps.kotoba.",   upstream: "XRPC_KOTOBA_UPSTREAM" },
  { prefix: "com.etzhayyim.apps.kotobase.", upstream: "XRPC_KOTOBA_UPSTREAM" },
  // etzhayyim platform extensions (convo, signal, kagami, projector, mcp, rtc).
  { prefix: "com.etzhayyim.",              upstream: "XRPC_etzhayyim_UPSTREAM" },
];

function findXrpcRoute(nsid: string): NsidRoute | null {
  for (const r of XRPC_ROUTES) {
    if (nsid.startsWith(r.prefix)) return r;
  }
  return null;
}

async function proxyXrpc(
  request: Request,
  upstream: string,
  nsid: string,
): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(upstream);
  // Preserve the canonical XRPC path so the upstream sees the same NSID.
  target.pathname = `/xrpc/${nsid}`;
  target.search = incoming.search;

  // GET → POST normalization: the upstream PDS / AppView dispatcher serves
  // every NSID (query and procedure) as POST + JSON body. AT Protocol clients
  // (yoro included) send queries as GET with URL params. Convert the request
  // so the upstream sees a uniform POST shape; query params become the JSON
  // body, preserving the search string in the URL for any handler that still
  // inspects it.
  const isReadMethod = request.method === "GET" || request.method === "HEAD";
  let outboundMethod = request.method;
  let outboundBody: BodyInit | undefined = request.body ?? undefined;
  const fwd = new Headers(request.headers);
  if (isReadMethod) {
    const params: Record<string, unknown> = {};
    for (const [k, v] of incoming.searchParams.entries()) {
      const existing = params[k];
      if (existing === undefined) {
        params[k] = v;
      } else if (Array.isArray(existing)) {
        existing.push(v);
      } else {
        params[k] = [existing, v];
      }
    }
    outboundMethod = "POST";
    outboundBody = JSON.stringify(params);
    fwd.set("content-type", "application/json");
    // content-length will be set by fetch from the new body; remove any stale value.
    fwd.delete("content-length");
  }
  stripIncomingCookies(fwd);
  fwd.set("x-forwarded-host", "etzhayyim.com");
  fwd.set("x-forwarded-proto", "https");
  fwd.set("x-forwarded-method", request.method);
  fwd.set("x-etzhayyim-nsid", nsid);

  try {
    const upstreamResp = await fetch(target.toString(), {
      method: outboundMethod,
      headers: fwd,
      body:
        outboundMethod === "GET" || outboundMethod === "HEAD"
          ? undefined
          : outboundBody,
      redirect: "manual",
    });
    const respHeaders = new Headers(upstreamResp.headers);
    for (const h of STRIPPED_RESPONSE_HEADERS) respHeaders.delete(h);
    respHeaders.set("x-proxied-by", "etzhayyim-did-web");
    respHeaders.set("x-proxied-upstream", upstream);
    respHeaders.set("x-etzhayyim-no-cookie", "1");
    applyApexSecurityHeaders(respHeaders, target.pathname);
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "UpstreamUnreachable",
        message:
          err instanceof Error ? err.message : "xrpc upstream fetch failed",
        nsid,
      }),
      {
        status: 502,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-proxied-by": "etzhayyim-did-web",
        },
      },
    );
  }
}

// ─── Per-actor DID Document ─────────────────────────────────────────────

// W3C-compliant handle: lowercase alnum + hyphen, 1-63 chars, no leading/
// trailing hyphen. Matches DNS label rules (so the subdomain form
// `<handle>.etzhayyim.com` is also a valid DNS name).
const HANDLE_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Namespaced handles MUST exist in a known registry. unispsc actors are
// `c\d{6,12}` per the unispsc_agents/c{code}.py filename convention.
// Other namespaces (e.g. ISIC, future taxonomies) get their own regex +
// registry entry as they come online.
const UNISPSC_HANDLE_SHAPE = /^c\d{6,12}$/;

function isNamespacedHandle(handle: string): boolean {
  return UNISPSC_HANDLE_SHAPE.test(handle) || isEntityHandleShape(handle);
}

function isKnownHandle(handle: string): boolean {
  if (UNISPSC_HANDLE_SHAPE.test(handle)) return UNISPSC_HANDLES.has(handle);
  // Entity-as-actor mirror registries (ADR-2606042330): a namespaced entity
  // handle (gov-/corp-/cable-/station-/craft-) resolves iff registered.
  if (isEntityHandleShape(handle)) return isEntityHandle(handle);
  // Infra-actor registry — collapses the 8 per-actor Workers (pinner /
  // esign / audit / dataset-pinner / pds / anchorer / projector /
  // karute) to a single path-based DID Doc surface. Per ADR-2605241800
  // §Phase A.
  if (INFRA_ACTOR_HANDLES.has(handle)) return true;
  // Free-form handles (not yet in a registry) are permitted during Phase α
  // so council seats / human members can resolve without a registry round-trip.
  return true;
}

function buildPerActorDidDoc(handle: string, env: Env): Record<string, unknown> {
  const pathBasedDid = `did:web:etzhayyim.com:actor:${handle}`;
  const subdomainDid = `did:web:${handle}.etzhayyim.com`;
  const alsoKnownAs: string[] = [subdomainDid];
  const registered = isNamespacedHandle(handle);
  const infraActor = getInfraActor(handle);

  // When chain integration lands, embed the did:erc725:base form by reading
  // EtzhayyimAuthz.resolveDwebHandle(keccak256("<handle>.etzhayyim.com")).
  // For the scaffold we expose the planned format with a placeholder rootId.
  if (env.AUTHZ_CONTRACT_ADDRESS) {
    alsoKnownAs.push(
      `did:erc725:base:${env.AUTHZ_CONTRACT_ADDRESS}#__rootId-pending-chain-lookup__`,
    );
  }

  // Default service[] (Phase α P1 — chain lookup placeholder). Infra
  // actors override this entirely with their declared service set
  // (PDS endpoint, libp2p Multiaddr, HTTPS legacy fallback).
  const defaultService: Record<string, unknown>[] = [
    {
      id: `${pathBasedDid}#etzhayyim-authz`,
      type: "EtzhayyimAuthzResolver",
      serviceEndpoint: env.AUTHZ_CONTRACT_ADDRESS
        ? `https://authz.etzhayyim.com/xrpc/org.etzhayyim.authz.resolveRoot?dwebHandle=${encodeURIComponent(handle)}.etzhayyim.com`
        : null,
    },
  ];
  const service = infraActor
    ? (infraActor.service as Record<string, unknown>[])
    : defaultService;

  const adrs = infraActor
    ? ["2605212030", "2605241800", ...infraActor.adrs]
    : ["2605212030", "2605171800"];

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/jws-2020/v1",
    ],
    id: pathBasedDid,
    alsoKnownAs,
    // verificationMethod, authentication, etc. populated from on-chain Root.activeKey
    // when chain integration lands. Phase α P1 scaffold returns an empty array
    // so the document validates against W3C DID Core minimal requirements.
    verificationMethod: [],
    service,
    _meta: {
      adr: adrs,
      phase: infraActor ? "Phase A (infra-actor)" : "α P1 scaffold",
      kind: infraActor ? "infra-actor" : registered ? "unispsc-actor" : "free-form",
      description: infraActor?.description,
      primaryLexicon: infraActor?.primaryLexicon,
      primarySchema: infraActor?.primarySchema,
      registry: registered
        ? {
            lexicon: "com.etzhayyim.apps.unispsc",
            generatedAt: UNISPSC_GENERATED_AT,
            totalCount: UNISPSC_TOTAL_COUNT,
          }
        : null,
      note: env.AUTHZ_CONTRACT_ADDRESS
        ? "rootId placeholder in alsoKnownAs[1] is pending on-chain lookup wiring"
        : "AUTHZ_CONTRACT_ADDRESS not configured; alsoKnownAs[did:erc725:base] omitted",
    },
  };
}

// ─── Actor record resolution (ADR-2606013800) ─────────────────────────────
//
// 3-tier, fail-open. KV (publisher-materialized from kotoba) → kotoba pull →
// compiled INFRA_ACTORS. Returns null only for handles that are not registered
// actors at all (free-form member/council handles), in which case the caller
// falls back to buildPerActorDidDoc.
async function resolveActorRecord(
  handle: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<ActorRecord | null> {
  // Entity-as-actor mirror tier (ADR-2606042330): a registered entity handle
  // resolves a keyless mirror record directly from the generated registries.
  // No KV/kotoba round-trip needed at R0 (live kotoba enrichment is G8-gated);
  // returned before the on-chain vm enrichment since mirrors are key-less (G5).
  if (isEntityHandle(handle)) return entityActorRecord(handle);
  const rec = await resolveActorRecordTiered(handle, env, ctx);
  if (!rec) return null;
  // verificationMethod is a MIRROR of the on-chain ERC725 active key, never
  // server-minted (ADR-2605231525). Gated + best-effort: enrich only when both
  // chain env vars are set and the record has no vm yet (ADR-2606015200).
  if (env.AUTHZ_CONTRACT_ADDRESS && env.BASE_RPC_URL && rec.vm.length === 0) {
    const vm = await fetchOnChainVm(env, handle, rec.did);
    if (vm.length) return { ...rec, vm: vm as unknown as ActorRecord["vm"] };
  }
  return rec;
}

async function resolveActorRecordTiered(
  handle: string,
  env: Env,
  _ctx: ExecutionContext,
): Promise<ActorRecord | null> {
  // Actor resolution is content-addressed and worker-independent (step 3): the
  // 28 named actors' did.json + profile.json are STATIC files under
  // public/actor/<h>/, which Cloudflare serves from the edge BEFORE this Worker
  // ever runs (their bytes are the canonical kotoba-datomic DID docs, CID in the
  // actors-v1 Datom log; the browser ActorResolver re-verifies them). So this
  // dynamic path is reached only for entity-actors, human members, and the
  // XRPC getProfile query surface. No CF KV, no ACTORS_V1_RECORDS shim.
  //   1) (empty-by-default) kotoba node pull,
  //   2) compiled INFRA_ACTORS mirror, so registered handles never go dark.
  // ACTOR_KV remains bound ONLY for the gov-atlas index, not for actor records.
  const fromKotoba = await fetchKotobaActorRecord(env, handle);
  if (fromKotoba) return fromKotoba;

  // compiled fallback — INFRA_ACTORS (null for non-registered handles).
  return compiledActorRecord(handle);
}

// Content-addressed → immutable; cache hard. `x-etzhayyim-cid-verified` proves
// the bytes were re-hashed against the CID before serving (trustless).
function ipfsHeaders(
  cid: string,
  len: number,
  contentType: string,
): Record<string, string> {
  return {
    "content-type": contentType,
    "content-length": String(len),
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "x-etzhayyim-cid": cid,
    "x-etzhayyim-cid-verified": "sha256",
    "x-etzhayyim-no-cookie": "1",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
  };
}

// Minimal content-type sniff: WASM magic `\0asm`, else octet-stream.
function detectCt(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d) {
    return "application/wasm";
  }
  return "application/octet-stream";
}

const ACTOR_JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=60, must-revalidate",
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-etzhayyim-no-cookie": "1",
};

// Headers we strip from the upstream response. `set-cookie` is dropped because
// etzhayyim.com is a cookie-free zone by constitutional design — see
// /CHARTER-RIDER.md §2(c) (no surveillance / trackers) + ADR-2605172000
// (RW-free substrate, identity = DID + WebAuthn, not cookies).
const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "alt-svc",
]);

// Outgoing-request headers to strip. `cookie` dropped so upstream never sees
// browser cookies that leaked in from a sibling subdomain.
const STRIPPED_REQUEST_HEADERS = ["cookie", "host"] as const;

const PERMISSIONS_POLICY = "interest-cohort=(), browsing-topics=()";

// `"cookies"` only — we don't wipe localStorage / OPFS / IndexedDB that the
// yoro SPA depends on.
const CLEAR_COOKIE_PATHS = new Set(["/", "/privacy"]);

function applyApexSecurityHeaders(headers: Headers, pathname: string): void {
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("permissions-policy", PERMISSIONS_POLICY);
  if (CLEAR_COOKIE_PATHS.has(pathname)) {
    headers.set("clear-site-data", '"cookies"');
  }
}

function stripIncomingCookies(headers: Headers): void {
  for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);
}

function buildUpstreamRequest(request: Request): Request {
  const upstreamUrl = new URL(request.url);
  upstreamUrl.hostname = UPSTREAM_HOST;
  upstreamUrl.protocol = "https:";
  upstreamUrl.port = "";

  const fwdHeaders = new Headers(request.headers);
  stripIncomingCookies(fwdHeaders);
  fwdHeaders.set("x-forwarded-host", "etzhayyim.com");
  fwdHeaders.set("x-forwarded-proto", "https");

  return new Request(upstreamUrl.toString(), {
    method: request.method,
    headers: fwdHeaders,
    body: request.body,
    redirect: "manual",
  });
}

function rewriteUpstreamResponse(upstream: Response, pathname: string): Response {
  const headers = new Headers(upstream.headers);
  for (const h of STRIPPED_RESPONSE_HEADERS) headers.delete(h);

  applyApexSecurityHeaders(headers, pathname);

  headers.set("x-proxied-by", "etzhayyim-did-web");
  headers.set("x-proxied-upstream", UPSTREAM_HOST);
  headers.set("x-etzhayyim-no-cookie", "1");

  const loc = headers.get("location");
  if (loc) {
    try {
      const locUrl = new URL(loc, `https://${UPSTREAM_HOST}/`);
      if (locUrl.hostname === UPSTREAM_HOST) {
        locUrl.hostname = "etzhayyim.com";
        headers.set("location", locUrl.toString());
      }
    } catch {
      /* relative or malformed — leave alone */
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // ──────────────────────────────────────────────────────────────────
    // 1) Entity DID Document — local, no upstream call.
    // ──────────────────────────────────────────────────────────────────
    if (url.pathname === "/.well-known/did.json") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(JSON.stringify(didDoc, null, 2) + "\n", {
        status: 200,
        headers: {
          "content-type": "application/did+json; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }

    // ──────────────────────────────────────────────────────────────────
    // 1b) Donation declaration (ADR-2606012100) — served locally, cookie-
    //     free, no upstream call. `/donate` = human page; the machine
    //     policy lives at `/.well-known/donation.json`. Both state that
    //     etzhayyim is donation-funded and describe cash + in-kind compute
    //     (ameno / e7m / kotoba) giving. GET/HEAD only.
    // ──────────────────────────────────────────────────────────────────
    if (url.pathname === "/.well-known/donation.json") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(JSON.stringify(DONATION_POLICY, null, 2) + "\n", {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }
    if (url.pathname === "/donate" || url.pathname === "/donate/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(DONATE_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "x-content-type-options": "nosniff",
          // No external resource, no inline script, no cookie (Charter Rider §2(c)).
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }

    // ──────────────────────────────────────────────────────────────────
    // 1c) Actor registry index — `/actors` (human HTML) +
    //     `/.well-known/actors.json` (machine). Served locally, cookie-free,
    //     no upstream call. INFRA_ACTORS is the single source of truth, so
    //     this list updates whenever an actor is registered. GET/HEAD only.
    // ──────────────────────────────────────────────────────────────────
    if (url.pathname === "/.well-known/actors.json") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(JSON.stringify(await buildActorsJsonWithCids(env), null, 2) + "\n", {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }
    // gov-atlas machine-readable index — `/.well-known/gov-units.json`.
    // Served from ACTOR_KV (`gov-atlas:index`), generated offline by
    // scripts/gen-gov-atlas-index.mjs from the ooyake seeds + the
    // etzhayyim-project-states real-named municipality dataset (synthetic tiers
    // excluded, G5). Observational mirror + civic wayfinding, never a target-list
    // (G3/G10). Per ADR-2606021600. GET/HEAD only.
    if (url.pathname === "/.well-known/gov-units.json") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      let body = '{"error":"gov-atlas index not provisioned (run gen-gov-atlas-index + kv put gov-atlas:index)"}';
      let status = 503;
      if (env.ACTOR_KV) {
        const raw = await env.ACTOR_KV.get("gov-atlas:index");
        if (raw) {
          body = raw;
          status = 200;
        }
      }
      return new Response(body + "\n", {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }
    // Government PROCEDURES index — `/.well-known/gov-procedures.json`.
    // Public administrative procedures published FINELY BY ADMINISTRATIVE UNIT:
    // each procedure is grouped under its owning gov entity-actor handle
    // (did:web:etzhayyim.com:actor:gov-<...>). Compiled into the Worker from the
    // ooyake :gov.procedure registry (no KV needed; small index). OBSERVATIONAL
    // MIRROR — where/how a public procedure is done; never the government, never
    // an official channel, never filing on anyone's behalf (that is toritsugi,
    // gated). Every row carries sourcing + verification-status; all are
    // :representative / :unverified-seed (G5). Per ADR-2606021600 / 2606042330.
    if (url.pathname === "/.well-known/gov-procedures.json") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      const body = {
        graph: "actors-v1",
        adr: ["2606021600", "2606042330"],
        note: "Observational mirror: public administrative procedures grouped by owning gov entity-actor handle. NOT the government, NOT an official channel, never filed on anyone's behalf (→ toritsugi, gated). All rows :representative / :unverified-seed (G5).",
        generatedAt: GOV_PROCEDURES_GENERATED_AT,
        count: GOV_PROCEDURES_TOTAL,
        owners: GOV_PROCEDURES_OWNER_COUNT,
        jurisdictions: GOV_PROCEDURES_JURISDICTION_COUNT,
        procedures: GOV_PROCEDURE_LIST,
      };
      return new Response(JSON.stringify(body) + "\n", {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }
    // gov-atlas human search page — `/gov`. Browser-native: fetches
    // /.well-known/gov-units.json and filters client-side (no per-keystroke server
    // call, cookie-free, same-origin only). Civic wayfinding over the world
    // government atlas; observational mirror, never a target-list (G3/G10).
    // Per ADR-2606021600. GET/HEAD only.
    if (url.pathname === "/gov" || url.pathname === "/gov/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      const govHtml = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>公 ooyake — World Government Atlas</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 system-ui,sans-serif;max-width:920px;margin:0 auto;padding:1.2rem}
h1{font-size:1.4rem;margin:.2rem 0}.sub{opacity:.7;font-size:.9rem;margin:.2rem 0 1rem}
#q{width:100%;padding:.6rem .8rem;font-size:1rem;border:1px solid #8888;border-radius:.5rem;box-sizing:border-box}
.row{display:flex;gap:.5rem;flex-wrap:wrap;margin:.5rem 0}
select{padding:.4rem;border:1px solid #8888;border-radius:.4rem}
#stats{opacity:.7;font-size:.85rem;margin:.6rem 0}
ul{list-style:none;padding:0;margin:0}
li{padding:.5rem .2rem;border-bottom:1px solid #8882;display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap}
.nm{font-weight:600}.en{opacity:.6}.ro{opacity:.55;font-style:italic;font-size:.9em}.lv{font-size:.75rem;opacity:.8;border:1px solid #8886;border-radius:.5rem;padding:0 .4rem}
.au{color:#1a7f37;border-color:#1a7f3766}.re{opacity:.55}
a{color:inherit}
</style></head><body>
<h1>公 — World Government Atlas</h1>
<p class="sub">An observational <strong>mirror</strong> + civic wayfinding map of the world's government units — never the government, never an official channel, never a target-list (ADR-2606021600). Data: <a href="/.well-known/gov-units.json">/.well-known/gov-units.json</a>. <a href="/actors">/actors</a></p>
<input id="q" placeholder="search by name, endonym, romanization or id… (try: 国会, Kokkai, Verkhovna, Knesset, 札幌市)" autocomplete="off">
<div class="row">
<select id="lvl"><option value="">all levels</option></select>
<select id="src"><option value="">all sourcing</option><option value="authoritative">authoritative</option><option value="representative">representative</option></select>
</div>
<div id="stats">loading…</div>
<ul id="out"></ul>
<script>
(async()=>{
 const d=await (await fetch('/.well-known/gov-units.json')).json();
 const U=d.units||[];
 const q=document.getElementById('q'),lvl=document.getElementById('lvl'),src=document.getElementById('src'),out=document.getElementById('out'),stats=document.getElementById('stats');
 for(const l of Object.keys(d.byLevel||{}).sort()){const o=document.createElement('option');o.value=l;o.textContent=l+' ('+d.byLevel[l]+')';lvl.appendChild(o);}
 const esc=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
 function render(){
  const t=q.value.trim().toLowerCase(),fl=lvl.value,fs=src.value;
  const r=U.filter(u=>(!fl||u.level===fl)&&(!fs||u.sourcing===fs)&&(!t||(u.name||'').toLowerCase().includes(t)||(u.nameEn||'').toLowerCase().includes(t)||(u.nameRomanized||'').toLowerCase().includes(t)||(u.id||'').toLowerCase().includes(t)||(u.jurisdiction||'').toLowerCase().includes(t))).slice(0,300);
  stats.textContent=r.length+' shown · '+d.count+' units / '+d.countries+' jurisdictions · '+(d.withNameLocal||0)+' endonyms · '+(d.withCoords||0)+' located';
  const geo=u=>(typeof u.lat==='number'&&typeof u.lon==='number')?' · <a href="geo:'+u.lat+','+u.lon+'" rel="noopener">map</a>':'';
  out.innerHTML=r.map(u=>'<li><span class="nm">'+esc(u.name)+'</span>'+(u.nameRomanized&&u.nameRomanized!==u.name?' <span class="ro">'+esc(u.nameRomanized)+'</span>':'')+(u.nameEn&&u.nameEn!==u.name?' <span class="en">'+esc(u.nameEn)+'</span>':'')+' <span class="lv">'+esc(u.level)+'</span> <span class="lv '+(u.sourcing==='authoritative'?'au':'re')+'">'+esc(u.sourcing)+'</span> <span class="en">'+esc(u.jurisdiction)+'</span>'+(u.url?' · <a href="'+esc(u.url)+'" rel="noopener noreferrer nofollow">site</a>':'')+geo(u)+'</li>').join('');
 }
 q.oninput=lvl.onchange=src.onchange=render;render();
})();
</script></body></html>`;
      return new Response(govHtml, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }
    if (url.pathname === "/actors" || url.pathname === "/actors/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(buildActorsHtml(), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "x-content-type-options": "nosniff",
          // Charter Rider §2(c) prohibits the SURVEILLANCE-CAPITALISM business
          // model (third-party data collection / brokerage / trackers / cookies),
          // not scripting — §2(c) is a Layer-B derived doctrine and the CSP is its
          // Layer-C implementation (ADR-2606064500). This CSP enforces the value
          // technically: `connect-src 'self'` makes any third-party beacon/tracker
          // structurally impossible, while `script-src 'self' 'wasm-unsafe-eval'`
          // permits ONLY first-party same-origin code (the ActorResolver lib
          // resolving content-addressed /kotoba blocks in the visitor's own
          // browser). No external resource, no inline, no cookie. First-party
          // local resolution is not surveillance.
          "content-security-policy":
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }

    // `/organism` — artificial-organism self-evolution visualization. Inline SVG
    // + CSS only (no script, no external resource, no cookie) per Charter Rider
    // §2(c). Strict CSP: default-src 'none'; style-src 'unsafe-inline' (SVG +
    // inline <style>); img-src 'self' data:.
    if (url.pathname === "/organism" || url.pathname === "/organism/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(buildOrganismHtml(), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }

    // ──────────────────────────────────────────────────────────────────
    // kotoba wasm assets — serve through Worker to ensure HSTS headers
    // (Issue #1561). These were previously served via [assets] binding
    // from public/kotoba/ which bypassed the Worker and missed security headers.
    // ──────────────────────────────────────────────────────────────────
    if (url.pathname === "/kotoba/kotoba_wasm.js") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(kotobaWasmJs, {
        status: 200,
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }
    if (url.pathname === "/kotoba/kotoba_wasm_bg.wasm") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(kotobaWasmBg, {
        status: 200,
        headers: {
          "content-type": "application/wasm",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
        },
      });
    }

    // ──────────────────────────────────────────────────────────────────
    // 2) Per-actor DID Document — `/actor/<handle>/did.json`.
    //    W3C: did:web:etzhayyim.com:actor:<handle>
    //    See buildPerActorDidDoc for the document shape (Phase α P1).
    // ──────────────────────────────────────────────────────────────────
    {
      const m = url.pathname.match(/^\/actor\/([^/]+)\/did\.json$/);
      if (m) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        const handle = decodeURIComponent(m[1]).toLowerCase();
        if (!HANDLE_REGEX.test(handle)) {
          return new Response(
            JSON.stringify({ error: "HandleInvalid", message: "handle must be 1-63 chars, lowercase alnum + hyphen, no leading/trailing hyphen" }),
            { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
          );
        }
        if (!isKnownHandle(handle)) {
          return new Response(
            JSON.stringify({
              error: "HandleNotInRegistry",
              message: `handle '${handle}' matches a namespaced registry shape but is not registered`,
              registry: "com.etzhayyim.apps.unispsc",
              registryTotalCount: UNISPSC_TOTAL_COUNT,
            }),
            {
              status: 404,
              headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "public, max-age=60, must-revalidate",
              },
            },
          );
        }
        // Dynamic issuance (ADR-2606013800): resolve the canonical ActorRecord
        // (KV → kotoba → compiled) and map it to the DID doc. Free-form handles
        // (not registered actors) get null → legacy buildPerActorDidDoc scaffold.
        const rec = await resolveActorRecord(handle, env, ctx);
        const doc = rec ? toDidDoc(rec, env) : buildPerActorDidDoc(handle, env);
        // Advertise the content-addressed (canonical) DID-doc CID so a client can
        // ALSO retrieve + verify this document from any IPFS gateway, not just
        // over TLS (ADR-2606015400). The CID is NOT embedded in the doc (that
        // would be circular); it rides on a header + a `Link: …/ipfs/<cid>`.
        const ddCid = rec ? await didDocCid(rec, env) : null;
        const ddHeaders: Record<string, string> = {
          "content-type": "application/did+json; charset=utf-8",
          // Shorter cache window than the entity doc; per-actor state can
          // change (key rotation, deactivation) and we want quicker invalidation.
          "cache-control": "public, max-age=60, must-revalidate",
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "permissions-policy": PERMISSIONS_POLICY,
          "x-etzhayyim-no-cookie": "1",
          "x-etzhayyim-actor-source": rec?.source ?? "scaffold",
        };
        if (ddCid) {
          ddHeaders["x-etzhayyim-did-doc-cid"] = ddCid;
          ddHeaders["link"] = `<https://etzhayyim.com/ipfs/${ddCid}>; rel="canonical"; type="application/did+json"`;
        }
        return new Response(JSON.stringify(doc, null, 2) + "\n", {
          status: 200,
          headers: ddHeaders,
        });
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 2b) Per-actor profile (REST) — `/actor/<handle>/profile.json`.
    //     app.bsky.actor.getProfile view for the actor, same ActorRecord
    //     source as the DID doc. Convenience surface for curl / clients that
    //     prefer REST over XRPC. Per ADR-2606013800.
    // ──────────────────────────────────────────────────────────────────
    {
      const m = url.pathname.match(/^\/actor\/([^/]+)\/profile\.json$/);
      if (m) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        const handle = decodeURIComponent(m[1]).toLowerCase();
        if (!HANDLE_REGEX.test(handle)) {
          return new Response(
            JSON.stringify({ error: "HandleInvalid" }),
            { status: 400, headers: ACTOR_JSON_HEADERS },
          );
        }
        const rec = await resolveActorRecord(handle, env, ctx);
        if (!rec) {
          return new Response(
            JSON.stringify({
              error: "ProfileNotFound",
              message: `'${handle}' is not a registered actor; profiles for free-form handles resolve via the PDS, not the actor registry`,
            }),
            { status: 404, headers: ACTOR_JSON_HEADERS },
          );
        }
        return new Response(JSON.stringify(toGetProfileView(rec), null, 2) + "\n", {
          status: 200,
          headers: { ...ACTOR_JSON_HEADERS, "x-etzhayyim-actor-source": rec.source },
        });
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 2b') Per-administrative-unit PROCEDURES — `/actor/<handle>/procedures.json`.
    //     The public procedures (passport / national-id / tax / business / …)
    //     done at this gov entity-actor's unit, from the compiled ooyake
    //     :gov.procedure registry. Observational mirror: where/how, never the
    //     government, never filed on anyone's behalf (→ toritsugi, gated).
    //     Per ADR-2606021600 / 2606042330. GET/HEAD only.
    // ──────────────────────────────────────────────────────────────────
    {
      const m = url.pathname.match(/^\/actor\/([^/]+)\/procedures\.json$/);
      if (m) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        const handle = decodeURIComponent(m[1]).toLowerCase();
        if (!HANDLE_REGEX.test(handle)) {
          return new Response(
            JSON.stringify({ error: "HandleInvalid" }),
            { status: 400, headers: ACTOR_JSON_HEADERS },
          );
        }
        const procs = GOV_PROCEDURES_BY_OWNER.get(handle) ?? [];
        const body = {
          handle,
          did: `did:web:etzhayyim.com:actor:${handle}`,
          adr: ["2606021600", "2606042330"],
          note: "Observational mirror of public procedures done at this administrative unit. NOT the government, NOT an official channel; never filed on anyone's behalf (→ toritsugi, gated). All rows :representative / :unverified-seed (G5).",
          count: procs.length,
          procedures: procs,
        };
        return new Response(JSON.stringify(body, null, 2) + "\n", {
          status: 200,
          headers: ACTOR_JSON_HEADERS,
        });
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 2c) Trustless IPFS gateway — `/ipfs/<cid>` (ADR-2606014600).
    //     Fetches the content-addressed bytes from configurable upstream
    //     gateways and VERIFIES they hash to the requested CID before serving,
    //     so the upstream gateway never has to be trusted — the CID is the
    //     trust anchor (no server key, ADR-2605231525). This is where the
    //     browser (ameno) / loader fetches an actor's WASM component
    //     (ADR-2606014500). Raw single-block CIDs (`bafkrei…`, compact edge
    //     actors) are verified; multi-block UnixFS CIDs (`bafy…`, large
    //     componentize-py actors) are not verifiable here → 501 (T2 mesh tier).
    // ──────────────────────────────────────────────────────────────────
    {
      const m = url.pathname.match(/^\/ipfs\/([A-Za-z0-9]+)$/);
      if (m) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        }
        const cid = m[1];
        const raw = isRawCidV1(cid);
        const dagpb = isDagPbCidV1(cid);
        if (!raw && !dagpb) {
          return new Response(
            JSON.stringify({
              error: "CidNotVerifiable",
              message:
                "trustless gateway supports CIDv1 with sha2-256 only: raw single-block (bafkrei…) verified directly, dag-pb UnixFS (bafybei…) verified via CAR. Other CIDs need a full IPFS node.",
              cid,
            }),
            { status: 501, headers: ACTOR_JSON_HEADERS },
          );
        }
        const gateways = (
          env.IPFS_GATEWAYS ||
          "https://{cid}.ipfs.dweb.link,https://ipfs.io/ipfs/{cid}"
        )
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean);
        let lastErr = "no gateway configured";
        for (const tmpl of gateways) {
          const base = tmpl.includes("{cid}")
            ? tmpl.replace("{cid}", cid)
            : `${tmpl.replace(/\/$/, "")}/ipfs/${cid}`;
          // dag-pb: ask the gateway for a verifiable CAR; raw: the block itself.
          const upstream = dagpb
            ? `${base}${base.includes("?") ? "&" : "?"}format=car`
            : base;
          try {
            const res = await fetch(upstream, {
              headers: {
                accept: dagpb
                  ? "application/vnd.ipld.car"
                  : "application/octet-stream",
              },
              signal: AbortSignal.timeout(dagpb ? 20000 : 8000),
            });
            if (!res.ok) {
              lastErr = `upstream ${res.status}`;
              continue;
            }
            const raw_buf = await res.arrayBuffer();
            let out: ArrayBuffer;
            if (dagpb) {
              try {
                // verifyCarToBytes re-hashes every block + walks the DAG from
                // the requested root, so the untrusted gateway can't substitute.
                const bytes = await verifyCarToBytes(
                  cid,
                  new Uint8Array(raw_buf),
                );
                out = bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength,
                ) as ArrayBuffer;
              } catch (ve) {
                lastErr = `car verify failed: ${ve instanceof Error ? ve.message : ve}`;
                continue; // never serve unverified bytes
              }
            } else {
              if (!(await verifyRawCid(cid, raw_buf))) {
                lastErr = "cid mismatch (untrusted gateway content rejected)";
                continue;
              }
              out = raw_buf;
            }
            const hdrs = {
              ...ipfsHeaders(cid, out.byteLength, detectCt(out)),
              "x-etzhayyim-cid-verified": dagpb ? "car-dag-pb" : "sha256",
            };
            return new Response(
              request.method === "HEAD" ? null : out,
              { status: 200, headers: hdrs },
            );
          } catch (e) {
            lastErr = e instanceof Error ? e.message : "fetch failed";
          }
        }
        return new Response(
          JSON.stringify({ error: "IpfsUnavailable", message: lastErr, cid }),
          { status: 502, headers: ACTOR_JSON_HEADERS },
        );
      }
    }

    // kotoba is content-addressed: genesis blocks live as static files under
    // public/kotoba/blocks/<cid> (served by CF assets before the Worker) and the
    // browser kotoba-wasm resolves them directly. Post-genesis, member-signed
    // deltas are published through the content-addressed KV CAS below (kblk:/
    // kroot:/kattest:). The former KotobaRoot Durable Object — the only operated
    // server-state primitive — was REMOVED per ADR-2605262130 / 2605312345; the
    // server now only verifies member signatures and stores content-addressed
    // blocks, never holds authoritative mutable state.

    // ──────────────────────────────────────────────────────────────────
    // 2d) kotoba member-signed publish (ADR-2605312345 / 2605231525).
    //     - GET  /kotoba/blocks/<cid>  → dynamically published block from KV
    //       (genesis blocks are static assets and never reach the Worker; a
    //       request arriving here is a post-genesis block).
    //     - POST /xrpc/com.etzhayyim.apps.kotoba.block.put → verify member sig,
    //       store blocks + advance root + record suppressable encrypted IP.
    //     - GET  /xrpc/com.etzhayyim.apps.kotoba.root → latest published root.
    //     Handled LOCALLY (the generic XRPC proxy below would forward to the
    //     internal kotoba node, which is not publicly reachable — and the whole
    //     point is no node is needed).
    // ──────────────────────────────────────────────────────────────────
    {
      const bm = url.pathname.match(/^\/kotoba\/blocks\/([A-Za-z0-9]+)$/);
      if (bm && (request.method === "GET" || request.method === "HEAD")) {
        const blk = await serveBlockFromKv(bm[1], env);
        if (blk) return blk;
        // not in KV → fall through (static asset already missed → 404 below)
      }
      if (url.pathname === "/xrpc/com.etzhayyim.apps.kotoba.block.put" && request.method === "POST") {
        return handleBlockPut(request, env);
      }
      if (url.pathname === "/xrpc/com.etzhayyim.apps.kotoba.block.has" && request.method === "POST") {
        return handleBlockHas(request, env);
      }
      if (
        url.pathname === "/xrpc/com.etzhayyim.apps.kotoba.root" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return handleRootGet(url, env);
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 2d) kotoba member-signed publish (ADR-2605312345 / 2605231525).
    //     - GET  /kotoba/blocks/<cid>  → dynamically published block from KV
    //       (genesis blocks are static assets and never reach the Worker; a
    //       request arriving here is a post-genesis block).
    //     - POST /xrpc/com.etzhayyim.apps.kotoba.block.put → verify member sig,
    //       store blocks + advance root + record suppressable encrypted IP.
    //     - GET  /xrpc/com.etzhayyim.apps.kotoba.root → latest published root.
    //     Handled LOCALLY (the generic XRPC proxy below would forward to the
    //     internal kotoba node, which is not publicly reachable — and the whole
    //     point is no node is needed).
    // ──────────────────────────────────────────────────────────────────
    {
      const bm = url.pathname.match(/^\/kotoba\/blocks\/([A-Za-z0-9]+)$/);
      if (bm && (request.method === "GET" || request.method === "HEAD")) {
        const blk = await serveBlockFromKv(bm[1], env);
        if (blk) return blk;
        // not in KV → fall through (static asset already missed → 404 below)
      }
      if (url.pathname === "/xrpc/com.etzhayyim.apps.kotoba.block.put" && request.method === "POST") {
        return handleBlockPut(request, env);
      }
      if (url.pathname === "/xrpc/com.etzhayyim.apps.kotoba.block.has" && request.method === "POST") {
        return handleBlockHas(request, env);
      }
      if (
        url.pathname === "/xrpc/com.etzhayyim.apps.kotoba.root" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return handleRootGet(url, env);
      }
      if (
        url.pathname === "/xrpc/com.etzhayyim.apps.kotoba.stats" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return handleStatsGet(url, env);
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 3) XRPC routing — `/xrpc/{NSID}` proxied by NSID prefix to the
    //    registered upstream (langserver pod, MCP gateway, etc.). One
    //    Worker handles every actor; new actors are added by appending
    //    to XRPC_ROUTES rather than spinning up a new subdomain.
    //
    //    Substrate short-circuit: if the NSID has a rw-free equivalent
    //    (see SUBSTRATE_NSID_ALIASES) and the YORO_XRPC service binding
    //    is configured, route to the adapter instead of the etzhayyim.com
    //    upstream. Per ADR-2605172000, reads MUST resolve through MST.
    // ──────────────────────────────────────────────────────────────────
    {
      const m = url.pathname.match(/^\/xrpc\/([A-Za-z0-9._-]+)$/);
      if (m) {
        const nsid = m[1];

        const SAME_ORIGIN_AUTH_CORS: Record<string, string> = {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-etzhayyim-no-cookie": "1",
          "x-etzhayyim-auth": "cacao-verify-only",
          "access-control-allow-origin": "*",
        };

        // ── verifyCacao short-circuit (ADR-2606060000) ────────────────────
        // Same-origin auth gate: verify a member-signed CACAO (WebAuthn/passkey
        // → Ed25519 did:key, verified LOCALLY via WebCrypto; SIWE/eip191
        // structurally validated + relayed to kotoba). No auth subdomain, no
        // server key, no session minted — the Worker only confirms DID control +
        // capability scope so the client can flip into a signed-in/edit state.
        // This is now the primary login/signup control proof (ADR-2606061800),
        // not just `/profile` edit-mode. Served locally; never proxied.
        if (
          nsid === "com.etzhayyim.authz.verifyCacao" &&
          request.method === "POST"
        ) {
          let payload: unknown = null;
          try {
            payload = await request.json();
          } catch {
            payload = null;
          }
          const { status, result } = await handleVerifyCacao(
            payload,
            Date.now(),
          );
          return new Response(JSON.stringify(result) + "\n", {
            status,
            headers: SAME_ORIGIN_AUTH_CORS,
          });
        }

        // ── registerAccount short-circuit (ADR-2606061800) ────────────────
        // Same-origin account publish: a member proves control of their
        // controller did:key with a CACAO carrying the `account:register`
        // capability; the Worker verifies it (no server key) and relays the
        // handle↔did:key alias + profile to the kotoba node. Best-effort — when
        // KOTOBA_WRITE_ENDPOINT is unset the relay reports `gated` (HTTP 202),
        // honest R0: the member is authenticated locally, the account just isn't
        // published yet. Served locally; never proxied.
        if (
          nsid === "com.etzhayyim.authz.registerAccount" &&
          request.method === "POST"
        ) {
          let payload: unknown = null;
          try {
            payload = await request.json();
          } catch {
            payload = null;
          }
          const { status, result } = await handleAccountWrite(
            payload,
            cacaoToCborBase64,
            (cacaoB64, id, claims, labelEn) =>
              relayKotobaWrite(env, cacaoB64, id, claims, labelEn),
          );
          return new Response(JSON.stringify(result) + "\n", {
            status,
            headers: SAME_ORIGIN_AUTH_CORS,
          });
        }

        // ── kotoba-write config (ADR-2606061800) ──────────────────────────
        // The frontend needs the node's operator_did (the required CACAO `aud`)
        // to sign a kotoba-write CACAO for account publish / device-enroll /
        // key-rotation. Returns it + whether writes are enabled. Public,
        // no-cookie, no secret (the operator_did is a public identifier).
        if (
          nsid === "com.etzhayyim.authz.kotobaWriteConfig" &&
          (request.method === "GET" || request.method === "HEAD")
        ) {
          return new Response(
            JSON.stringify({
              operatorDid: env.KOTOBA_OPERATOR_DID ?? null,
              writeEnabled: !!env.KOTOBA_WRITE_ENDPOINT && !!env.KOTOBA_OPERATOR_DID,
            }) + "\n",
            { status: 200, headers: SAME_ORIGIN_AUTH_CORS },
          );
        }

        // ── searchActors + getSuggestions short-circuit (ADR-2606042330) ──
        // Make society-scale entity mirror-actors visible on `/search`. The
        // legacy path proxies BOTH searchActors AND getSuggestions to the PDS
        // appview (only human + a handful of infra actors), so the ~8,888 gov/
        // corp/cable/station/craft mirrors were invisible — `/search`'s default
        // browse view calls getSuggestions, which is why it was stuck at ~62.
        // We answer from the Worker's generated registries (self-contained, no
        // firehose — G8): searchActors uses the `q` filter + best-effort PDS
        // merge; getSuggestions browses the whole entity universe (q="", no
        // merge — pure entity stream, paginated by the offset cursor).
        const isSuggest =
          nsid === "app.bsky.actor.getSuggestions" ||
          nsid === "com.etzhayyim.yoro.actor.getSuggestions";
        if (
          (nsid === "app.bsky.actor.searchActors" ||
            nsid === "com.etzhayyim.yoro.actor.searchActors" ||
            isSuggest) &&
          (request.method === "GET" || request.method === "HEAD")
        ) {
          // getSuggestions has no query — browse every entity mirror.
          const q = isSuggest
            ? ""
            : url.searchParams.get("q") ?? url.searchParams.get("term") ?? "";
          const limitParam = parseInt(url.searchParams.get("limit") ?? "25", 10);
          const limit = Number.isFinite(limitParam)
            ? Math.min(Math.max(limitParam, 1), 100)
            : 25;
          // cursor = numeric offset into the (stable-ordered) entity match set.
          const offParam = parseInt(url.searchParams.get("cursor") ?? "0", 10);
          const offset = Number.isFinite(offParam) && offParam > 0 ? offParam : 0;
          const page = searchEntityActors(q, limit, offset);
          const entityActors = page.records.map((r) => toGetProfileView(r));
          // First page also carries the compiled named/infra actors (tsumugi /
          // ooyake / kabuto / watari / … + substrate services). They are real
          // actors that belong in search, AND their presence is what stops the
          // yoro service worker (kotoba-sw.js) from "backfilling" them and
          // resetting `totalActors` to the page length — the bug that capped
          // `/search` at ~62 even though this Worker returns 8,888. The SW only
          // rewrites the response when it finds a seed actor MISSING from it;
          // include them and it passes our response (totalActors intact) through.
          let namedActors: unknown[] = [];
          if (offset === 0) {
            const ql = q.trim().toLowerCase();
            for (const h of COMPILED_ACTOR_HANDLES) {
              const rec = compiledActorRecord(h);
              if (!rec) continue;
              const name = (
                rec.displayNameEn ||
                rec.displayNameJa ||
                rec.handle
              ).toLowerCase();
              if (!ql || h.includes(ql) || name.includes(ql)) {
                namedActors.push(toGetProfileView(rec));
              }
            }
          }
          // best-effort upstream merge (PDS members) — only on the FIRST page and
          // only when there is room, so the entity offset-cursor stays consistent
          // across pages. Tolerate absence (G8 R0).
          let upstreamActors: unknown[] = [];
          if (
            env.YORO_XRPC &&
            !isSuggest &&
            offset === 0 &&
            entityActors.length < limit
          ) {
            try {
              const su = new URL(request.url);
              su.pathname = `/xrpc/com.etzhayyim.yoro.actor.searchActors`;
              const fwd = new Headers(request.headers);
              stripIncomingCookies(fwd);
              fwd.set("x-forwarded-host", "etzhayyim.com");
              const ur = await env.YORO_XRPC.fetch(
                new Request(su.toString(), { method: "GET", headers: fwd }),
              );
              if (ur.ok) {
                const j = (await ur.json()) as { actors?: unknown[] };
                if (Array.isArray(j.actors)) {
                  upstreamActors = j.actors.slice(0, limit - entityActors.length);
                }
              }
            } catch {
              // upstream unavailable — entity matches still answer the query.
            }
          }
          const actors = [...namedActors, ...entityActors, ...upstreamActors];
          // totalActors: full match count when a query is set, else the whole
          // entity universe — so the UI shows "8,888 actors" not "62+". The
          // page-1 named actors are counted in too.
          const totalActors =
            (q.trim() ? page.total : ENTITY_TOTAL_COUNT) +
            (offset === 0 ? namedActors.length : 0);
          const body: Record<string, unknown> = { actors, totalActors };
          // cursor drives the UI's infinite-scroll loadMoreActors(); omit at end.
          if (page.nextOffset !== null) body.cursor = String(page.nextOffset);
          return new Response(JSON.stringify(body) + "\n", {
            status: 200,
            headers: {
              ...ACTOR_JSON_HEADERS,
              "x-etzhayyim-actor-source": "entity-mirror+pds",
              "x-etzhayyim-entity-total": String(ENTITY_TOTAL_COUNT),
              "permissions-policy": PERMISSIONS_POLICY,
            },
          });
        }

        // ── Actor-profile short-circuit (ADR-2606013800) ──────────────────
        // getProfile for a REGISTERED actor resolves from the actor registry
        // (KV → kotoba → compiled), NOT the PDS/substrate. Gated on the actor
        // being a known actor so human-member profiles are never hijacked:
        //  - a `did:web:etzhayyim.com:actor:<h>` param is unambiguously an actor
        //  - a bare/handle param only short-circuits when `<h>` is a compiled
        //    actor; everything else falls through to substrate routing.
        if (
          (nsid === "app.bsky.actor.getProfile" ||
            nsid === "com.etzhayyim.actor.getProfile") &&
          (request.method === "GET" || request.method === "HEAD")
        ) {
          const actorParam = url.searchParams.get("actor") ?? "";
          const isActorDid = actorParam.startsWith(
            "did:web:etzhayyim.com:actor:",
          );
          const handle = actorHandleFromParam(actorParam);
          if (
            handle &&
            (isActorDid ||
              COMPILED_ACTOR_HANDLES.has(handle) ||
              isEntityHandle(handle))
          ) {
            const rec = await resolveActorRecord(handle, env, ctx);
            if (rec) {
              return new Response(
                JSON.stringify(toGetProfileView(rec)) + "\n",
                {
                  status: 200,
                  headers: {
                    ...ACTOR_JSON_HEADERS,
                    "x-etzhayyim-actor-source": rec.source,
                    "permissions-policy": PERMISSIONS_POLICY,
                  },
                },
              );
            }
          }
          // not a registered actor → fall through to substrate alias routing.
        }

        const aliasedNsid = SUBSTRATE_NSID_ALIASES[nsid];
        const passthrough =
          !aliasedNsid &&
          SUBSTRATE_PASSTHROUGH_PREFIXES.some((p) => nsid.startsWith(p));
        const substrateNsid = aliasedNsid ?? (passthrough ? nsid : undefined);
        if (substrateNsid && env.YORO_XRPC) {
          const substrateUrl = new URL(request.url);
          substrateUrl.pathname = `/xrpc/${substrateNsid}`;
          const fwd = new Headers(request.headers);
          stripIncomingCookies(fwd);
          fwd.set("x-forwarded-host", "etzhayyim.com");
          fwd.set("x-forwarded-proto", "https");
          fwd.set("x-etzhayyim-nsid", nsid);
          fwd.set("x-etzhayyim-substrate-nsid", substrateNsid);
          try {
            const upstreamResp = await env.YORO_XRPC.fetch(
              new Request(substrateUrl.toString(), {
                method: request.method,
                headers: fwd,
                body:
                  request.method === "GET" || request.method === "HEAD"
                    ? undefined
                    : request.body,
                redirect: "manual",
              }),
            );
            const respHeaders = new Headers(upstreamResp.headers);
            for (const h of STRIPPED_RESPONSE_HEADERS) respHeaders.delete(h);
            respHeaders.set("x-proxied-by", "etzhayyim-did-web");
            respHeaders.set("x-proxied-upstream", "service:yoro-xrpc-adapter");
            respHeaders.set("x-etzhayyim-substrate", "mst-ipfs-l2");
            respHeaders.set("x-etzhayyim-no-cookie", "1");
            applyApexSecurityHeaders(respHeaders, substrateUrl.pathname);
            return new Response(upstreamResp.body, {
              status: upstreamResp.status,
              statusText: upstreamResp.statusText,
              headers: respHeaders,
            });
          } catch (err) {
            return new Response(
              JSON.stringify({
                error: "SubstrateUnreachable",
                message:
                  err instanceof Error
                    ? err.message
                    : "yoro-xrpc-adapter service binding fetch failed",
                nsid,
                substrateNsid,
              }),
              {
                status: 502,
                headers: {
                  "content-type": "application/json; charset=utf-8",
                  "x-proxied-by": "etzhayyim-did-web",
                  "x-proxied-upstream": "service:yoro-xrpc-adapter",
                },
              },
            );
          }
        }

        const route = findXrpcRoute(nsid);
        if (!route) {
          return new Response(
            JSON.stringify({
              error: "MethodNotImplemented",
              message: `no upstream registered for NSID '${nsid}'`,
            }),
            {
              status: 501,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }
        const upstream = env[route.upstream] as string | undefined;
        if (!upstream) {
          return new Response(
            JSON.stringify({
              error: "UpstreamNotConfigured",
              message: `env.${String(route.upstream)} is empty`,
              nsid,
            }),
            {
              status: 503,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }
        return proxyXrpc(request, upstream, nsid);
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 4) All other paths — reverse-proxy to the yoro Worker via service
    // binding (env.YORO). This bypasses the CF edge/Bot Management block
    // that public-HTTP fetch hits inside the same zone.
    // ──────────────────────────────────────────────────────────────────
    try {
      const upstream = await env.YORO.fetch(buildUpstreamRequest(request));
      return rewriteUpstreamResponse(upstream, url.pathname);
    } catch (err) {
      return new Response(
        `Service binding fetch to kotodama-yoro failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          status: 502,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-proxied-by": "etzhayyim-did-web",
            "x-proxied-upstream": "service:kotodama-yoro",
          },
        }
      );
    }
  },
} satisfies ExportedHandler<Env>;
