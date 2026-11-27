"""Move and rotate the selection as a rigid body: coordinates change, conditions and shape do not."""

from pathlib import Path

import numpy as np
import pytest
from atomworks_studio_editing.document import StudioDocument

pytestmark = pytest.mark.usefixtures("stable_cif_metadata")

FIXTURE = Path(__file__).parent / "fixtures" / "SAM_hbonds.cif"


def document() -> StudioDocument:
    return StudioDocument.from_cif(FIXTURE.read_text())


def positioned(array) -> np.ndarray:
    return np.flatnonzero(np.isfinite(array.coord).all(axis=1))


def test_translation_moves_only_the_selection() -> None:
    doc = document()
    before = doc.array.coord.copy()
    selected = positioned(doc.array)[:5].tolist()

    result = doc.transform_selection(selected, translation=[1.0, 2.0, -3.0])

    assert result["moved_atom_count"] == len(selected)
    moved = doc.array.coord[selected] - before[selected]
    assert np.allclose(moved, [1.0, 2.0, -3.0], atol=1e-3)
    others = [i for i in range(len(doc.array)) if i not in set(selected)]
    assert np.array_equal(doc.array.coord[others], before[others], equal_nan=True)


def test_rotation_turns_in_place_and_keeps_internal_distances() -> None:
    doc = document()
    selected = positioned(doc.array)[:12].tolist()
    before = doc.array.coord[selected].astype(float).copy()
    centroid_before = before.mean(axis=0)
    pairwise_before = np.linalg.norm(before[:, None, :] - before[None, :, :], axis=-1)

    doc.transform_selection(selected, rotation_axis=[0.0, 0.0, 1.0], rotation_angle=np.pi / 3)

    after = doc.array.coord[selected].astype(float)
    # Rotating about the selection's own centroid leaves that centroid where it was.
    assert np.allclose(after.mean(axis=0), centroid_before, atol=1e-2)
    pairwise_after = np.linalg.norm(after[:, None, :] - after[None, :, :], axis=-1)
    assert np.allclose(pairwise_before, pairwise_after, atol=1e-2)
    assert not np.allclose(before, after, atol=1e-2)


def test_rotation_about_an_explicit_center_swings_the_body() -> None:
    doc = document()
    selected = positioned(doc.array)[:6].tolist()
    before = doc.array.coord[selected].astype(float).copy()
    center = (before.mean(axis=0) + np.array([25.0, 0.0, 0.0])).tolist()

    doc.transform_selection(selected, rotation_axis=[0.0, 1.0, 0.0], rotation_angle=np.pi, center=center)

    after = doc.array.coord[selected].astype(float)
    # Turned half a circle about a point to the side: the body lands on the far side of it.
    assert np.allclose(after.mean(axis=0), before.mean(axis=0) + np.array([50.0, 0.0, 0.0]), atol=1e-2)


def test_transform_is_one_undo_step() -> None:
    doc = document()
    before = doc.array.coord.copy()
    revision = doc.revision
    selected = positioned(doc.array)[:4].tolist()

    doc.transform_selection(selected, translation=[5.0, 0.0, 0.0], rotation_axis=[1.0, 0.0, 0.0], rotation_angle=0.5)

    assert doc.revision == revision + 1
    assert doc.undo()
    assert np.array_equal(doc.array.coord, before, equal_nan=True)
    assert doc.revision == revision + 2


def test_motionless_transform_is_not_an_edit() -> None:
    doc = document()
    revision = doc.revision
    selected = positioned(doc.array)[:3].tolist()

    result = doc.transform_selection(selected, translation=[0.0, 0.0, 0.0])

    assert result["moved_atom_count"] == len(selected)
    assert doc.revision == revision, "a transform that moves nothing leaves no undo step"
    assert not doc.undo()


def test_unpositioned_atoms_keep_their_missing_coordinates() -> None:
    doc = document()
    coords = doc.array.coord.copy()
    coords[0] = np.nan
    doc.array.coord = coords

    result = doc.transform_selection([0, *positioned(doc.array)[:3].tolist()], translation=[1.0, 1.0, 1.0])

    assert result["moved_atom_count"] == 3
    assert not np.isfinite(doc.array.coord[0]).any()


def test_selection_without_coordinates_reports_nothing_to_move() -> None:
    doc = document()
    coords = doc.array.coord.copy()
    coords[0] = np.nan
    doc.array.coord = coords
    revision = doc.revision

    result = doc.transform_selection([0], translation=[1.0, 0.0, 0.0])

    assert result["moved_atom_count"] == 0
    assert "no coordinates" in str(result["message"])
    assert doc.revision == revision


def test_residue_scope_moves_whole_residues() -> None:
    doc = document()
    atom = int(positioned(doc.array)[0])
    whole_residue = doc.resolve_indices([atom], "residue")

    result = doc.transform_selection([atom], scope="residue", translation=[0.0, 0.0, 1.0])

    assert result["moved_atom_count"] == len(whole_residue)


def test_rejects_a_zero_length_rotation_axis() -> None:
    doc = document()
    with pytest.raises(ValueError, match="zero length"):
        doc.transform_selection([0], rotation_axis=[0.0, 0.0, 0.0], rotation_angle=1.0)
