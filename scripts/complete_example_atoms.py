"""Complete bundled example residues while preserving authored conditions and topology."""

import argparse
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus, insert_atoms
from atomworks.io.utils.io_utils import to_cif_file
from atomworks.io.utils.standard_annotations import STANDARD_ANNOTATIONS
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.loading import heavy_atom_inventory, inspect_import
from atomworks_studio_editing.providers import load_providers
from atomworks_studio_editing.structure_mutations import refresh_chain_derived_annotations
from biotite.structure import BondList

ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = load_providers()


def atom_keys(array: AtomArrayPlus) -> list[tuple]:
    return list(zip(array.chain_id, array.res_id, array.ins_code, array.res_name, array.atom_name, strict=True))


def complete_example(source: Path, destination: Path) -> int:
    """Add unpositioned heavy atoms; retain residue conditions and all existing atom conditions."""
    document = StudioDocument.from_cif(
        source.read_text(),
        condition_provider=PROVIDERS.condition_provider,
        validation_provider=PROVIDERS.validation_provider,
    )
    original = document.array.copy()
    with TemporaryDirectory() as directory:
        canonical = Path(directory) / "input.cif"
        to_cif_file(original, canonical, save_standard_annotations=True)
        _, completed = heavy_atom_inventory(canonical)
    original_keys = atom_keys(original)
    original_index = {key: index for index, key in enumerate(original_keys)}
    assert len(original_index) == len(original)
    assert set(atom_keys(original[~np.isin(original.element, ["H", "D", "T"])])) <= set(atom_keys(completed))
    added = completed[[key not in original_index for key in atom_keys(completed)]]
    if not len(added):
        return 0
    residues = {key[:-1]: index for index, key in enumerate(original_keys)}
    parents = np.array([residues[key[:-1]] for key in atom_keys(added)])
    standard_fields = {name: field for field in STANDARD_ANNOTATIONS for name in (field.full_name, *field.aliases)}
    categories = original.get_annotation_categories()
    for name in list(added.get_annotation_categories()):
        if name not in categories:
            added.del_annotation(name)
    for name in categories:
        if name in standard_fields:
            field = standard_fields[name]
            values = field.annotation(added, default="generate").copy()
            if field.level != "atom":
                values = original.get_annotation(name)[parents].copy()
            added.set_annotation(name, values)
        elif name not in added.get_annotation_categories():
            added.set_annotation(name, original.get_annotation(name)[parents].copy())
    added.coord[:] = np.nan
    if "atom_id" in categories:
        added.atom_id = np.arange(original.atom_id.max() + 1, original.atom_id.max() + 1 + len(added))
    result = insert_atoms(
        original,
        [added[i : i + 1] for i in range(len(added))],
        (parents + 1).tolist(),
        fill_missing_standard_annotations=True,
    )
    result_index = {key: index for index, key in enumerate(atom_keys(result))}
    added_keys = set(atom_keys(added))
    completed_keys = atom_keys(completed)
    bonds = [
        (result_index[completed_keys[i]], result_index[completed_keys[j]], kind)
        for i, j, kind in completed.bonds.as_array()
        if completed_keys[i] in result_index
        and completed_keys[j] in result_index
        and (completed_keys[i] in added_keys or completed_keys[j] in added_keys)
    ]
    result.bonds = result.bonds.merge(BondList(len(result), np.asarray(bonds, dtype=np.uint32).reshape(-1, 3)))
    refresh_chain_derived_annotations(result)
    with TemporaryDirectory() as directory:
        candidate = Path(directory) / "completed.cif"
        to_cif_file(result, candidate, save_standard_annotations=True)
        restored = StudioDocument.from_cif(
            candidate.read_text(),
            condition_provider=PROVIDERS.condition_provider,
            validation_provider=PROVIDERS.validation_provider,
        ).array
        restored_index = {key: index for index, key in enumerate(atom_keys(restored))}
        retained = restored[[restored_index[key] for key in original_keys]]
        np.testing.assert_allclose(retained.coord, original.coord, atol=0.001, equal_nan=True)
        np.testing.assert_array_equal(retained.charge, original.charge)
        np.testing.assert_array_equal(retained.bonds.as_array(), original.bonds.as_array())
        for field in STANDARD_ANNOTATIONS:
            if field.full_name not in original.get_annotation_categories(n_body=field.n_body):
                continue
            expected, actual = field.annotation(original), field.annotation(retained)
            if field.n_body == 2:
                np.testing.assert_array_equal(actual.pairs, expected.pairs)
                np.testing.assert_allclose(actual.values, expected.values, atol=0.001, equal_nan=True)
            elif np.asarray(expected).dtype.kind in "fc":
                np.testing.assert_allclose(actual, expected, atol=0.001, equal_nan=True)
            else:
                np.testing.assert_array_equal(actual, expected)
        assert inspect_import(candidate)["preset"] == "minimal", candidate
        destination.write_bytes(candidate.read_bytes())
    return len(added)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    for source in args.files:
        count = complete_example(source, source)
        print(
            f"{source}: added {count} unpositioned heavy atoms; "
            "existing annotations, coordinates, bonds and charges preserved"
        )
