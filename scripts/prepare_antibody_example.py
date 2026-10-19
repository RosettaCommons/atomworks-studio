"""Prepare the HER2 CDR-H3 example with separate Ig rigid-body groups.

Matches the separate-Ig-groups, absolute-target variant of RFD4's
IgFrameworkConditioningTask. Existing CDR design, sequence, and index conditions
are retained; resolved fixed-framework atoms receive internal conditioning.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from atomworks.io.utils.io_utils import to_cif_file
from atomworks.ml.conditions import C_CRD, C_SEQ
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER, VALIDATION_PROVIDER
from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD


def prepare_antibody_example(source: Path, destination: Path) -> None:
    document = StudioDocument.from_cif(
        source.read_text(), condition_provider=CONDITION_PROVIDER, validation_provider=VALIDATION_PROVIDER
    )
    array = document.array
    if set(array.chain_id) != {"H", "L", "T"}:
        raise ValueError("Expected the HER2 example's H, L, and T chains")
    sequence = C_SEQ.mask(array, default="generate")
    free = ~sequence
    if set(zip(array.chain_id[free], array.res_id[free], strict=True)) != {("H", i) for i in range(99, 110)}:
        raise ValueError("Expected only H99-H109 to be sequence-designed")
    if np.isfinite(C_INTCRD.annotation(array, default="generate")).any():
        raise ValueError("Refusing to replace existing saved internal-coordinate targets")

    antibody = np.isin(array.chain_id, ["H", "L"])
    coordinates = C_CRD.annotation(array, default="generate").copy()
    coordinates[antibody] = np.nan
    C_CRD.set_annotation(array, coordinates)
    groups = C_CRDGRP.default_annotation(array)
    resolved_fixed = sequence & np.isfinite(array.coord).all(axis=1)
    for chain, group in (("H", 1), ("L", 2)):
        groups[(array.chain_id == chain) & resolved_fixed] = group
    C_CRDGRP.set_annotation(array, groups)

    issues = document.validate(full_pipeline=True)
    if issues:
        raise ValueError(issues)
    to_cif_file(array, destination, save_standard_annotations=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    prepare_antibody_example(args.source, args.destination)
