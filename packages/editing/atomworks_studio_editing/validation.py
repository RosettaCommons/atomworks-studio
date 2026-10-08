"""Shared, UI-neutral validation for mutable AtomWorks structures.

Moved into atomworks-studio (from atomworks ``io.utils.validation``, commit 8e4b2c39) as a
shared editor primitive; see :mod:`atomworks_studio_editing.structure_mutations`.
"""

import logging

import numpy as np
from atomworks.constants import HYDROGEN_LIKE_SYMBOLS
from atomworks.io.config import PrepareConfig
from atomworks.io.parser import prepare_atom_array
from atomworks.io.utils.atom_array_plus import AtomArrayPlus, as_atom_array
from atomworks.io.utils.ccd import custom_ccd_residues


def validate_atom_array(array: AtomArrayPlus) -> list[dict[str, str]]:
    """Return structural issues required by all interactive editors."""
    issues: list[dict[str, str]] = []
    ins_code = array.ins_code if "ins_code" in array.get_annotation_categories() else np.full(len(array), "")
    chain_key = "chain_iid" if "chain_iid" in array.get_annotation_categories() else "chain_id"
    keys = [
        (
            str(array.get_annotation(chain_key)[index]),
            int(array.res_id[index]),
            str(ins_code[index]),
            str(array.atom_name[index]),
        )
        for index in range(len(array))
    ]
    if len(set(keys)) != len(keys):
        issues.append({"severity": "error", "check": "atom_identity", "message": "atom identity keys are not unique"})
    if np.isinf(array.coord).any():
        issues.append({"severity": "error", "check": "coordinates", "message": "coordinates contain infinity"})
    return issues


def validate_atom_array_for_save(array: AtomArrayPlus) -> list[dict[str, str]]:
    """Check heavy-atom completeness without changing the document or model annotations."""
    try:
        config = PrepareConfig(
            add_missing_atoms=True,
            remove_ccds=(),
            remove_waters=False,
            fix_ligands_at_symmetry_centers=False,
            fix_arginines=False,
            add_id_and_entity_annotations=False,
            convert_mse_to_met=False,
            long_bond_policy="keep",
            struct_conn_distance_policy="keep",
            hydrogen_policy="remove",
        )
        # Completion only needs chemistry. A plain copy permits missing atoms to
        # be inserted without requiring their editor annotations to already exist.
        with custom_ccd_residues(array._custom_ccd_registry):
            prepared = prepare_atom_array(as_atom_array(array.copy(), suppress_loss_warnings=True), config=config)
        n_added = len(prepared) - int(np.count_nonzero(~np.isin(array.element, HYDROGEN_LIKE_SYMBOLS)))
        if n_added > 0:
            return [
                {
                    "severity": "error",
                    "check": "missing_atoms",
                    "message": f"Structure is missing {n_added} heavy atoms that would be "
                    "added by prepare_atom_array. Check for incomplete residues.",
                }
            ]
    except Exception as error:
        # Upstream treats unavailable CCD/chemistry checks as a logged diagnostic.
        logging.getLogger(__name__).warning("Missing-atom check failed: %s", error)
    return []
