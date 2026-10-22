"""Shared desktop/browser load presets and user-facing ParseConfig options."""

from collections import Counter
from dataclasses import asdict
from io import BytesIO, StringIO
from pathlib import Path

from atomworks.io import parse
from atomworks.io.config import ParseConfig
from atomworks.io.template import add_missing_atoms_for_chain, infer_bonds_from_residue_names
from atomworks.io.utils.atom_array_plus import insert_atoms
from atomworks.io.utils.ccd import custom_ccd_residues
from atomworks.io.utils.io_utils import read_any
from atomworks.io.utils.link_chemistry import build_link_product
from atomworks.io.utils.standard_annotations import STANDARD_ANNOTATIONS
from atomworks.io.utils.standard_annotations.serialization import _LEGACY_MASK_FIELDS
from atomworks.io.utils.standardize import standardize_atom_names
from biotite.structure import AtomArray

# UI metadata only: preset values and parsing behavior come from AtomWorks.
LOAD_FIELDS = {
    "load_standard_annotations": {"label": "Load saved annotations", "kind": "boolean"},
    "add_missing_atoms": {"label": "Add missing atoms", "kind": "boolean"},
    "remove_waters": {"label": "Remove waters", "kind": "boolean"},
    "fix_ligands_at_symmetry_centers": {"label": "Fix ligands at symmetry centers", "kind": "boolean"},
    "fix_arginines": {"label": "Fix arginines", "kind": "boolean"},
    "add_id_and_entity_annotations": {"label": "Add identity and entity annotations", "kind": "boolean"},
    "convert_mse_to_met": {"label": "Convert MSE to MET", "kind": "boolean"},
    "long_bond_policy": {
        "label": "Long bonds",
        "kind": "choice",
        "choices": [
            "keep",
            "filter",
            "warn",
            "raise",
            "filter_nonstandard_only",
            "warn_nonstandard_only",
            "raise_nonstandard_only",
        ],
    },
    "struct_conn_distance_policy": {
        "label": "Connection distances",
        "kind": "choice",
        "choices": [
            "keep",
            "filter",
            "warn",
            "raise",
            "filter_nonstandard_only",
            "warn_nonstandard_only",
            "raise_nonstandard_only",
        ],
    },
    "hydrogen_policy": {"label": "Hydrogens", "kind": "choice", "choices": ["keep", "remove"]},
    "altloc": {
        "label": "altloc",
        "kind": "choice",
        "choices": ["first", "random_per_chain", "random_clash_aware"],
    },
    "altloc_seed": {"label": "altloc seed (blank for random)", "kind": "integer"},
    "model": {"label": "Model (blank for all)", "kind": "integer"},
    "remove_ccds": {"label": "Remove CCD codes (comma-separated)", "kind": "text"},
}


def build_load_config(preset: str = "minimal", *, assembly: str = "1", **options) -> ParseConfig:
    if preset not in ("minimal", "rcsb"):
        raise ValueError(f"Unknown loading preset: {preset}")
    for name, value in options.items():
        field = LOAD_FIELDS.get(name)
        if field is None:
            raise ValueError(f"Unsupported load option: {name}")
        kind = field["kind"]
        if kind == "boolean" and not isinstance(value, bool):
            raise ValueError(f"{name} requires a boolean")
        if kind == "integer" and value is not None and (type(value) is not int or value < 0):
            raise ValueError(f"{name} requires a nonnegative integer or null")
        if kind == "choice" and value not in field["choices"]:
            raise ValueError(f"Unsupported {name}: {value}")
        if name == "remove_ccds":
            if isinstance(value, str):
                options[name] = tuple(item.strip() for item in value.split(",") if item.strip())
            elif isinstance(value, (tuple, list)) and all(isinstance(item, str) for item in value):
                options[name] = tuple(value)
            else:
                raise ValueError("remove_ccds requires comma-separated codes")
    assembly = assembly.strip()
    build_assembly = (
        None
        if assembly in ("", "asym")
        else assembly
        if assembly in ("first", "all")
        else [part.strip() for part in assembly.split(",") if part.strip()]
    )
    overrides = {"build_assembly": build_assembly, **options}
    if preset == "minimal":
        overrides.setdefault("load_standard_annotations", True)
    if "return_atom_array_plus" in ParseConfig.__dataclass_fields__:
        overrides["return_atom_array_plus"] = True
    return ParseConfig.from_preset(preset, **overrides)


def load_options_schema() -> dict:
    return {
        "fields": LOAD_FIELDS,
        "presets": {
            preset: {key: value for key, value in asdict(build_load_config(preset)).items() if key in LOAD_FIELDS}
            for preset in ("minimal", "rcsb")
        },
    }


