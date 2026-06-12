"""e7m CLI — operator's quick-check surface for the etzhayyim organism.

Usage:
    e7m status                          # aliveness 5-tuple + axes (compact)
    e7m state                           # full snapshot as JSON
    e7m entities [--kind axis|cell|...]
    e7m chat <entity-id> <message>
    e7m prune                           # candidates the operator should review
    e7m viz [open]                      # print URL / open in browser
    e7m pod status | logs [name] [--tail N]
    e7m tick                            # one manual CNS tick
    e7m ping
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from . import commands as cmd

# `rich` powers the pretty TTY renderings only. The machine paths — every
# `--json` command and, above all, the constitutional `verify` invoked by the
# pre-commit hook (`python3 -m e7m --json verify`) — MUST run on a bare stdlib
# python3 with no third-party deps (ADR-2606061500: the hook is the canonical
# kotoba-premised invariant gate and may not be silently skipped just because
# `rich` is absent on a workstation). So import rich lazily and degrade to JSON
# when it is missing.
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text

    console = Console()
except ModuleNotFoundError:  # pragma: no cover - stdlib-only fallback path
    Console = Panel = Table = Text = None  # type: ignore[assignment,misc]
    console = None  # type: ignore[assignment]


def _emit(payload: Any, as_json: bool) -> None:
    if as_json:
        json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")


def cmd_status(args) -> int:
    out = cmd.status()
    if args.json:
        _emit(out, True); return 0 if out.get("ok") else 1
    if not out.get("ok"):
        msg = out.get("error", "unknown error")
        hint = out.get("hint", "")
        if console:
            console.print(f"[bold red]✗[/] status unavailable: {msg}")
            if hint:
                console.print(f"  [dim]{hint}[/]")
        else:
            print(f"✗ status unavailable: {msg}", file=sys.stderr)
            if hint:
                print(f"  {hint}", file=sys.stderr)
        return 1
    a = out["aliveness"]
    bands = out["in_band"]
    tbl = Table(show_header=True, header_style="bold", box=None, padding=(0, 2))
    tbl.add_column("dim", style="bold")
    tbl.add_column("value", justify="right")
    tbl.add_column("band", justify="center")
    for k in ("M", "D", "C", "P", "G"):
        mark = "[#3aa55c]●[/]" if bands.get(k) else "[#a05050]○[/]"
        tbl.add_row(k, f"{a[k]:.3f}", mark)
    console.print(Panel(tbl, title=f"[bold]aliveness[/]   in-band {out['in_band_count']}/5",
                        subtitle=str(out["timestamp"]), border_style="#9a7b2a"))
    # axes
    ax = out.get("axis_scores", {})
    axtbl = Table(show_header=True, header_style="bold", box=None, padding=(0, 2))
    axtbl.add_column("axis", style="bold")
    axtbl.add_column("score", justify="right")
    for k, v in ax.items():
        color = "#3aa55c" if v >= 8 else ("#9a7b2a" if v >= 5 else "#a05050")
        axtbl.add_row(k, f"[{color}]{v}/10[/]")
    console.print(Panel(axtbl, title="axes", border_style="#9a7b2a"))
    console.print(f"entities: [bold]{out['entity_count']}[/] · flowers: {len(out['flowers'])} · fruits: {len(out['fruits'])}")
    return 0


def cmd_state(args) -> int:
    _emit(cmd.full_state(), True)
    return 0


def cmd_entities(args) -> int:
    out = cmd.entities(args.kind)
    if args.json:
        _emit(out, True); return 0
    tbl = Table(show_header=True, header_style="bold", box=None, padding=(0, 2))
    tbl.add_column("id"); tbl.add_column("kind"); tbl.add_column("title"); tbl.add_column("nbrs", justify="right")
    for e in out["entities"]:
        tbl.add_row(e["id"], e["kind"], e["title"], str(len(e["neighbors"])))
    console.print(tbl)
    console.print(f"[#6e6a5e]{out['count']} entities[/]")
    return 0


def cmd_chat(args) -> int:
    out = cmd.chat(args.entity_id, " ".join(args.message))
    if args.json:
        _emit(out, True); return 0
    if not out.get("ok"):
        console.print(f"[#a05050]✗ {out.get('error', 'unknown error')}[/]")
        return 1
    console.print(Panel(
        Text(out["voice"], style="default"),
        title=f"[bold]{out['entity']}[/]  ←  [italic]{out['intent']}[/]",
        border_style="#b9322f",
    ))
    return 0


def cmd_prune(args) -> int:
    sub = getattr(args, "action", None) or "list"
    if sub == "list":
        return _cmd_prune_list(args)
    if sub == "show":
        return _cmd_prune_show(args)
    if sub == "approve":
        return _cmd_prune_approve(args)
    console.print(f"[#a05050]unknown prune action: {sub}[/]")
    return 1


def _cmd_prune_list(args) -> int:
    out = cmd.prune_candidates()
    if args.json: _emit(out, True); return 0
    cands = out.get("candidates", [])
    if not cands:
        console.print(Panel("剪定候補なし — 盆栽は overgrowth なく成長中。", border_style="#3aa55c"))
        return 0
    tbl = Table(show_header=True, header_style="bold", box=None, padding=(0, 2))
    tbl.add_column("sev", justify="right"); tbl.add_column("id")
    tbl.add_column("idle", justify="right"); tbl.add_column("reasons")
    for c in cands[:50]:
        color = ["#9a7b2a", "#7a2535", "#a01010"][min(c["severity"]-1, 2)]
        tbl.add_row(f"[{color}]{'■'*c['severity']}[/]", c["id"],
                    f"{c['idle_days']}日", "; ".join(c["reasons"]))
    console.print(tbl)
    console.print(f"[#6e6a5e]{len(cands)} candidates · daemon never prunes — operator decides[/]")
    return 0


def _cmd_prune_show(args) -> int:
    if not args.entity_id:
        console.print("[#a05050]missing entity_id[/]"); return 2
    out = cmd.prune_show(args.entity_id)
    if args.json: _emit(out, True); return 0
    if not out.get("ok"):
        console.print(f"[#a05050]✗ {out.get('error')}[/]"); return 1
    console.print(Panel(
        f"[bold]{out['title']}[/]\n"
        f"kind: {out['kind']}\n"
        f"neighbors: {', '.join(out['neighbors'][:6])}{' …' if len(out['neighbors'])>6 else ''}\n\n"
        f"state:\n{json.dumps(out['state'], indent=2, ensure_ascii=False)}\n\n"
        f"candidate: {json.dumps(out.get('candidate'), indent=2, ensure_ascii=False)}",
        title=out["entity_id"], border_style="#9a7b2a",
    ))
    return 0


def _cmd_prune_approve(args) -> int:
    if not args.entity_id:
        console.print("[#a05050]missing entity_id[/]"); return 2
    out = cmd.prune_approve(args.entity_id, dry_run=args.dry_run)
    if args.json: _emit(out, True); return 0
    if not out.get("ok"):
        console.print(f"[#a05050]✗ {out.get('error')}[/]"); return 1
    if out.get("dry_run"):
        plan = out["plan"]
        console.print(Panel(
            f"[bold]DRY RUN — no changes made[/]\n\n"
            f"branch:      {plan['branch']}\n"
            f"ADR draft:   {plan['adr_path']}\n"
            f"will delete: {plan['delete_path']}\n"
            f"operator:    {plan['operator']}\n"
            f"reasons:     {'; '.join(plan['reasons'])}\n\n"
            f"Run without --dry-run to execute.",
            title="prune plan", border_style="#9a7b2a",
        ))
        return 0
    console.print(Panel(
        f"[bold]✓ pruned[/]\n\n"
        f"branch:    {out['branch']}\n"
        f"commit:    {out['commit']}\n"
        f"ADR:       {out['adr_path']}\n"
        f"deleted:   {out['deleted_path']}\n\n"
        f"[#6e6a5e]next steps:[/]\n" +
        "\n".join(f"  · {s}" for s in out["next_steps"]),
        title="prune approved", border_style="#3aa55c",
    ))
    return 0


def cmd_viz(args) -> int:
    out = cmd.viz_url()
    url = out["url"]
    if args.open:
        import subprocess as _sp
        try:
            _sp.run(["open", url], check=False)
        except Exception:
            pass
    if args.json:
        _emit(out, True); return 0
    console.print(f"[bold]viz:[/] {url}")
    return 0


def cmd_pod(args) -> int:
    if args.action == "status":
        out = cmd.pod_status()
        if args.json: _emit(out, True); return 0
        if not out.get("ok"):
            console.print(f"[#a05050]✗ {out.get('error')}[/]"); return 1
        tbl = Table(show_header=True, header_style="bold", box=None, padding=(0, 2))
        tbl.add_column("pod"); tbl.add_column("phase"); tbl.add_column("ready"); tbl.add_column("restarts", justify="right")
        for p in out["pods"]:
            ready = "[#3aa55c]●[/]" if p["ready"] else "[#a05050]○[/]"
            tbl.add_row(p["name"], p["phase"], ready, str(p["restarts"]))
        console.print(tbl)
        return 0
    if args.action == "logs":
        out = cmd.pod_logs(args.name or "etzhayyim-organism", args.tail)
        if args.json: _emit(out, True); return 0
        if not out.get("ok"):
            console.print(f"[#a05050]✗ {out.get('error')}[/]"); return 1
        console.print(Panel(out["logs"], title=f"[bold]{out['deployment']}[/]  tail={out['tail']}",
                            border_style="#9a7b2a"))
        return 0
    return 1


def cmd_tick(args) -> int:
    out = cmd.tick()
    if args.json: _emit(out, True); return 0
    if not out.get("ok"):
        console.print(f"[#a05050]✗ {out.get('error')}[/]"); return 1
    console.print(Panel(out["log"], title="CNS tick", border_style="#b9322f"))
    return 0


def cmd_members(args) -> int:
    out = cmd.members()
    if args.json: _emit(out, True); return 0
    rows = out.get("members", [])
    if not rows:
        console.print(Panel(
            "信者なし — 起動以来まだ on-chain join() なし。\n"
            "ADR-2605172600 の手順を経て最初の member を待つ段階。",
            title="MEMBERS.md", border_style="#b9322f"))
        return 0
    tbl = Table(show_header=True, header_style="bold", box=None, padding=(0, 2))
    for h in (next(iter(rows)).keys()):
        tbl.add_column(h or " ")
    for r in rows:
        tbl.add_row(*[r.get(h, "") for h in r.keys()])
    console.print(tbl)
    console.print(f"[#6e6a5e]{out['count']} 信者 · {out['note']}[/]")
    return 0


def cmd_lands(args) -> int:
    out = cmd.lands()
    if args.json: _emit(out, True); return 0
    rows = out.get("lands", [])
    if not rows:
        console.print(Panel(
            "護持地なし — まだ donate() されていない。\n"
            "ADR-2605192245 の 4-layer 手順を経た最初の土地寄進を待つ段階。",
            title="LANDS.md", border_style="#5e4520"))
        return 0
    tbl = Table(show_header=True, header_style="bold", box=None, padding=(0, 2))
    for h in next(iter(rows)).keys():
        tbl.add_column(h or " ")
    for r in rows:
        tbl.add_row(*[r.get(h, "") for h in r.keys()])
    console.print(tbl)
    console.print(f"[#6e6a5e]{out['count']} 護持地 · {out['note']}[/]")
    return 0


def cmd_verify(args) -> int:
    out = cmd.verify()
    if args.json: _emit(out, True); return 0 if out["ok"] else 1
    if console is None:  # rich-less workstation → plain machine output
        _emit(out, True); return 0 if out["ok"] else 1
    tbl = Table(show_header=True, header_style="bold", box=None, padding=(0, 2))
    tbl.add_column("invariant"); tbl.add_column("pass", justify="center"); tbl.add_column("description")
    for c in out["checks"]:
        mark = "[#3aa55c]●[/]" if c["passed"] else "[#a05050]○[/]"
        tbl.add_row(c["key"], mark, c["description"])
    console.print(tbl)
    # show evidence for any failures
    failed = [c for c in out["checks"] if not c["passed"]]
    if failed:
        console.print()
        for c in failed:
            console.print(Panel(
                "\n".join(c["evidence"]),
                title=f"[#a05050]✗ {c['key']}[/]",
                border_style="#a05050",
            ))
    summary_color = "#3aa55c" if out["ok"] else "#a05050"
    console.print(f"\n[{summary_color}]{out['passed']}/{out['total']} constitutional invariants verified[/]"
                  f" · anchor: {out['constitutional_anchor']}")
    return 0 if out["ok"] else 1


def cmd_about(args) -> int:
    out = cmd.about()
    if args.json: _emit(out, True); return 0
    lines: list[str] = []
    lines.append(f"[bold]{out['entity']}[/]   {' · '.join(out['aliases'][:4])}")
    lines.append(f"  form:     {out['form']}")
    lines.append(f"  DID:      {out['did']}")
    lines.append(f"  domain:   {out['domain']}")
    lines.append(f"  license:  {out['license']}")
    lines.append("")
    lines.append("[bold]mission[/]")
    # wrap mission text
    mission = out["mission"]
    for chunk in [mission[i:i+72] for i in range(0, len(mission), 72)]:
        lines.append(f"  {chunk}")
    lines.append("")
    lines.append("[bold]constitutional ADRs[/]")
    for a in out["constitutional_adrs"]:
        lines.append(f"  · {a}")
    lines.append("")
    lines.append("[bold]operator surfaces[/]")
    for k, v in out["operator_surfaces"].items():
        lines.append(f"  {k:30s} {v}")
    lines.append("")
    lines.append(f"[#6e6a5e]{out['doctrinal_invariants_count']} hard invariants enforced via `e7m verify` · e7m v{out['e7m_version']}[/]")
    lines.append(f"[#6e6a5e]{out['note']}[/]")
    console.print(Panel("\n".join(lines), border_style="#b9322f"))
    return 0


def cmd_doctor(args) -> int:
    out = cmd.doctor()
    if args.json: _emit(out, True); return 0 if out["ok"] else 1
    color = "#3aa55c" if out["ok"] else "#a05050"
    title = "[bold]etzhayyim doctor[/]   " + ("[#3aa55c]all green[/]" if out["ok"] else "[#a05050]attention needed[/]")
    console.print(Panel("\n".join(out["summary_lines"]), title=title, border_style=color))
    return 0 if out["ok"] else 1


def cmd_ping(args) -> int:
    out = cmd.ping()
    if args.json: _emit(out, True); return 0
    mark = "[#3aa55c]●[/]" if out["ok"] else "[#a05050]○[/]"
    console.print(f"{mark} {out['where']}")
    return 0 if out["ok"] else 2


def _parse_json_arg(raw: str | None, flag: str) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        out = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"{flag}: invalid JSON — {exc}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(out, dict):
        print(f"{flag}: expected JSON object, got {type(out).__name__}", file=sys.stderr)
        sys.exit(2)
    return out


def cmd_pds(args) -> int:
    a = args.action
    if a == "describe-server":
        out = cmd.pds_describe_server(host=args.host)
    elif a == "list-repos":
        out = cmd.pds_list_repos(host=args.host, limit=args.limit, cursor=args.cursor)
    elif a == "describe-repo":
        if not args.target:
            print("e7m pds describe-repo <did> --host <host>", file=sys.stderr)
            return 2
        out = cmd.pds_describe_repo(args.target, host=args.host)
    elif a == "resolve-handle":
        if not args.target:
            print("e7m pds resolve-handle <handle> --host <host>", file=sys.stderr)
            return 2
        out = cmd.pds_resolve_handle(args.target, host=args.host)
    elif a == "xrpc":
        if not args.target:
            print("e7m pds xrpc <nsid> [--method GET|POST] [--params JSON] [--body JSON]", file=sys.stderr)
            return 2
        out = cmd.pds_xrpc(
            args.target,
            method=args.method,
            host=args.host,
            params=_parse_json_arg(args.params, "--params"),
            body=_parse_json_arg(args.body, "--body"),
            bearer=args.bearer,
            allow_write=args.allow_write,
        )
    elif a == "create-account":
        if not args.handle:
            print("e7m pds create-account --handle <h> --host <host> [--did ...] [--invite ...]", file=sys.stderr)
            return 2
        out = cmd.pds_create_account(
            host=args.host,
            handle=args.handle,
            did=args.did,
            email=args.email,
            invite_code=args.invite,
            password=args.password,
        )
    else:
        print(f"unknown action: {a}", file=sys.stderr)
        return 2
    _emit(out, args.json)
    return 0 if out.get("ok") else 1


def cmd_yoro(args) -> int:
    if args.action == "probe":
        out = cmd.yoro_probe()
    else:
        print(f"unknown action: {args.action}", file=sys.stderr)
        return 2
    _emit(out, args.json)
    return 0 if out.get("ok") else 1


def main() -> int:
    p = argparse.ArgumentParser(prog="e7m", description="etzhayyim operator surface")
    p.add_argument("--json", action="store_true", help="machine-readable JSON output")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="aliveness + axis snapshot").set_defaults(func=cmd_status)
    sub.add_parser("state",  help="full state JSON dump").set_defaults(func=cmd_state)

    ps = sub.add_parser("entities", help="list entities")
    ps.add_argument("--kind", help="filter (axis|cell|app|adr|fruit|seed|organism|ecosystem)")
    ps.set_defaults(func=cmd_entities)

    pc = sub.add_parser("chat", help="speak with a life")
    pc.add_argument("entity_id"); pc.add_argument("message", nargs="+")
    pc.set_defaults(func=cmd_chat)

    pr = sub.add_parser("prune", help="bonsai 剪定 — list candidates / approve cuts")
    pr.add_argument("action", nargs="?", default="list",
                    choices=["list", "show", "approve"])
    pr.add_argument("entity_id", nargs="?", help="entity id for show/approve")
    pr.add_argument("--dry-run", action="store_true", help="approve only: print plan, don't execute")
    pr.set_defaults(func=cmd_prune)

    pv = sub.add_parser("viz", help="dashboard URL"); pv.add_argument("open", nargs="?", help="open in browser")
    pv.set_defaults(func=lambda a: cmd_viz(argparse.Namespace(json=a.json, open=(a.open=="open"))))

    pp = sub.add_parser("pod", help="pod control")
    pp.add_argument("action", choices=["status", "logs"])
    pp.add_argument("name", nargs="?")
    pp.add_argument("--tail", type=int, default=50)
    pp.set_defaults(func=cmd_pod)

    sub.add_parser("tick", help="fire one CNS tick").set_defaults(func=cmd_tick)

    pds = sub.add_parser("pds", help="PDS / XRPC introspection (atproto / pds / yoro / apex)")
    pds.add_argument(
        "action",
        choices=["describe-server", "list-repos", "describe-repo", "resolve-handle", "xrpc", "create-account"],
    )
    pds.add_argument("target", nargs="?", help="DID / handle / NSID depending on action")
    pds.add_argument("--host", default="atproto", help="host alias (atproto|pds|yoro|apex) or full URL")
    pds.add_argument("--limit", type=int, default=20)
    pds.add_argument("--cursor", default=None)
    pds.add_argument("--method", default="GET", choices=["GET", "POST"])
    pds.add_argument("--params", default=None, help="JSON params for xrpc GET")
    pds.add_argument("--body", default=None, help="JSON body for xrpc POST")
    pds.add_argument("--bearer", default=None, help="Authorization Bearer token")
    pds.add_argument("--allow-write", action="store_true", help="explicit acknowledgement for POST writes")
    pds.add_argument("--handle", default=None, help="create-account: account handle")
    pds.add_argument("--did", default=None, help="create-account: pre-existing DID")
    pds.add_argument("--email", default=None, help="create-account: contact email")
    pds.add_argument("--invite", default=None, help="create-account: PDS invite code")
    pds.add_argument("--password", default=None, help="create-account: initial password")
    pds.set_defaults(func=cmd_pds)

    py = sub.add_parser("yoro", help="yoro deployment probes (apex bundle + feed endpoints)")
    py.add_argument("action", choices=["probe"])
    py.set_defaults(func=cmd_yoro)
    sub.add_parser("members", help="信者 roster (MEMBERS.md)").set_defaults(func=cmd_members)
    sub.add_parser("lands",   help="護持地 registry (LANDS.md)").set_defaults(func=cmd_lands)
    sub.add_parser("verify",  help="scan 8 constitutional hard invariants").set_defaults(func=cmd_verify)
    sub.add_parser("doctor",  help="combined health rollup (ping + verify + status + pods)").set_defaults(func=cmd_doctor)
    sub.add_parser("about",   help="religious-corp identity + constitutional anchor").set_defaults(func=cmd_about)
    sub.add_parser("ping", help="check viz reachability").set_defaults(func=cmd_ping)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
