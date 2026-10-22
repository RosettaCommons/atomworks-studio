"""Regressions for RFD4 validation and PyMOL group-coloring review findings."""

from pathlib import Path

import numpy as np
import pytest
from atomworks.ml.conditions import C_SEQ
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER, VALIDATION_PROVIDER
from atomworks_studio_rfd4.model import C_IDXGRP, HBondEnum, conditions
from biotite.structure import get_residue_starts, spread_residue_wise

pytestmark = pytest.mark.usefixtures("stable_cif_metadata")

FIXTURE = Path(__file__).parent / "fixtures" / "inverse_folding_2kl8.cif"
requires_sequence_probability = pytest.mark.skipif(
    not getattr(conditions, "SEQUENCE_PROBABILITY_CONDITIONS", ()), reason="requires sequence-probability conditions"
)


def _document(cif: str | None = None) -> StudioDocument:
    return StudioDocument.from_cif(
        cif or FIXTURE.read_text(),
        FIXTURE.stem,
        condition_provider=CONDITION_PROVIDER,
        validation_provider=VALIDATION_PROVIDER,
    )


def _probability(token_name: str):
    return next(c for c in conditions.SEQUENCE_PROBABILITY_CONDITIONS if c.token_name == token_name)


def _residue_atoms(document: StudioDocument, residue: int) -> np.ndarray:
    bounds = get_residue_starts(document.array, add_exclusive_stop=True)
    return np.arange(bounds[residue], bounds[residue + 1])


def _write_probability(document: StudioDocument, token_name: str, atoms: np.ndarray, value: float) -> None:
    """Store a value the way a loaded file does, bypassing interactive edit checks."""
    condition = _probability(token_name)
    values = condition.annotation(document.array, default="generate").astype(np.float32)
    values[atoms] = value
    condition.set_annotation(document.array, values)


def _checks(document: StudioDocument) -> dict[str, str]:
    return {issue["check"]: issue["severity"] for issue in VALIDATION_PROVIDER.validate(document.array)}


# F19: upstream HBondEnum.BOTH is a model input (donor in one bond, acceptor in another).


def test_hbond_contract_offers_upstream_values_and_save_validation_accepts_both() -> None:
    definition = CONDITION_PROVIDER.definitions_by_name["hbond"]
    assert [value.name for value in definition.enum_values] == [member.name for member in HBondEnum]

    document = _document()
    document.set_condition("hbond", [0, 1], value=int(HBondEnum.BOTH))
    assert (definition.condition.annotation(document.array)[[0, 1]] == HBondEnum.BOTH).all()
    assert VALIDATION_PROVIDER.validate(document.array) == []
    assert not [issue for issue in document.validate() if issue["severity"] == "error"]


# F20: save validation reports sequence-probability invariant violations.


@requires_sequence_probability
def test_clean_document_has_no_sequence_probability_issues() -> None:
    document = _document()
    document.set_condition("sequence", [0], enabled=False, scope="residue")
    document.set_condition(_probability("ALA").name, [0], value=0.6)
    assert VALIDATION_PROVIDER.validate(document.array) == []


@requires_sequence_probability
def test_save_validation_reports_probability_mass_above_one_from_loaded_file() -> None:
    document = _document()
    document.set_condition("sequence", [0], enabled=False, scope="residue")
    atoms = _residue_atoms(document, 0)
    _write_probability(document, "ALA", atoms, 0.8)
    _write_probability(document, "ARG", atoms, 0.8)
    assert _checks(document) == {"sequence_probability_sum_exceeds_one": "error"}

    reloaded = _document(document.to_cif())
    assert _checks(reloaded) == {"sequence_probability_sum_exceeds_one": "error"}
    assert any(issue["check"] == "sequence_probability_sum_exceeds_one" for issue in reloaded.validate())


@requires_sequence_probability
def test_save_validation_reports_probability_conflicting_with_exact_sequence() -> None:
    document = _document()
    document.set_condition("sequence", [0], enabled=True, scope="residue")
    atoms = _residue_atoms(document, 0)
    assert C_SEQ.mask(document.array, default="generate")[atoms].all()
    wrong = next(name for name in ("ALA", "GLY") if name != document.array.res_name[atoms[0]])
    _write_probability(document, wrong, atoms, 0.5)
    assert _checks(document) == {"sequence_probability_conflicts_with_c_seq": "error"}


@requires_sequence_probability
def test_save_validation_reports_nonuniform_residue_mask() -> None:
    document = _document()
    document.set_condition("sequence", [0], enabled=False, scope="residue")
    _write_probability(document, "ALA", _residue_atoms(document, 0)[:1], 0.4)
    assert _checks(document) == {"sequence_probability_nonuniform_residue_mask": "error"}


# F21 / F34: native PyMOL group views.


