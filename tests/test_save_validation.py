"""Missing-heavy-atom checks must also work after hydrogens have been added."""

import pytest
from atomworks.io.utils.atom_array_plus import as_atom_array_plus
from atomworks.io.utils.ccd import atom_array_from_ccd_code
from atomworks.io.utils.io_utils import to_cif_string
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.validation import validate_atom_array_for_save


@pytest.mark.parametrize("keep_hydrogens", [False, True])
def test_missing_heavy_atom_is_reported_with_or_without_hydrogens(keep_hydrogens):
    array = as_atom_array_plus(atom_array_from_ccd_code("ALA"))
    array.chain_id[:] = "A"
    array.res_id[:] = 1
    array = StudioDocument.from_cif(to_cif_string(array)).array
    if not keep_hydrogens:
        array = array[array.element != "H"]
    assert validate_atom_array_for_save(array) == []
    incomplete = array[array.atom_name != "CB"]
    issues = validate_atom_array_for_save(incomplete)
    assert len(issues) == 1
    assert issues[0]["check"] == "missing_atoms"
    assert "missing 1 heavy atoms" in issues[0]["message"]