def heavy_atom_inventory(
    source: Path | StringIO | BytesIO, *, file_type: str | None = None
) -> tuple[AtomArray, AtomArray]:
    """Compare heavy-atom inventories without interpreting design placeholders as chemistry.

    The disposable completion copy drops annotations and resolves leaving groups only.
    It must not replace an authored document or its conditions, charges, and bonds.
    """
    if isinstance(source, StringIO | BytesIO):
        source.seek(0)
    config = build_load_config(
        "minimal",
        assembly="asym",
        load_standard_annotations=False,
        hydrogen_policy="remove",
    ).replace(file_type=file_type)
    parsed = parse(source, config=config)
    original = parsed["asym_unit"][0]
    with custom_ccd_residues(original._custom_ccd_registry):
        original = standardize_atom_names(
            original,
            on_mismatch="raise",
            on_mismatch_non_heavy="filter",
            non_canonical_only=False,
        )
        templates, positions = [], []
        for chain, info in parsed["chain_info"].items():
            missing, locations = add_missing_atoms_for_chain(
                sequence=info["res_name"],
                res_ids=info["res_id"],
                atom_array=original,
                chain_mask=original.chain_id == chain,
                chain_type=info["chain_type"],
                hydrogen_policy="remove",
            )
            templates.extend(missing)
            positions.extend(locations)
        completed = (
            insert_atoms(original.copy(), templates, positions, on_annotation_mismatch_policy="drop")
            if templates
            else original.copy()
        )
        completed = infer_bonds_from_residue_names(completed, sanitize=False)
        completed, _ = build_link_product(completed)
    return original, completed


def terminal_oxt_count(missing: Counter, completed: AtomArray) -> int:
    """Count missing OXT atoms on residues whose carboxyl carbon is not linked to another residue.

    A free C-terminal carboxyl (the end of a chain, or of a separately placed segment such as a
    motif island) is the one place design outputs routinely omit a heavy atom, its OXT. AtomWorks
    completion only keeps an added OXT where no peptide link is built, so the rule here is checked
    on the completed bond graph: an OXT is exempt only if its residue's backbone ``C`` has no bond to
    an atom of a different residue. Any other missing OXT still counts as a missing heavy atom.
    ``missing`` is keyed by (chain_id, res_id, ins_code, res_name, atom_name).
    """
    residue = list(zip(completed.chain_id, completed.res_id, completed.ins_code, strict=True))
    carbon = {residue[i]: i for i in range(len(completed)) if completed.atom_name[i] == "C"}

    def free_carboxyl(key: tuple) -> bool:
        index = carbon.get(key)
        if index is None or completed.bonds is None:
            return False
        partners, _types = completed.bonds.get_bonds(index)
        return all(residue[int(partner)] == key for partner in partners)

    return sum(
        count
        for (chain, res_id, ins_code, _res_name, atom_name), count in missing.items()
        if atom_name == "OXT" and free_carboxyl((chain, res_id, ins_code))
    )


def inspect_import(source: Path | StringIO | BytesIO, *, file_type: str | None = None) -> dict:
    """Infer an import preset without changing the source or loading a document.

    For annotated inputs, compare the asymmetric unit before/after AtomWorks heavy-atom
    completion. Existing unresolved (NaN-coordinate) atom records are already present.
    If completion cannot be checked, require an explicit choice rather than guessing.
    """
    cif = read_any(source, file_type=file_type)
    block = cif.block
    names = {name for annotation in STANDARD_ANNOTATIONS for name in (annotation.full_name, *annotation.aliases)}
    saved = bool(
        names.intersection(block) or (names | set(_LEGACY_MASK_FIELDS.values())).intersection(block["atom_site"])
    )
    if not saved:
        return {"preset": "rcsb", "message": "No saved StandardAnnotations. Using Unannotated input."}
    try:
        original, completed = heavy_atom_inventory(source, file_type=file_type)
        atom_sets = [
            Counter(zip(atoms.chain_id, atoms.res_id, atoms.ins_code, atoms.res_name, atoms.atom_name, strict=True))
            for atoms in (original, completed)
        ]
        missing = atom_sets[1] - atom_sets[0]
        terminal_oxt = terminal_oxt_count(missing, completed)
        added = sum(missing.values()) - terminal_oxt
    except Exception as error:
        return {
            "preset": None,
            "message": f"Saved StandardAnnotations found, but missing atoms could not be checked: {error}. "
            "Choose a preset or Custom settings.",
        }
    if added:
        return {
            "preset": None,
            "message": f"This file has saved StandardAnnotations and {added} missing heavy atoms. "
            "Adding atoms changes annotation indices, so both cannot be enabled together. "
            "Choose Annotated CIF to keep annotations and the existing atom list, or Unannotated input "
            "to discard saved annotations and add missing atoms. Custom settings are also available.",
        }
    if terminal_oxt:
        atoms = "terminal OXT atom is" if terminal_oxt == 1 else "terminal OXT atoms are"
        return {
            "preset": "minimal",
            "message": f"Saved StandardAnnotations found; {terminal_oxt} {atoms} missing and not added. "
            "Using Annotated CIF.",
        }
    return {
        "preset": "minimal",
        "message": "Saved StandardAnnotations found; no missing heavy atoms. Using Annotated CIF.",
    }
