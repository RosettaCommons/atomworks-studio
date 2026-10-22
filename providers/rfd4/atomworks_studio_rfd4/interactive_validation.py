"""Annotation diagnostics shared by all Studio interfaces."""

from atomworks.io.utils.atom_array_plus import AtomArrayPlus

from atomworks_studio_rfd4.sequence_probability import (
    SEQUENCE_PROBABILITY_CONDITIONS,
    canonicalize_sequence_probabilities,
    check_sequence_probability_conditioning_violations,
)


def validate_rfd4(array: AtomArrayPlus, *, full_pipeline: bool = False) -> list[dict[str, str]]:
    """Check annotation values without running the RFD4 model pipeline."""
    del full_pipeline  # Studio validates editing semantics, not model inference.
    if not SEQUENCE_PROBABILITY_CONDITIONS:
        return []
    # Mirror the model's order: exact C_SEQ identities are canonicalized before the invariants run.
    try:
        candidate = canonicalize_sequence_probabilities({"atom_array": array.copy()})["atom_array"]
    except ValueError as error:
        return [{"severity": "error", "check": "sequence_probability_conflicts_with_c_seq", "message": str(error)}]
    return [
        {"severity": "error", "check": violation.check, "message": violation.message}
        for violation in check_sequence_probability_conditioning_violations(candidate)
    ]
