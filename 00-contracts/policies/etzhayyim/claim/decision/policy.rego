package etzhayyim.claim.decision

# Claim dispute arbiter — V1 policy (ADR-2604261717 Phase 2-B)
#
# Called by rego-arbiter-settler after reading on-chain claim state and
# fetching evidence from IPFS. The settler posts:
#
#   POST /v1/data/etzhayyim/claim/decision
#   { "input": {
#       "claimId":    "0x…",        // bytes32
#       "claimant":   "0x…",        // address
#       "challenger":  "0x…",        // address
#       "bond":        "1000000000000000000",  // bigint as string (wei)
#       "counterBond": "500000000000000000",   // bigint as string (wei)
#       "evidenceCid": "0x…",        // bytes32 (zero = no evidence)
#       "evidence":    { … } | null  // JSON fetched from IPFS; null if unreachable
#   }}
#
# Decision rules (V1 — minimal substantiation bar):
#   CLAIMANT WINS  — evidence CID is non-zero AND the evidence bundle contains
#                    a substantive statement plus a structured attestation
#                    envelope (claimant DID / signature / content hash).
#   CHALLENGER WINS — any other case: no CID, unreachable IPFS, or evidence
#                    JSON is missing the statement or the attestation envelope.
#
# This policy is deliberately conservative: a challenger who puts up a
# counter-bond wins by default unless the claimant can produce real content.
# Phase 2 will extend this with full DID verification and content classifiers.

default wins := false
default reason := "challenger-wins-default"

# ── Evidence helpers ──────────────────────────────────────────────────────────

_zero_cid if {
    input.evidenceCid == "0x0000000000000000000000000000000000000000000000000000000000000000"
}

_evidence_present if {
    input.evidence != null
    is_object(input.evidence)
}

_evidence_has_statement if {
    _evidence_present
    is_string(input.evidence.statement)
    count(input.evidence.statement) > 10
}

_evidence_has_attestation if {
    _evidence_present
    is_object(input.evidence.attestation)
    is_string(input.evidence.attestation.claimantDid)
    count(input.evidence.attestation.claimantDid) > 0
    is_string(input.evidence.attestation.signature)
    count(input.evidence.attestation.signature) > 0
    is_string(input.evidence.attestation.contentHash)
    count(input.evidence.attestation.contentHash) > 0
}

_evidence_substantiated if {
    _evidence_has_statement
    _evidence_has_attestation
}

# ── Decision ─────────────────────────────────────────────────────────────────

wins if {
    not _zero_cid
    _evidence_substantiated
}

# ── Reason ───────────────────────────────────────────────────────────────────

reason := "evidence-valid" if {
    wins
}

reason := "no-evidence-cid" if {
    not wins
    _zero_cid
}

reason := "evidence-unreachable" if {
    not wins
    not _zero_cid
    not _evidence_present
}

reason := "evidence-missing-statement" if {
    not wins
    not _zero_cid
    _evidence_present
    not _evidence_has_statement
}

reason := "evidence-missing-attestation" if {
    not wins
    not _zero_cid
    _evidence_present
    _evidence_has_statement
    not _evidence_has_attestation
}

# ── Top-level result consumed by the settler ──────────────────────────────────

decision := {
    "wins":   wins,
    "reason": reason,
}
