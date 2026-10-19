"""Import inference preserves annotations or completes atoms, never silently both."""

from io import StringIO
from pathlib import Path

import pytest
from annotation_studio.main import app, condition_provider
from atomworks.io.utils.io_utils import to_cif_file
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.loading import build_load_config, inspect_import
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).parent / "fixtures" / "minimal_multichain.cif"


@pytest.fixture
def annotated(tmp_path):
    document = StudioDocument.from_cif(FIXTURE.read_text(), condition_provider=condition_provider)
    document.set_condition("hotspot", [0])
    path = tmp_path / "annotated.cif"
    to_cif_file(document.array, path)
    return path


@pytest.mark.parametrize("complete", [False, True])
@pytest.mark.parametrize("saved", [False, True])
def test_inferred_preset_and_source_preserved(tmp_path, complete, saved):
    document = StudioDocument.from_cif(
        FIXTURE.read_text(),
        condition_provider=condition_provider,
        parse_options={
            "preset": "minimal",
            "advanced_options": {
                "load_standard_annotations": False,
                "add_missing_atoms": complete,
                "hydrogen_policy": "remove",
            },
        },
    )
    if saved:
        document.set_condition("hotspot", [0])
    path = tmp_path / "input.cif"
    to_cif_file(document.array, path)
    before = path.read_bytes()
    result = inspect_import(path)
    assert result["preset"] == ("rcsb" if not saved else "minimal" if complete else None)
    assert path.read_bytes() == before
    # Text-buffer uploads and filesystem imports use the same decision.
    assert inspect_import(StringIO(before.decode()), file_type="cif") == result


def test_inspection_cannot_silently_ignore_failure(monkeypatch, annotated):
    def fail(*args, **kwargs):
        raise ValueError("cannot complete this component")

    monkeypatch.setattr("atomworks_studio_editing.loading.parse", fail)
    result = inspect_import(annotated)
    assert result["preset"] is None
    assert "could not be checked" in result["message"]


def test_import_inspection_and_explicit_choices(annotated):
    client = TestClient(app)
    content = annotated.read_bytes()
    result = client.post("/api/v1/import/inspect", files={"file": ("input.cif", content)})
    assert result.status_code == 200, result.text
    assert result.json()["preset"] is None
    for preset in ["minimal", "rcsb"]:
        result = client.post("/api/v1/sessions", files={"file": ("input.cif", content)}, data={"parse_preset": preset})
        assert result.status_code == 200, result.text
        summary = result.json()["structure"]
        assert (summary["atom_count"] == 4) == (preset == "minimal")
        assert summary["condition_counts"].get("hotspot", 0) == (1 if preset == "minimal" else 0)


@pytest.mark.parametrize("changing_option", ["add_missing_atoms", "convert_mse_to_met"])
def test_manual_options_cannot_reindex_saved_annotations(changing_option):
    with pytest.raises(ValueError):
        build_load_config("minimal", **{changing_option: True})


def test_invalid_input_returns_actionable_error():
    response = TestClient(app).post("/api/v1/import/inspect", files={"file": ("bad.cif", b"not a CIF")})
    assert response.status_code == 422
    assert "Cannot inspect CIF" in response.json()["detail"]


def test_category_annotations_are_detected(tmp_path):
    from atomworks_studio_editing.mutations import edit_distance_restraint

    document = StudioDocument.from_cif(FIXTURE.read_text())
    edit_distance_restraint(document.array, 0, 2, "set", 4.0)
    path = tmp_path / "pair.cif"
    to_cif_file(document.array, path)
    assert inspect_import(path)["preset"] is None


def test_legacy_masks_are_detected():
    text = FIXTURE.read_text().replace(
        "_atom_site.group_PDB", "_atom_site.mask_coordinate_1_atom\n_atom_site.group_PDB"
    )
    text = text.replace("\nATOM ", "\n1 ATOM ")
    assert inspect_import(StringIO(text), file_type="cif")["preset"] is None