@pytest.fixture
def pymol_cmd():
    pymol = pytest.importorskip("pymol", reason="PyMOL is not installed")
    pymol.finish_launching(["pymol", "-qck"])
    from atomworks_studio_pymol.state import STATE
    from pymol import cmd

    cmd.reinitialize()
    STATE.clear_all()
    yield cmd
    cmd.reinitialize()
    STATE.clear_all()


def _load(name: str):
    from atomworks.io.config import ParseConfig
    from atomworks_studio_pymol.bridge import load_structure
    from atomworks_studio_pymol.state import STATE

    obj_name = load_structure(FIXTURE, config=ParseConfig.from_preset("minimal"), obj_name=name)
    return obj_name, STATE.arrays[obj_name]


def _b_factors(cmd, obj_name: str) -> dict[int, float]:
    values: dict[int, float] = {}
    cmd.iterate(obj_name, "values[ID] = b", space={"values": values})
    return values


def test_group_colors_distinguish_insertion_code_residues(pymol_cmd) -> None:
    from atomworks_studio_pymol.display import display_atom_ids
    from atomworks_studio_rfd4.pymol.visualize import color_by_index_group

    obj_name, array = _load("f21_insertion")
    bounds = get_residue_starts(array, add_exclusive_stop=True)
    first, inserted = np.arange(bounds[0], bounds[1]), np.arange(bounds[1], bounds[2])
    # Residue 1 and residue 1A, as in Kabat/Chothia-numbered CDRs.
    array.res_id[inserted] = array.res_id[first[0]]
    array.ins_code[inserted] = "A"
    ids = display_atom_ids(array)
    pymol_cmd.alter(f"{obj_name} and id {'+'.join(map(str, ids[inserted]))}", f"resi='{array.res_id[first[0]]}A'")
    assert set(array.atom_name[first]) & set(array.atom_name[inserted]), "residues must share atom names"
    groups = np.full(len(array), 1)
    groups[inserted] = 2
    C_IDXGRP.set_annotation(array, groups)

    color_by_index_group(array, obj_name)

    b = _b_factors(pymol_cmd, obj_name)
    assert {b[int(atom)] for atom in ids[first]} == {1.0}
    assert {b[int(atom)] for atom in ids[inserted]} == {2.0}


@pytest.fixture
def group_view(monkeypatch):
    from atomworks_studio_pymol import views
    from atomworks_studio_rfd4.pymol.visualize import color_by_index_group
    from pymol.Qt import QtWidgets

    prompts: list[list[str]] = []
    answer = {"value": ("3", True)}

    def get_item(_parent, _title, _label, choices, *_args):
        prompts.append(list(choices))
        return answer["value"]

    monkeypatch.setattr(QtWidgets.QInputDialog, "getItem", get_item)
    previous = views.get_default_view_name()
    views.register_view("Color by index group", color_by_index_group)
    views.set_default_view("Color by index group")
    yield prompts, answer
    views.set_default_view(previous)


def _one_group_per_residue(array) -> np.ndarray:
    groups = spread_residue_wise(array, np.arange(1, len(get_residue_starts(array)) + 1))
    C_IDXGRP.set_annotation(array, groups)
    return groups


def test_group_overflow_prompt_is_not_repeated_by_reloads(pymol_cmd, group_view) -> None:
    from atomworks_studio_pymol.bridge import reload_structure_in_pymol
    from atomworks_studio_pymol.display import display_atom_ids
    from atomworks_studio_rfd4.pymol.visualize import _PALETTE

    prompts, _ = group_view
    obj_name, array = _load("f34_reload")
    groups = _one_group_per_residue(array)
    assert len(set(groups.tolist())) > len(_PALETTE)

    for _ in range(3):  # edits, console commands and divergence checks all reload the object
        reload_structure_in_pymol(obj_name)
    assert len(prompts) == 1

    highlighted: list[int] = []
    pymol_cmd.iterate(
        f"{obj_name} and color {_PALETTE[0]}", "highlighted.append(ID)", space={"highlighted": highlighted}
    )
    assert sorted(highlighted) == sorted(display_atom_ids(array)[groups == 3].tolist())

    # Merging two groups changes the available choices, so the stored choice is re-confirmed once.
    groups[groups == 2] = 1
    C_IDXGRP.set_annotation(array, groups)
    reload_structure_in_pymol(obj_name)
    reload_structure_in_pymol(obj_name)
    assert len(prompts) == 2


def test_cancelled_group_overflow_prompt_is_not_repeated_by_reloads(pymol_cmd, group_view) -> None:
    from atomworks_studio_pymol.bridge import reload_structure_in_pymol

    prompts, answer = group_view
    answer["value"] = ("3", False)
    obj_name, array = _load("f34_cancel")
    _one_group_per_residue(array)

    reload_structure_in_pymol(obj_name)
    reload_structure_in_pymol(obj_name)
    assert len(prompts) == 1
