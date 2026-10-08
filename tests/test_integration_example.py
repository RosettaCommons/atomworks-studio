"""The documented headless entry point must preserve real annotation values."""

from pathlib import Path
from runpy import run_path

import numpy as np
import pytest
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.providers import load_providers

ROOT = Path(__file__).resolve().parents[1]
annotate = run_path(str(ROOT / "examples/annotate.py"))["annotate"]


@pytest.mark.parametrize(
    "fixture",
    ["packages/api/annotation_studio/examples/protein_binder.cif", "examples/mcsa_ph2.cif", "examples/disco_iai.cif"],
)
def test_headless_example_preserves_structure_and_condition(fixture):
    cif = (ROOT / fixture).read_text()
    providers = load_providers()
    kwargs = {"condition_provider": providers.condition_provider, "validation_provider": providers.validation_provider}
    before = StudioDocument.from_cif(cif, **kwargs)
    selected = before.query_indices("atom_id == 1").tolist()
    assert selected
    after = StudioDocument.from_cif(annotate(cif, "atom_id == 1", "hotspot"), **kwargs)
    np.testing.assert_allclose(after.array.coord, before.array.coord, atol=0.001, equal_nan=True)
    for category in ("atom_name", "element", "chain_id", "res_id"):
        np.testing.assert_array_equal(after.array.get_annotation(category), before.array.get_annotation(category))
    assert set(selected) <= set(after.annotation_details("hotspot")[0]["values"][0]["atom_indices"])


def test_headless_example_rejects_empty_selection():
    with pytest.raises(ValueError, match="selected no atoms"):
        annotate((ROOT / "examples/mcsa_ph2.cif").read_text(), "atom_id < 0")
