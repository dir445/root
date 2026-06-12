"""HTTP client for the etzhayyim viz pod — single chokepoint to the organism.

Defaults to http://127.0.0.1:8081 (port-forward from etzhayyim-organism
namespace). Override with E7M_VIZ_URL.
"""

from __future__ import annotations

import os
from typing import Any

import httpx


VIZ_URL = os.environ.get("E7M_VIZ_URL", "http://127.0.0.1:8081").rstrip("/")
# Lightweight endpoints (healthz, ping): fast 10s fence.
TIMEOUT = float(os.environ.get("E7M_TIMEOUT", "10"))
# Heavy endpoints (state/pruning scan all entities; chat waits on Murakumo LLM inference).
HEAVY_TIMEOUT = float(os.environ.get("E7M_HEAVY_TIMEOUT", "120"))


class E7mError(RuntimeError):
    pass


def _client(timeout: float = TIMEOUT) -> httpx.Client:
    return httpx.Client(base_url=VIZ_URL, timeout=timeout, headers={"User-Agent": "e7m-cli/0.1"})


def healthz() -> dict[str, Any]:
    with _client() as c:
        r = c.get("/api/healthz")
        r.raise_for_status()
        return r.json()


def state() -> dict[str, Any]:
    with _client(HEAVY_TIMEOUT) as c:
        r = c.get("/api/state")
        r.raise_for_status()
        return r.json()


def chat(entity_id: str, message: str) -> dict[str, Any]:
    with _client(HEAVY_TIMEOUT) as c:
        r = c.post("/api/chat", json={"entity_id": entity_id, "message": message})
        r.raise_for_status()
        return r.json()


def pruning() -> dict[str, Any]:
    with _client(HEAVY_TIMEOUT) as c:
        r = c.get("/api/pruning")
        r.raise_for_status()
        return r.json()


def reachable() -> tuple[bool, str]:
    try:
        h = healthz()
        return bool(h.get("ok")), VIZ_URL
    except Exception as exc:
        return False, f"{VIZ_URL}: {exc!r}"
