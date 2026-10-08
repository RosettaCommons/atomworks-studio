"""Conformance checks for mask/group-only internal-coordinate authoring."""

from pathlib import Path

import numpy as np
import pytest
from annotation_studio.core import StudioDocument
from atomworks.ml.conditions import C_CRD
from atomworks_studio_editing.mutations import set_condition_mask
from atomworks_studio_rfd4 import CONDITION_PROVIDER, VALIDATION_PROVIDER
from atomworks_studio_rfd4.internal_coordinate import set_internal_coordinate_conditioning
from atomworks_studio_rfd4.model import C_CRDGRP, C_INTCRD

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"


def _array():
    document = StudioDocument.from_cif(
        FIXTURE.read_text(),
        FIXTURE.stem,
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )
    return document.array


def test_internal_coordinate_authoring_sets_masks_and_group_only() -> None:
    array = _array()
    resolved = np.flatnonzero(np.isfinite(array.coord).all(axis=1))
    selected = resolved[: min(8, len(resolved))]
    assert len(selected) > 1

    original_coords = array.coord.copy()
    absolute_mask = np.zeros(len(array), dtype=bool)
    absolute_mask[selected] = True
    set_condition_mask(array, C_CRD, selected, True)
    previous_groups = C_CRDGRP.annotation(array, default="generate").copy()

    assert not C_INTCRD.has_annotation(array)
    set_internal_coordinate_conditioning(array, selected, True)

    assert not C_CRD.mask(array)[selected].any()
    assert np.isnan(C_CRD.annotation(array)[selected]).all()
    membership = C_CRDGRP.is_internal(array) if hasattr(C_CRDGRP, "is_internal") else C_INTCRD.mask(array)
    assert membership[selected].all()

    groups = C_CRDGRP.annotation(array)
    assert np.unique(groups[selected]).size == 1
    assert groups[selected[0]] > previous_groups.max()

    assert not C_INTCRD.has_annotation(array), "Studio must leave value materialization to RFD4 featurization"
    np.testing.assert_array_equal(array.coord, original_coords)

    set_internal_coordinate_conditioning(array, selected, False)
    assert not C_INTCRD.mask(array)[selected].any()
    assert (C_CRDGRP.annotation(array)[selected] == C_CRDGRP.UNKNOWN_COORDS).all()


def test_internal_coordinate_authoring_rejects_a_fully_unresolved_selection() -> None:
    array = _array()
    selected = np.array([0, 1])
    array.coord[selected] = np.nan

    with pytest.raises(ValueError, match="no selected atoms have resolved coordinates"):
        set_internal_coordinate_conditioning(array, selected, True)
