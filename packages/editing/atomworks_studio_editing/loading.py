"""Shared desktop/browser load presets and user-facing ParseConfig options."""

from dataclasses import asdict

from atomworks.io.config import ParseConfig

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
        "label": "Alternate locations",
        "kind": "choice",
        "choices": ["first", "random_per_chain", "random_clash_aware"],
    },
    "altloc_seed": {"label": "Alternate location seed (blank for random)", "kind": "integer"},
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
