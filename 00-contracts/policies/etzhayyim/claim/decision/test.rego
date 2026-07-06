package etzhayyim.claim.decision

# ── fixtures ─────────────────────────────────────────────────────────────────

_cid_nonzero := "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab"
_cid_zero    := "0x0000000000000000000000000000000000000000000000000000000000000000"
_claimant    := "0xaaaa000000000000000000000000000000000001"
_challenger  := "0xbbbb000000000000000000000000000000000002"

_base_input := {
    "claimId":    "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    "claimant":   _claimant,
    "challenger": _challenger,
    "bond":       "1000000000000000000",
    "counterBond": "500000000000000000",
}

# ── claimant wins ─────────────────────────────────────────────────────────────

test_wins_when_evidence_valid if {
    wins with input as object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": {
            "statement": "The AI model produced a hallucination in case XYZ-123.",
            "attestation": {
                "claimantDid": "did:example:claimant",
                "signature": "ed25519:example-signature",
                "contentHash": "sha256:abc123",
            },
        },
    })
}

test_decision_wins_when_evidence_valid if {
    inp := object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": {
            "statement": "The AI model produced a hallucination in case XYZ-123.",
            "attestation": {
                "claimantDid": "did:example:claimant",
                "signature": "ed25519:example-signature",
                "contentHash": "sha256:abc123",
            },
        },
    })
    d := decision with input as inp
    d.wins == true
    d.reason == "evidence-valid"
}

test_challenger_wins_when_evidence_is_only_a_statement if {
    not wins with input as object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": { "statement": "The AI model produced a hallucination in case XYZ-123." },
    })
}

test_wins_when_structured_signed_evidence_is_present if {
    wins with input as object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": {
            "statement": "The AI model produced a hallucination in case XYZ-123.",
            "attestation": {
                "claimantDid": "did:example:claimant",
                "signature": "ed25519:example-signature",
                "contentHash": "sha256:abc123",
            },
        },
    })
}

# ── challenger wins: no CID ───────────────────────────────────────────────────

test_challenger_wins_no_cid if {
    not wins with input as object.union(_base_input, {
        "evidenceCid": _cid_zero,
        "evidence": null,
    })
}

test_reason_no_evidence_cid if {
    reason == "no-evidence-cid"
    with input as object.union(_base_input, {
        "evidenceCid": _cid_zero,
        "evidence": null,
    })
}

# ── challenger wins: IPFS unreachable ────────────────────────────────────────

test_challenger_wins_unreachable if {
    not wins with input as object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": null,
    })
}

test_reason_unreachable if {
    reason == "evidence-unreachable"
    with input as object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": null,
    })
}

# ── challenger wins: evidence missing statement ───────────────────────────────

test_challenger_wins_no_statement if {
    not wins with input as object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": { "type": "attestation" },
    })
}

test_reason_missing_statement if {
    reason == "evidence-missing-statement"
    with input as object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": { "type": "attestation" },
    })
}

# ── challenger wins: statement too short ─────────────────────────────────────

test_challenger_wins_short_statement if {
    not wins with input as object.union(_base_input, {
        "evidenceCid": _cid_nonzero,
        "evidence": { "statement": "short" },
    })
}
