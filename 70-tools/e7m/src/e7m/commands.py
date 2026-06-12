"""Shared command logic — used by both the CLI and the MCP server.

Each function returns a structured dict so the MCP server can pass it
to the calling agent as JSON; the CLI then renders that dict for humans.

Boundary: these functions are the only place that touches the organism.
Both CLI and MCP route through here so audit logging can be added in
one spot later.
"""

from __future__ import annotations

import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from . import api
from . import pds as _pds


# ── PDS / yoro substrate probes (delegated to e7m.pds) ────────────────────

def pds_describe_server(host: str = "atproto") -> dict[str, Any]:
    return _pds.describe_server(host)


def pds_list_repos(host: str = "atproto", limit: int = 20, cursor: str | None = None) -> dict[str, Any]:
    return _pds.list_repos(host, limit=limit, cursor=cursor)


def pds_describe_repo(did: str, host: str = "atproto") -> dict[str, Any]:
    return _pds.describe_repo(did, host=host)


def pds_resolve_handle(handle: str, host: str = "atproto") -> dict[str, Any]:
    return _pds.resolve_handle(handle, host=host)


def pds_xrpc(
    nsid: str,
    method: str = "GET",
    host: str = "apex",
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    bearer: str | None = None,
    allow_write: bool = False,
) -> dict[str, Any]:
    return _pds.xrpc(
        nsid,
        method=method,
        host=host,
        params=params,
        body=body,
        bearer=bearer,
        allow_write=allow_write,
    )


def pds_create_account(
    host: str,
    handle: str,
    did: str | None = None,
    email: str | None = None,
    invite_code: str | None = None,
    password: str | None = None,
) -> dict[str, Any]:
    return _pds.create_account(
        host=host,
        handle=handle,
        did=did,
        email=email,
        invite_code=invite_code,
        password=password,
    )


def yoro_probe() -> dict[str, Any]:
    return _pds.yoro_probe()


# ── observation ───────────────────────────────────────────────────────────

def status() -> dict[str, Any]:
    """Aliveness 5-tuple + axis scores + in-band summary."""
    try:
        s = api.state()
    except Exception as exc:
        return {"ok": False, "error": str(exc), "hint": f"viz pod unreachable at {api.VIZ_URL} — is the port-forward running?"}
    a = s["alive"]
    bands = s.get("in_band", {})
    return {
        "ok": True,
        "timestamp": s["timestamp"],
        "aliveness": {
            "M": a["M_motion"], "D": a["D_diversity"], "C": a["C_coupling"],
            "P": a["P_pruning"], "G": a["G_generational"],
        },
        "in_band": bands,
        "in_band_count": sum(1 for v in bands.values() if v),
        "axis_scores": s.get("axis_scores", {}),
        "entity_count": len(s.get("entities", {})),
        "flowers": s.get("flowers", []),
        "fruits":  s.get("fruits",  []),
    }


def full_state() -> dict[str, Any]:
    """Whole snapshot — for agents that want to reason over the full tree."""
    return api.state()


def entities(kind: str | None = None) -> dict[str, Any]:
    """List entities, optionally filtered by kind."""
    s = api.state()
    out = []
    for eid, e in s.get("entities", {}).items():
        if kind and e.get("kind") != kind:
            continue
        out.append({"id": eid, "kind": e.get("kind"), "title": e.get("title"),
                    "neighbors": e.get("neighbors", []),
                    "pruning_severity": e.get("pruning_severity", 0)})
    out.sort(key=lambda x: (x["kind"], x["id"]))
    return {"ok": True, "count": len(out), "entities": out}


# ── dialogue ──────────────────────────────────────────────────────────────

def chat(entity_id: str, message: str) -> dict[str, Any]:
    """Speak with a life in the ecosystem."""
    return api.chat(entity_id, message)


# ── pruning (operator-only mutation, even via MCP) ────────────────────────

def prune_candidates() -> dict[str, Any]:
    """List candidates surfaced by the daemon. Never deletes."""
    return api.pruning()


def prune_show(entity_id: str) -> dict[str, Any]:
    """Detailed view of a single pruning candidate (state + reasons)."""
    snap = api.state()
    ent = snap.get("entities", {}).get(entity_id)
    if not ent:
        return {"ok": False, "error": f"entity not found: {entity_id}"}
    cands = api.pruning().get("candidates", [])
    me = next((c for c in cands if c["id"] == entity_id), None)
    return {
        "ok": True, "entity_id": entity_id, "kind": ent.get("kind"),
        "title": ent.get("title"), "state": ent.get("state"),
        "neighbors": ent.get("neighbors", []),
        "candidate": me,
    }


# ── pruning approval (operator-only, never automatic) ────────────────────

def _repo_root() -> Path:
    """Find the repo root via the CLI's CWD or git rev-parse."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL, timeout=5,
        ).decode("utf-8").strip()
        return Path(out)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path.cwd()


_PRUNE_ADR_TEMPLATE = """\
---
id: pruning-{stamp}-{safe_id}
title: "Pruning: {entity_id}"
status: proposed
doc_type: pruning-record
topic: bonsai-pruning
authoritative: true
last_verified: {date}
priority: 4.0
axis: pruning
---

# Pruning: `{entity_id}`

**Date**: {date_iso}
**Operator**: {operator}
**Branch**: `{branch}`
**Constitutional anchor**: ADR-2605192100 §1.3 (decision attribution = etzhayyim)
**Bonsai protocol**: ADR-2605221411 §3 (e7m operator surface) + §4 (ideal-state prior)

