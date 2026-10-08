"""Annotation diagnostics shared by all Studio interfaces."""

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus

from atomworks_studio_rfd4.model import C_HB, HBondEnum


def validate_rfd4(array: AtomArrayPlus, *, full_pipeline: bool = False) -> list[dict[str, str]]:
    """Check annotation values without running the RFD4 model pipeline."""
    del full_pipeline  # Studio validates editing semantics, not model inference.
    issues: list[dict[str, str]] = []
    hbond = C_HB.annotation(array, default="generate")
    if np.any(hbond == HBondEnum.BOTH):
        issues.append(
            {
                "severity": "error",
                "check": "hbond_both_not_supported",
                "message": "HBond BOTH is not currently supported by the model",
            }
        )
    return issues