## What was pruned

- **Path**: `{path}`
- **Kind**: {kind}
- **Idle days at pruning**: {idle_days}
- **Reasons surfaced by the daemon**:
{reasons_md}

## Operator review

- [ ] Confirmed the entity has no current engagement
- [ ] Confirmed no other cell/app/ADR has an active dependency on it
- [ ] Discussed in Council (Lv6+) if applicable — n/a otherwise
- [ ] Considered alternate (rename / dormant-tag instead of delete)

## Decision

_(operator: fill in the rationale before merging this branch)_

## Restoration path

If pruning was in error: `git revert <commit-sha>` on this branch before merging.

---

_The daemon surfaced this candidate; the operator made the cut._
"""


def prune_approve(entity_id: str, *, dry_run: bool = False) -> dict[str, Any]:
    """Operator approves pruning of a cell/app.

    Creates an isolated branch, writes a pruning-record ADR template,
    runs `git rm -r`, and commits — all on the branch. Never pushes.
    Operator pushes / opens a PR after manual review.
    """
    snap = api.state()
    ent = snap.get("entities", {}).get(entity_id)
    if not ent:
        return {"ok": False, "error": f"entity not found: {entity_id}"}
    kind = ent.get("kind")
    if kind not in ("cell", "app"):
        return {"ok": False, "error": f"refusing to prune kind={kind}; only 'cell' or 'app' are prunable (axes/organism/ecosystem are constitutional)"}
    path = ent.get("state", {}).get("path")
    if not path:
        return {"ok": False, "error": f"entity has no resolvable filesystem path"}

    repo = _repo_root()
    abs_path = repo / path
    if not abs_path.exists():
        return {"ok": False, "error": f"path does not exist on disk: {abs_path}"}

    import datetime as _dt, re as _re
    now = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=9)))
    stamp = now.strftime("%y%m%d%H%M")
    date_iso = now.strftime("%Y-%m-%dT%H:%M:%S+09:00")
    date = now.strftime("%Y-%m-%d")
    safe_id = _re.sub(r"[^a-zA-Z0-9_-]", "-", entity_id)
    branch = f"prune/{safe_id}-{stamp}"
    adr_rel = f"90-docs/pruning/{stamp}-{safe_id}.md"
    adr_abs = repo / adr_rel

    # Branch must not pre-exist
    bcheck = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", branch],
        capture_output=True, text=True, timeout=5,
    )
    if bcheck.returncode == 0:
        return {"ok": False, "error": f"branch already exists: {branch}"}

    # Compose the plan; in dry-run, return without touching the repo
    operator = subprocess.run(
        ["git", "-C", str(repo), "config", "user.name"],
        capture_output=True, text=True, timeout=5,
    ).stdout.strip() or "unknown"

    cands = api.pruning().get("candidates", [])
    me = next((c for c in cands if c["id"] == entity_id), None)
    reasons = (me or {}).get("reasons", ["(no candidate metadata)"])
    reasons_md = "\n".join(f"  - {r}" for r in reasons)
    idle_days = (me or {}).get("idle_days", "n/a")

    adr_body = _PRUNE_ADR_TEMPLATE.format(
        stamp=stamp, safe_id=safe_id, date=date, date_iso=date_iso,
        operator=operator, branch=branch, entity_id=entity_id, path=path,
        kind=kind, idle_days=idle_days, reasons_md=reasons_md,
    )

    plan = {
        "branch": branch,
        "adr_path": adr_rel,
        "delete_path": path,
        "operator": operator,
        "reasons": reasons,
    }

    if dry_run:
        return {"ok": True, "dry_run": True, "plan": plan, "adr_preview": adr_body}

    # Real execution — check tree is clean
    dirty = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain"],
        capture_output=True, text=True, timeout=5,
    )
    if dirty.stdout.strip():
        return {
            "ok": False,
            "error": "working tree has uncommitted changes; commit or stash first",
            "dirty": dirty.stdout.strip().splitlines()[:10],
        }

    # Execute. Each step is its own subprocess so we can report what stage failed.
    def _git(*args: str) -> tuple[int, str, str]:
        r = subprocess.run(["git", "-C", str(repo), *args],
                           capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout, r.stderr

    rc, _, err = _git("checkout", "-b", branch)
    if rc != 0:
        return {"ok": False, "error": f"git checkout -b failed: {err.strip()}"}

    adr_abs.parent.mkdir(parents=True, exist_ok=True)
    adr_abs.write_text(adr_body, encoding="utf-8")

    rc, _, err = _git("add", adr_rel)
    if rc != 0:
        return {"ok": False, "error": f"git add ADR failed: {err.strip()}", "branch": branch}

    rc, _, err = _git("rm", "-r", path)
    if rc != 0:
        return {"ok": False, "error": f"git rm failed: {err.strip()}", "branch": branch}

    rc, _, err = _git("commit", "-m",
                      f"prune({kind}): {entity_id} — surfaced by daemon, approved by operator")
    if rc != 0:
        return {"ok": False, "error": f"git commit failed: {err.strip()}", "branch": branch}

    rc, sha, _ = _git("rev-parse", "HEAD")
    return {
        "ok": True, "branch": branch, "adr_path": adr_rel,
        "deleted_path": path, "commit": sha.strip()[:12],
        "next_steps": [
            "Review the branch: `git log -p {}`".format(branch),
            "If happy, push: `git push -u origin {}`".format(branch),
            "Open PR for Council review; merge after attestation",
            "If wrong: `git checkout main` then `git branch -D {}`".format(branch),
        ],
    }


# ── pod control (kubectl wrapper, single chokepoint) ──────────────────────

def pod_status() -> dict[str, Any]:
    """Pod liveness from kubectl (orbstack context)."""
    import json as _json
    try:
        out = subprocess.check_output(
            ["kubectl", "--context", "orbstack", "-n", "etzhayyim-organism",
             "get", "pods", "-o", "json"],
            stderr=subprocess.STDOUT, timeout=10,
        ).decode("utf-8", errors="ignore")
        data = _json.loads(out)
        rows = []
        for item in data.get("items", []):
            cs = (item.get("status", {}).get("containerStatuses") or [{}])[0]
            rows.append({
                "name": item.get("metadata", {}).get("name", ""),
                "phase": item.get("status", {}).get("phase", ""),
                "ready": bool(cs.get("ready", False)),
                "restarts": int(cs.get("restartCount", 0) or 0),
            })
        return {"ok": True, "pods": rows}
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired, ValueError) as exc:
        return {"ok": False, "error": str(exc)}


def pod_logs(deployment: str = "etzhayyim-organism", tail: int = 50) -> dict[str, Any]:
    """Tail the CNS or viz pod logs."""
    if deployment not in ("etzhayyim-organism", "etzhayyim-organism-viz"):
        return {"ok": False, "error": f"unknown deployment: {deployment}"}
    try:
        out = subprocess.check_output(
            ["kubectl", "--context", "orbstack", "-n", "etzhayyim-organism",
             "logs", f"deploy/{deployment}", "--tail", str(tail)],
            stderr=subprocess.STDOUT, timeout=10,
        ).decode("utf-8", errors="ignore")
        return {"ok": True, "deployment": deployment, "tail": tail, "logs": out}
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}


def viz_url() -> dict[str, Any]:
    """The local URL of the dashboard (port-forward must already be running)."""
    return {"ok": True, "url": api.VIZ_URL}


# ── manual tick (CNS) ─────────────────────────────────────────────────────

def tick() -> dict[str, Any]:
    """Trigger one CNS tick (kubectl exec into the organism pod, --once)."""
    try:
        out = subprocess.check_output(
            ["kubectl", "--context", "orbstack", "-n", "etzhayyim-organism",
             "exec", "deploy/etzhayyim-organism", "--",
             "python", "-m", "etzhayyim_organism", "--once",
             "--repo", "/repo", "--source", "e7m manual tick"],
            stderr=subprocess.STDOUT, timeout=90,
        ).decode("utf-8", errors="ignore")
        return {"ok": True, "log": out or "(no stdout — check observations directory; tick still likely succeeded)"}
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}


# ── inalienable lineage (read-only — operator surface) ───────────────────

def _parse_roster(path: Path, member_table: bool) -> list[dict[str, str]]:
    """Parse a markdown table from MEMBERS.md or LANDS.md, returning rows.

    Robust to multiple tables in the same file: each separator row resets
    the active headers to the previous `|`-row. Filters known placeholder
    values and column-header literals.
    """
    if not path.exists():
        return []
    rows: list[dict[str, str]] = []
    headers: list[str] = []
    last_pipe_line: list[str] | None = None
    in_table = False

    HEADER_LITERALS = {"@github", "did", "lv", "ja", "en", "meaning", "level",
                       "on-chain join tx", "joined", "revoked",
                       "type", "description", "per adr"}

    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line.startswith("|"):
            in_table = False
            last_pipe_line = None
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if all(set(c) <= set("-: ") and c for c in cells):
            # separator — adopt headers from the previous pipe line
            if last_pipe_line is not None:
                headers = last_pipe_line
            in_table = True
            continue
        if not in_table:
            last_pipe_line = cells
            continue
        # data row — skip placeholders
        if any("awaiting" in c.lower() or "placeholder" in c.lower() for c in cells):
            continue
        # skip rows where the first cell is itself a header-literal token
        first_lower = (cells[0] or "").lower()
        if first_lower in HEADER_LITERALS:
            continue
        if member_table:
            first = cells[0]
            # real members: starts with @ + actual username, or did:
            if first.startswith("did:"):
                pass
            elif first.startswith("@") and len(first) > 1 and first != "@github":
                pass
            else:
                continue
        else:
            if len(cells) < 3:
                continue
        row = {h: (cells[i] if i < len(cells) else "") for i, h in enumerate(headers)}
        rows.append(row)
    return rows


def members() -> dict[str, Any]:
    """Current MEMBERS.md roster (信者 dual-permanent record)."""
    repo = _repo_root()
    path = repo / "MEMBERS.md"
    rows = _parse_roster(path, member_table=True)
    return {
        "ok": True,
        "source": "MEMBERS.md",
        "count": len(rows),
        "members": rows,
        "constitutional_anchor": "ADR-2605172600 (membership ritual)",
        "note": "monotonic — per §1.3 members are never deleted, only deactivated",
    }


def lands() -> dict[str, Any]:
    """Current LANDS.md registry (護持地, 4-layer permanent record)."""
    repo = _repo_root()
    path = repo / "LANDS.md"
    rows = _parse_roster(path, member_table=False)
    # filter out the 'Type' classification table at the top; keep only rows that
    # look like actual land entries (heuristic: ≥4 non-empty cells, first cell
    # not in the known type vocabulary)
    type_words = {"Agricultural", "Residential", "Forest", "Religious Facility",
                  "Other", "Ocean / Maritime", "Water / Riparian",
                  "Air / Atmosphere", "Orbital / Space", "Type"}
    real = [r for r in rows
            if sum(1 for v in r.values() if v) >= 4
            and next(iter(r.values()), "") not in type_words]
    return {
        "ok": True,
        "source": "LANDS.md",
        "count": len(real),
        "lands": real,
        "type_legend_count": len(rows) - len(real),
        "constitutional_anchor": "ADR-2605192245 (land sovereignty), ADR-2605192100 §1.11",
        "note": "inalienable — no transfer, no burn, no sale (constitutional invariant)",
    }


# ── constitutional verification (read-only) ──────────────────────────────

# Each check returns (passed, evidence_lines). All 8 are constitutional hard
# invariants from ADR-2605192100; ANY failure is a crisis requiring Council
# convocation (per the doc), not a low score.

_SKIP_DIRS = {
    "node_modules", "dist", "build", ".venv", "venv", "target",
    "lib", "vendor", "out", "_svelte", "_assets", "_observations",
    "__pycache__", ".cache", ".pytest_cache",
}


def _is_first_party_source(f: Path) -> bool:
    if not f.is_file():
        return False
    parts = set(f.parts)
    if any(p in parts for p in _SKIP_DIRS):
        return False
    # exclude bundled/minified artifacts and source maps
    name = f.name
    if name.endswith(".min.js") or name.endswith(".min.css") or name.endswith(".map"):
        return False
    # exclude pre-cutover legacy app trees (per CLAUDE.md "legacy organisation-specific
    # prefixes" rule — these are seeded snapshots awaiting rename)
    if any(p.startswith("etzhayyim-project-") or p.startswith("etzhayyim-apps-") for p in f.parts):
        return False
    return True


def _first_party_source_files(
    repo: Path, scan_roots: list[str], extensions: tuple[str, ...]
) -> list[Path]:
    """Enumerate first-party source files under `scan_roots` with one of
    `extensions` (lowercase, dotted). Uses `git ls-files` for speed — see
    `_no_server_key_candidates` for the rationale + fallback shape.

    Honours `_is_first_party_source` filtering (legacy `etzhayyim-project-*`
    paths + minified artifacts excluded). Files outside the git index
    (build caches, node_modules) are never enumerated.
    """
    # Build pathspecs like '60-apps/**/*.html' for git ls-files.
    pathspecs: list[str] = []
    for root in scan_roots:
        for ext in extensions:
            pathspecs.append(f"{root}/**/*{ext}")
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "ls-files", "-z", "--", *pathspecs],
            capture_output=True, check=True, timeout=30,
        )
        rel = [p for p in out.stdout.decode("utf-8", errors="ignore").split("\0") if p]
        cand = [repo / r for r in rel]
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        # Fallback: original pathlib rglob path.
        cand = []
        for root in scan_roots:
            rp = repo / root
            if not rp.is_dir():
                continue
            for f in rp.rglob("*"):
                if f.suffix.lower() in extensions:
                    cand.append(f)
    return [f for f in cand if _is_first_party_source(f)]


def _check_no_advertising(repo: Path) -> tuple[bool, list[str]]:
    """§1.13 — third-party advertising prohibited (in first-party source).

    Implementation: `git grep -lE` does the needle-matching in C against
    the git index (~10x faster than pythonic `for f in ...; f.read_text;
    needle in text`) — and honours `.gitignore` so `node_modules/` /
    build caches are never scanned. The fallback path uses
    `_first_party_source_files` for non-git environments.
    """
    needles = [
        ("googletagmanager.com", "GTM"),
        ("g.doubleclick.net",    "DoubleClick"),
        ("facebook.com/tr",      "Meta Pixel"),
        ("connect.facebook.net", "Meta Pixel"),
        ("ads.linkedin.com",     "LinkedIn Insight"),
        ("static.ads-twitter",   "Twitter Pixel"),
        ("script.hotjar.com",    "Hotjar"),
    ]
    scan_roots = ["60-apps", "10-protocol", "20-actors", "50-infra"]
    extensions = (".html", ".js", ".ts", ".tsx", ".jsx", ".svelte", ".py", ".rs")
    # Construct git pathspecs: one per (root, extension) pair.
    pathspecs = [f"{root}/**/*{ext}" for root in scan_roots for ext in extensions]
    # Fixed-string alternation via -F + -e (one -e per needle).
    grep_args = ["git", "-C", str(repo), "grep", "-l", "-F"]
    for needle, _label in needles:
        grep_args += ["-e", needle]
    grep_args += ["--", *pathspecs]
    hits: list[str] = []
    try:
        out = subprocess.run(grep_args, capture_output=True, timeout=30)
        # git grep returns 1 = no matches; 0 = matches found; treat both
        # as success, other returncodes as fallback trigger.
        if out.returncode not in (0, 1):
            raise subprocess.SubprocessError(f"git grep exit {out.returncode}")
        matched_files = [
            repo / p for p in out.stdout.decode("utf-8", errors="ignore").split("\n") if p
        ]
        # Re-apply legacy `etzhayyim-project-*` exclusion via _is_first_party_source.
        matched_files = [f for f in matched_files if _is_first_party_source(f)]
        # Identify which specific needles matched, for the hit listing.
        for f in matched_files:
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for needle, label in needles:
                if needle in text:
                    hits.append(f"  {label} in {f.relative_to(repo)}")
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        # Fallback: pythonic read + match against the candidate set.
        for f in _first_party_source_files(repo, scan_roots, extensions):
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for needle, label in needles:
                if needle in text:
                    hits.append(f"  {label} in {f.relative_to(repo)}")
    if hits:
        return False, ["found prohibited third-party ad network references:"] + hits[:20]
    return True, [f"scanned {', '.join(scan_roots)} (first-party source only) — no ad references"]


def _check_charter_rider(repo: Path) -> tuple[bool, list[str]]:
    """ADR-2605192200 — first-party Apache-2.0 packages carry the Charter Rider."""
    rider = repo / "CHARTER-RIDER.md"
    if not rider.exists():
        return False, ["CHARTER-RIDER.md missing at repo root"]
    # `repo.rglob("NOTICE")` walks the entire filesystem tree including
    # node_modules / .venv / build caches — ~10s on this monorepo.
    # `git ls-files NOTICE` reads the index instead: <100ms.
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "ls-files", "-z", "--", "NOTICE", "**/NOTICE"],
            capture_output=True, check=True, timeout=30,
        )
        notice_count = sum(1 for p in out.stdout.decode("utf-8", errors="ignore").split("\0") if p)
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        notice_count = sum(
            1 for f in repo.rglob("NOTICE")
            if "node_modules" not in f.parts and ".venv" not in f.parts and ".git" not in f.parts
        )
    if notice_count < 30:
        return False, [
            f"only {notice_count} NOTICE files found",
            "ADR-2605192200 says ≥39 first-party Apache-2.0 packages should carry NOTICE + Rider",
        ]
    return True, [f"CHARTER-RIDER.md present at root + {notice_count} NOTICE files propagated"]


def _check_non_eschatological(repo: Path) -> tuple[bool, list[str]]:
    """§1.15 — no Book of Revelation as doctrine, no end-state predicted.

    The constitution PROHIBITS adoption of these doctrines; documents that
    explicitly REJECT them are correctly using the negation. We accept any
    occurrence whose surrounding context contains a negation/rejection token
    (in English or Japanese).
    """
    forbidden = ["book of revelation", "rapture", "end times", "apocalypse",
                 "黙示録", "啓示の書", "千年王国", "末法"]
    # tokens that, if present near a forbidden term, indicate negation/rejection
    negators = [
        "non-", "no-", "no ", "anti-", "not ", "without ", "excluded", "exclude",
        "reject", "forbidden", "prohibited", "out of scope", "out-of-scope",
        "ineligible", "doctrinally exclude", "same reason", "for the same",
        "対象としない", "対象外", "正典外", "禁じ", "否定", "除外", "除く", "を除く",
        "排除", "拒否", "外す", "同様の理由", "認めない",
    ]

    religious_paths = [
        repo / "CHARTER-RIDER.md", repo / "README.md", repo / "CLAUDE.md",
    ]
    religious_paths += list((repo / "90-docs" / "adr").glob("*etzhayyim*.md"))

    hits: list[str] = []
    for f in religious_paths:
        if not f.is_file():
            continue
        try:
            t = f.read_text(encoding="utf-8", errors="ignore").lower()
        except OSError:
            continue
        for needle in forbidden:
            idx = 0
            while True:
                idx = t.find(needle, idx)
                if idx < 0:
                    break
                ctx = t[max(0, idx - 200):idx + 200]
                if not any(n in ctx for n in negators):
                    hits.append(f"  positive '{needle}' in {f.relative_to(repo)}: …{ctx.strip()[:120]}…")
                idx += len(needle)
    if hits:
        return False, ["non-eschatology invariant violated:"] + hits[:10]
    return True, [f"scanned {len(religious_paths)} religious docs — every eschatological term appears in a negating context"]


def _check_land_inalienable(repo: Path) -> tuple[bool, list[str]]:
    """§1.11 — land contracts forbid transfer/burn/setOwner."""
    # Foundry's out/ contains directories named *.sol — filter to actual files only
    # and exclude the build cache.
    candidates = [
        f for f in (
            list(repo.glob("50-infra/**/LandRegistry.sol")) +
            list(repo.glob("50-infra/**/PublicLandRegistry.sol"))
        )
        if f.is_file() and "out" not in f.parts
    ]
    if not candidates:
        return True, ["land contracts not yet scaffolded (acceptable pre-deploy)"]
    hits: list[str] = []
    for f in candidates:
        text = f.read_text(encoding="utf-8", errors="ignore")
        for forbidden in ("function transfer", "function transferFrom",
                          "function burn", "function setOwner"):
            if forbidden in text:
                idx = text.find(forbidden)
                tail = text[idx:idx + 400]
                if "revert" in tail.lower() or "disallow" in tail.lower():
                    continue
                hits.append(f"  '{forbidden}' present without revert in {f.relative_to(repo)}")
    if hits:
        return False, ["land inalienability invariant possibly violated:"] + hits
    return True, [f"{len(candidates)} land contract(s) scanned — no transfer/burn/setOwner without revert"]


def _check_tithe_ten_percent(repo: Path) -> tuple[bool, list[str]]:
    """§1.5 + ADR-2605192130 — 10% tithe (1000 bps)."""
    candidates = [
        f for f in (
            list(repo.glob("50-infra/**/TitheRouter.sol")) +
            list(repo.glob("50-infra/**/Constitution.sol"))
        )
        if f.is_file() and "out" not in f.parts
    ]
    if not candidates:
        return True, ["TitheRouter / Constitution contracts not yet scaffolded"]
    found = False
    where = None
    for f in candidates:
        text = f.read_text(encoding="utf-8", errors="ignore")
        if "1000" in text and ("BPS" in text or "bps" in text or "tithe" in text.lower()):
            found = True; where = f.relative_to(repo); break
    if not found:
        return False, [f"no 1000-bps tithe constant found in {len(candidates)} contract(s)"]
    return True, [f"1000-bps tithe constant present (e.g. {where})"]


def _check_anti_individualist(repo: Path) -> tuple[bool, list[str]]:
    """§1.3 — payoff attribution = etzhayyim, not individual contributor."""
    readme = repo / "README.md"
    if not readme.exists():
        return False, ["README.md missing"]
    body = readme.read_text(encoding="utf-8", errors="ignore")
    needed = ["etzhayyim", "Payoff attribution"]
    missing = [w for w in needed if w not in body]
    if missing:
        return False, [f"README.md missing required attribution token: {missing}"]
    return True, ["README.md asserts etzhayyim payoff attribution + decision-maker"]


def _check_substrate_boundary(repo: Path) -> tuple[bool, list[str]]:
    """§1.6 — substrate boundary: no fiat processor / no centralized DB in app code."""
    prohibited = [
        ("stripe.js",            "Stripe (fiat processor)"),
        ("@stripe/stripe-js",    "Stripe SDK"),
        ("paypal.com/sdk",       "PayPal"),
        ("@kysely/kysely",       "Kysely (centralized DB ORM)"),
    ]
    scan_roots = ["60-apps", "10-protocol", "20-actors"]
    pathspecs = [f"{r}/**/package.json" for r in scan_roots]
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "ls-files", "-z", "--", *pathspecs],
            capture_output=True, check=True, timeout=30,
        )
        files = [repo / p for p in out.stdout.decode("utf-8", errors="ignore").split("\0") if p]
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        files = []
        for root in scan_roots:
            rp = repo / root
            if not rp.is_dir():
                continue
            for f in rp.rglob("package.json"):
                if "node_modules" in f.parts or ".venv" in f.parts:
                    continue
                files.append(f)
    hits: list[str] = []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for needle, label in prohibited:
            if needle in text:
                hits.append(f"  {label} in {f.relative_to(repo)}")
    if hits:
        return False, ["substrate boundary violation in package.json dependencies:"] + hits[:10]
    return True, ["scanned package.json files — no prohibited fiat/DB processors"]


def _check_transparent_force(repo: Path) -> tuple[bool, list[str]]:
    """§1.12 + ADR-2605192315 — force is on-chain + open-source + 1 SBT = 1 vote."""
    rd = repo / "60-apps" / "etzhayyim-transparent-force-rd"
    if not rd.is_dir():
        return False, ["60-apps/etzhayyim-transparent-force-rd/ scaffold missing"]
    return True, ["transparent-force R&D registry scaffolded"]


# Per ADR-2605231525 — etzhayyim infrastructure holds zero signing
# capability. The 13 secret-bearing env vars enumerated in the ADR
# must not appear in any wrangler.jsonc / k8s manifest / docker-compose
# / GitHub Action that etzhayyim operates, with one exception: a file
# may opt into the `// no-server-key: read-only` exemption marker
# (anywhere on a comment line), in which case the check skips it.
_NO_SERVER_KEY_FORBIDDEN_ENV = [
    # Stage A — USDC signer
    "YATA_DONATE_PRIVATE_KEY",
    # Stage B — bulk-ingest community handover
    "DATABASE_URL",
    "B2_ACCESS_KEY_ID",
    "B2_SECRET_ACCESS_KEY",
    "MAPILLARY_ACCESS_TOKEN",
    "RUNPOD_API_KEY",
    "ODPT_API_KEY",
    "EMBED_AUTH_TOKEN",
    # Stage C — identity-signing devolution
    "SS_REPO_SIGNING_KEK",
    "AUTH_KEYS_KEK",
    # Stage D — external-API liability handover
    "RESEND_API_KEY",
    # Stage E — internal-HMAC dissolution
    "DISPATCHER_INTERNAL_SECRET",
    "YATA_AGENT_ADMIN_KEY",
]

_NO_SERVER_KEY_SCAN_GLOBS = (
    "**/wrangler.jsonc",
    "**/wrangler.toml",
    "**/wrangler.json",
    "**/k8s/**/*.yaml",
    "**/k8s/**/*.yml",
    "**/docker-compose*.yml",
    "**/docker-compose*.yaml",
    "**/.github/workflows/*.yml",
    "**/.github/workflows/*.yaml",
)

_NO_SERVER_KEY_EXEMPTION_MARKER = "no-server-key: read-only"


def _no_server_key_candidates(repo: Path) -> list[Path]:
    """Enumerate the files that `_check_no_server_key` must scan.

    Uses `git ls-files` first because it is **~100× faster** than
    `pathlib.Path.glob("**/…")` on this repo — pathlib walks every
    directory (including `node_modules/`, `target/`, `.svelte-kit/`,
    `dist/`, build caches) before filtering, whereas `git ls-files`
    reads the index and emits only tracked + staged files.

    On the operator workstation as of 2026-05-26 the pathlib path took
    ~116s; the git-index path takes <100ms. Pre-commit hook total drops
    from ~127s to ~11s — recovers safe hook usage during parallel-
    session monorepo work where `--no-verify` had become routine.

    Falls back to `pathlib.glob` when `git ls-files` is unavailable
    (bare tarball extract, non-git CI checkout); the slow path remains
    correct, just expensive.
    """
    # Patterns mirror _NO_SERVER_KEY_SCAN_GLOBS but in the dialect git
    # ls-files understands: it uses fnmatch-style globs and supports
    # multiple positional pathspecs.
    pathspecs = [
        "*wrangler.jsonc", "*wrangler.toml", "*wrangler.json",
        "**/k8s/**/*.yaml", "**/k8s/**/*.yml",
        "*docker-compose*.yml", "*docker-compose*.yaml",
        ".github/workflows/*.yml", ".github/workflows/*.yaml",
        "**/.github/workflows/*.yml", "**/.github/workflows/*.yaml",
    ]
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "ls-files", "-z", "--", *pathspecs],
            capture_output=True, check=True, timeout=30,
        )
        rel = [p for p in out.stdout.decode("utf-8", errors="ignore").split("\0") if p]
        return [repo / r for r in rel]
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        # Fallback: original pathlib glob path. Slow on monorepos but
        # works in non-git environments (bare tarball extract / CI).
        out_files: list[Path] = []
        for g in _NO_SERVER_KEY_SCAN_GLOBS:
            for f in repo.glob(g):
                parts = set(f.parts)
                if "node_modules" in parts or ".venv" in parts or ".git" in parts:
                    continue
                out_files.append(f)
        return out_files


def _check_no_server_key(repo: Path) -> tuple[bool, list[str]]:
    """ADR-2605231525 — etzhayyim-operated infrastructure must not hold
    any of the 13 server-side signing / master-credential env vars.

    Configuration files (wrangler.jsonc / k8s manifests / docker-compose /
    GitHub Actions) are scanned. A file containing the literal marker
    `no-server-key: read-only` anywhere on a comment line is exempted —
    use that to declare an entry as part of a documented Stage handover
    rollback window.
    """
    hits: list[str] = []
    exemptions = 0
    scanned = 0
    for f in _no_server_key_candidates(repo):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        scanned += 1
        if _NO_SERVER_KEY_EXEMPTION_MARKER in text:
            exemptions += 1
            continue
        for needle in _NO_SERVER_KEY_FORBIDDEN_ENV:
            if needle in text:
                hits.append(f"  {needle} in {f.relative_to(repo)}")
                if len(hits) >= 20:
                    break
        if len(hits) >= 20:
            break
    if hits:
        return False, [
            "ADR-2605231525 — server-side secrets present in operated infra:",
            *hits,
            f"  ({exemptions} file(s) exempted via 'no-server-key: read-only' marker)",
        ]
    return True, [
        f"scanned {scanned} file(s) via git ls-files; zero violations",
        f"({exemptions} file(s) exempted via marker)",
    ]


_CHECKS: list[tuple[str, str, callable]] = [
    ("non_profit_only",        "§1.5 — substrate boundary (no fiat processor in app code)", _check_substrate_boundary),
    ("no_advertising",         "§1.13 — third-party advertising prohibited",                 _check_no_advertising),
    ("tithe_ten_percent",      "§1.5 + ADR-2605192130 — 10% tithe constant",                 _check_tithe_ten_percent),
    ("land_inalienable",       "§1.11 + ADR-2605192245 — no transfer/burn/setOwner",         _check_land_inalienable),
    ("transparent_force",      "§1.12 + ADR-2605192315 — on-chain + open-source",            _check_transparent_force),
    ("non_eschatological",     "§1.15 — no Book of Revelation / no end-state",               _check_non_eschatological),
    ("anti_individualist",     "§1.3 — payoff attribution = etzhayyim",                      _check_anti_individualist),
    ("charter_rider_required", "ADR-2605192200 — first-party packages carry the Rider",     _check_charter_rider),
    ("no_server_key",          "ADR-2605231525 — operated infra holds zero signing keys",   _check_no_server_key),
]


def verify() -> dict[str, Any]:
    """Scan all constitutional hard invariants. Read-only.

    Checks are independent and I/O-bound (each spawns a `git grep`
    subprocess), so we run them in parallel via a thread pool. The
    GIL is released for the duration of subprocess.run, so threads
    overlap effectively.

    Sequential wall time (iter-55 baseline): ~2.3s on dev box.
    Parallel wall time: ~1.3s (bounded by the slowest check
    `no_advertising` at ~970ms).
    """
    repo = _repo_root()

    def _run_one(item: tuple[str, str, Any]) -> dict[str, Any]:
        key, desc, fn = item
        try:
            passed, evidence = fn(repo)
        except Exception as exc:
            passed, evidence = False, [f"check raised: {exc!r}"]
        return {"key": key, "description": desc, "passed": passed, "evidence": evidence}

    with ThreadPoolExecutor(max_workers=len(_CHECKS)) as pool:
        # Preserve _CHECKS declaration order in the output (operator
        # expectations of the report layout). map() returns in submit
        # order, not completion order, which is exactly what we want.
        results = list(pool.map(_run_one, _CHECKS))

    n_pass = sum(1 for r in results if r["passed"])
    return {
        "ok": n_pass == len(results),
        "passed": n_pass,
        "total": len(results),
        "checks": results,
        "constitutional_anchor": "ADR-2605192100 §1 (mission charter, HARD_INVARIANTS)",
    }


# ── identity ──────────────────────────────────────────────────────────────

def about() -> dict[str, Any]:
    """Religious-corp identity summary — what etzhayyim is, where the canon lives.

    Static, derived from CLAUDE.md / README.md / ADR-2605192100. Surfaces the
    constitutional anchor for any new operator/agent landing on the CLI.
    """
    from . import __version__ as e7m_version
    return {
        "ok": True,
        "entity": "etzhayyim",
        "aliases": [
            "amanomibashira", "天御柱", "עץ חיים (Tree of Life)",
            "etz hayim", "etzhayim", "etz chaim", "エツ・ハイム",
        ],
        "form": "宗教法人 (任意団体 / unincorporated religious voluntary association)",
        "registry": "On-chain (blockchain-registered constitution and member roster)",
        "did": "did:web:etzhayyim.com",
        "domain": "https://etzhayyim.com",
        "license": "Apache 2.0 + etzhayyim Charter Compliance Rider v2.0",
        "mission": (
            "人類の構造的労働解放を最終目的とする宗教法人。"
            "多世代 (子・孫) priority + Wellbecoming (動的軌跡) + 反個人主義 ontology。"
            "日本的価値観 (八百万 / 縁起 / 産霊 / 和 / 無教会) + Protestant Christianity "
            "(Sola Scriptura / 万人祭司 / Reformed Just War / Tree of Life) の synthetic religion。"
            "非終末論 (黙示録/啓示の書は正典外、千年王国・末法・Rapture 否定)。"
        ),
        "constitutional_adrs": [
            "ADR-2605192100 — Mission Charter (上位憲章)",
            "ADR-2605192115 — Non-profit, donation-only, no ads",
            "ADR-2605192130 — 10% Tithe Redistribution",
            "ADR-2605192200 — IP-free release + Charter Rider v2.0",
            "ADR-2605192245 — Global Land Sovereignty (4-layer trust)",
            "ADR-2605192300 — Bootstrap Council (5 seats)",
            "ADR-2605192315 — Transparent Religious Force",
            "ADR-2605221411 — Artificial Organism Ecosystem (runtime)",
        ],
        "operator_surfaces": {
            "human_cli":  "e7m",
            "agent_mcp":  "e7m-mcp (stdio JSON-RPC, .claude/mcp.json)",
            "dashboard":  "http://127.0.0.1:8081/",
            "constitutional_self_check": "e7m verify",
        },
        "doctrinal_invariants_count": 8,
        "e7m_version": e7m_version,
        "note": "Per ADR-2605192100 §1.3, payoff attribution = etzhayyim. Decisions are operator gestures.",
    }


# ── connectivity ──────────────────────────────────────────────────────────

def ping() -> dict[str, Any]:
    ok, where = api.reachable()
    return {"ok": ok, "where": where}


# ── doctor — combined health rollup ──────────────────────────────────────

def doctor() -> dict[str, Any]:
    """Rollup: ping + verify + status + pod status. One call, overall verdict.

    Used by the operator (or other agent via MCP) as a single
    "is everything healthy right now?" check. Useful pre-PR and pre-deploy.
    """
    sections: dict[str, Any] = {}

    # 1. connectivity
    sections["ping"] = ping()

    # 2. constitutional invariants (filesystem only — works even if viz is down)
    sections["verify"] = verify()

    # 3. aliveness 5-tuple — requires viz pod reachable
    if sections["ping"].get("ok"):
        try:
            sections["status"] = status()
        except Exception as exc:
            sections["status"] = {"ok": False, "error": str(exc)}
    else:
        sections["status"] = {"ok": False, "error": "viz pod unreachable; status skipped"}

    # 4. pod liveness
    sections["pods"] = pod_status()

    # overall verdict — every section must be ok
    overall_ok = all(s.get("ok", False) for s in sections.values())

    # one-line summary per section
    summary_lines: list[str] = []
    p = sections["ping"]
    summary_lines.append(f"  {'✓' if p['ok'] else '✗'} ping            — {p.get('where','')}")
    v = sections["verify"]
    summary_lines.append(f"  {'✓' if v['ok'] else '✗'} verify          — {v['passed']}/{v['total']} constitutional invariants")
    s = sections["status"]
    if s.get("ok"):
        a = s["aliveness"]
        ic = s["in_band_count"]
        summary_lines.append(
            f"  {'✓' if ic == 5 else '⚠'} aliveness       — "
            f"M={a['M']:.2f} D={a['D']:.2f} C={a['C']:.2f} P={a['P']:.2f} G={a['G']:.2f} "
            f"({ic}/5 in band)"
        )
    else:
        summary_lines.append(f"  ✗ aliveness       — {s.get('error', 'unknown')}")
    pods = sections["pods"]
    if pods.get("ok"):
        rdy = sum(1 for p in pods["pods"] if p["ready"])
        tot = len(pods["pods"])
        summary_lines.append(f"  {'✓' if rdy == tot else '⚠'} pods            — {rdy}/{tot} ready")
        for p in pods["pods"]:
            mark = "●" if p["ready"] else "○"
            summary_lines.append(f"      {mark} {p['name']:50s}  restarts={p['restarts']}")
    else:
        summary_lines.append(f"  ✗ pods            — {pods.get('error', 'unknown')}")

    return {
        "ok": overall_ok,
        "summary_lines": summary_lines,
        "sections": sections,
    }
