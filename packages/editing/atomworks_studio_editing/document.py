"""Renderer-independent annotated structure document and editing operations."""

from __future__ import annotations

import copy
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from io import StringIO
from typing import Any, Literal

import biotite.structure as struc
import numpy as np
from atomworks.constants import MASKED
from atomworks.experimental.protonation import add_hydrogens
from atomworks.io import parse
from atomworks.io.template import infer_bonds_from_residue_names
from atomworks.io.utils.atom_array_plus import (
    AnnotationList2D,
    AtomArrayPlus,
    as_atom_array_plus,
    concatenate_atom_array_plus,
)
from atomworks.io.utils.ccd import custom_ccd_residues
from atomworks.io.utils.chain import create_chain_id_generator
from atomworks.io.utils.io_utils import CIFWriteConfig, to_cif_string
from atomworks.io.utils.query import AtomSelectionStack
from atomworks.io.utils.standard_annotations import S_SEGMAX, S_SEGMIN
from atomworks.io.utils.standard_annotations.base import STANDARD_ANNOTATIONS
from atomworks.ml.conditions import C_DIS
from atomworks.ml.transforms.interactions import AnnotateInteractions, InteractionType
from atomworks.ml.utils.expandable_segment import (
    collapse_expandable_segments,
    insert_expandable_segment,
    realize_expandable_segments,
)

from atomworks_studio_editing.annotations import has_stored_mask, normalize_annotation_aliases, set_annotation_mask
from atomworks_studio_editing.loading import build_load_config
from atomworks_studio_editing.mutations import edit_distance_restraint as mutate_distance_restraint
from atomworks_studio_editing.mutations import replace_distance_restraints, set_condition_mask
from atomworks_studio_editing.query import resolve_mask
from atomworks_studio_editing.structure_mutations import (
    assign_chain_id,
    refresh_chain_derived_annotations,
    set_formal_charge,
)
from atomworks_studio_editing.structure_mutations import (
    delete_atoms as mutate_delete_atoms,
)
from atomworks_studio_editing.structure_mutations import (
    edit_bond as mutate_bond,
)
from atomworks_studio_editing.validation import validate_atom_array, validate_atom_array_for_save

from .contracts import (
    NEUTRAL_VALIDATION_PROVIDER,
    ConditionOperation,
    ConditionProvider,
    DocumentRevisionConflictError,
    TargetDiscardConfirmationRequiredError,
    ValidationProvider,
)

ConditionScope = Literal["atom", "residue", "chain"]

RESIDUE_CODES = {
    "ALA": "A",
    "ARG": "R",
    "ASN": "N",
    "ASP": "D",
    "CYS": "C",
    "GLN": "Q",
    "GLU": "E",
    "GLY": "G",
    "HIS": "H",
    "ILE": "I",
    "LEU": "L",
    "LYS": "K",
    "MET": "M",
    "PHE": "F",
    "PRO": "P",
    "SER": "S",
    "THR": "T",
    "TRP": "W",
    "TYR": "Y",
    "VAL": "V",
}

BOND_TYPES = {
    "SINGLE": struc.BondType.SINGLE,
    "DOUBLE": struc.BondType.DOUBLE,
    "TRIPLE": struc.BondType.TRIPLE,
    "AROMATIC": struc.BondType.AROMATIC,
    "AROMATIC_SINGLE": struc.BondType.AROMATIC_SINGLE,
    "AROMATIC_DOUBLE": struc.BondType.AROMATIC_DOUBLE,
    "COORDINATION": struc.BondType.COORDINATION,
    "ANY": struc.BondType.ANY,
}
BOND_TYPE_NAMES = {int(value): name for name, value in BOND_TYPES.items()}
INTERACTION_TYPES = (
    "hbond",
    "hydrophobic",
    "pistacking",
    "pication",
    "saltbridge",
    "halogen",
    "metal",
)
INTERACTION_ROLES = {
    "hbond": ("donor", "acceptor"),
    "hydrophobic": ("hydrophobic", "hydrophobic"),
    "pistacking": ("aromatic", "aromatic"),
    "pication": ("aromatic", "cation"),
    "saltbridge": ("positive", "negative"),
    "halogen": ("halogen", "acceptor"),
    "metal": ("metal", "coordinating"),
}
INTERACTION_FAMILIES = {
    "hbond": "hbond",
    "hydrophobic": "hydrophobic",
    "pistacking": "pi",
    "pication": "pi",
    "saltbridge": "salt",
    "halogen": "halogen",
    "metal": "metal",
}
INTERACTION_ANNOTATIONS = {name: f"interaction_{name}" for name in INTERACTION_TYPES}


def _first_array(result: dict[str, Any]) -> AtomArrayPlus:
    assemblies = result.get("assemblies", {})
    array = next(iter(assemblies.values())) if assemblies else result["asym_unit"]
    if isinstance(array, struc.AtomArrayStack):
        array = array[0]
    array = as_atom_array_plus(array)
    refresh_chain_derived_annotations(array)
    return array


def parse_annotated_cif(
    cif_text: str,
    *,
    preset: Literal["minimal", "rcsb"] = "minimal",
    assembly: str = "1",
    model: int | None = None,
    remove_waters: bool | None = None,
    hydrogen_policy: Literal["keep", "remove"] | None = None,
    advanced_options: dict[str, Any] | None = None,
) -> AtomArrayPlus:
    """Parse with the same presets and core options as the desktop load dialog."""
    overrides = dict(advanced_options or {})
    for key, value in (("model", model), ("remove_waters", remove_waters), ("hydrogen_policy", hydrogen_policy)):
        if value is not None:
            overrides[key] = value
    config = build_load_config(preset, assembly=assembly, **overrides).replace(file_type="cif")
    array = _first_array(parse(StringIO(cif_text), config=config))
    normalize_annotation_aliases(array)
    return array


class StudioDocument:
    """Authoritative mutable AtomWorks structure with bounded undo history."""

    def __init__(
        self,
        array: AtomArrayPlus,
        name: str = "structure",
        *,
        condition_provider: ConditionProvider | None = None,
        validation_provider: ValidationProvider | None = None,
    ):
        self.array = array
        self.name = name
        from .conditions import CONDITION_PROVIDER

        self.condition_provider = condition_provider if condition_provider is not None else CONDITION_PROVIDER
        self.validation_provider = validation_provider or NEUTRAL_VALIDATION_PROVIDER
        self._undo: list[AtomArrayPlus] = []
        self.revision = 0
        self._editing = False
        self._interaction_cache: dict[tuple[Any, ...], dict[str, Any]] = {}

    @classmethod
    def from_cif(
        cls,
        cif_text: str,
        name: str = "structure",
        *,
        parse_options: dict[str, Any] | None = None,
        condition_provider: ConditionProvider | None = None,
        validation_provider: ValidationProvider | None = None,
    ) -> StudioDocument:
        return cls(
            parse_annotated_cif(cif_text, **(parse_options or {})),
            name,
            condition_provider=condition_provider,
            validation_provider=validation_provider,
        )

    def clone(self) -> StudioDocument:
        clone = StudioDocument(
            copy.deepcopy(self.array),
            self.name,
            condition_provider=self.condition_provider,
            validation_provider=self.validation_provider,
        )
        clone.revision = self.revision
        return clone

    def export_state(self) -> dict[str, Any]:
        """Serialize the document and bounded undo stack for a shared session store."""

        return {
            "name": self.name,
            "revision": self.revision,
            "cif": self._array_to_cif(self.array),
            "undo_cifs": [self._array_to_cif(array) for array in self._undo],
        }

    @classmethod
    def from_state(
        cls,
        state: dict[str, Any],
        *,
        condition_provider: ConditionProvider | None = None,
        validation_provider: ValidationProvider | None = None,
    ) -> StudioDocument:
        """Restore a shared-store snapshot, including cross-replica undo history."""

        document = cls.from_cif(
            str(state["cif"]),
            str(state.get("name", "structure")),
            condition_provider=condition_provider,
            validation_provider=validation_provider,
        )
        undo_cifs = state.get("undo_cifs", [])
        if not isinstance(undo_cifs, list) or len(undo_cifs) > 10:
            raise ValueError("invalid persisted undo history")
        document._undo = [parse_annotated_cif(str(cif)) for cif in undo_cifs]
        document.revision = int(state.get("revision", 0))
        return document

    def _mark_changed(self) -> None:
        self.revision += 1
        self._interaction_cache.clear()

    @contextmanager
    def edit(self, *, unchanged: Callable[[AtomArrayPlus, AtomArrayPlus], bool] | None = None) -> Iterator[None]:
        """Commit one undoable edit, restoring the document on any failure.

        Nested operations form one transaction. Failed edits leave the undo
        budget, revision, and cached inspection results unchanged.
        """
        if self._editing:
            yield
            return
        previous = copy.deepcopy(self.array)
        self._editing = True
        try:
            yield
            no_change = unchanged is not None and unchanged(previous, self.array)
        except BaseException:
            self.array = previous
            raise
        else:
            if no_change:
                self.array = previous
                return
            self._undo.append(previous)
            del self._undo[:-10]
            self._mark_changed()
        finally:
            self._editing = False

    def snapshot(self) -> None:
        self._undo.append(copy.deepcopy(self.array))
        if len(self._undo) > 10:
            self._undo.pop(0)

    @contextmanager
    def _condition_edit(
        self, operation: str, allow_target_discard: bool, expected_revision: int | None
    ) -> Iterator[None]:
        if expected_revision is not None and self.revision != expected_revision:
            raise DocumentRevisionConflictError(expected_revision, self.revision)
        unchanged = getattr(self.condition_provider, "condition_edit_is_noop", None)
        with self.edit(unchanged=(lambda before, after: unchanged(operation, before, after)) if unchanged else None):
            target_loss = getattr(self.condition_provider, "discarded_target_count", None)
            original = self.array.copy() if target_loss is not None and not allow_target_discard else None
            yield
            if original is not None:
                count = target_loss(original, self.array)
                if count:
                    raise TargetDiscardConfirmationRequiredError(count, self.revision)

    def clear_history(self) -> None:
        """Discard undo history when replacing an entire document."""
        self._undo.clear()

    def undo(self) -> bool:
        if not self._undo:
            return False
        self.array = self._undo.pop()
        self._mark_changed()
        return True

    def annotation_details(self, condition_name: str | None = None) -> list[dict[str, Any]]:
        """Return explicitly stored, non-default design annotations and atom membership."""

        entries: list[dict[str, Any]] = []

        def atom_indices(mask: np.ndarray) -> list[int]:
            return np.flatnonzero(mask).astype(int).tolist()

        for spec in self.condition_provider.definitions:
            condition = spec.condition
            if spec.kind in {"mask", "operation"}:
                if spec.active_mask is not None:
                    mask = np.asarray(spec.active_mask(self.array))
                elif has_stored_mask(condition, self.array):
                    mask = np.asarray(condition.mask(self.array, default="generate"))
                else:
                    continue
                if spec.invert_mask:
                    mask = ~mask
                if not mask.any():
                    continue
                indices = atom_indices(mask)
                count = len(indices)
                if spec.count_unit == "residues":
                    count = int(mask[struc.get_residue_starts(self.array)].sum())
                entries.append(
                    {
                        "name": spec.key,
                        "label": spec.label,
                        "count": count,
                        "unit": spec.count_unit,
                        "values": [
                            {
                                "label": "Unindexed" if spec.invert_mask else "Active",
                                "count": len(indices),
                                "atom_indices": indices,
                            }
                        ],
                    }
                )
                continue

            if not condition.has_annotation(self.array):
                continue
            raw_annotation = condition.annotation(self.array, default="raise")
            values: list[dict[str, Any]] = []

            if spec.kind == "pair":
                if not isinstance(raw_annotation, AnnotationList2D):
                    raise TypeError(f"{spec.key} declared a pair editor but stores a 1-body annotation")
                seen: set[tuple[int, int]] = set()
                for pair, value in zip(raw_annotation.pairs, raw_annotation.values, strict=True):
                    atom1, atom2 = sorted((int(pair[0]), int(pair[1])))
                    if atom1 == atom2 or (atom1, atom2) in seen:
                        continue
                    seen.add((atom1, atom2))
                    values.append(
                        {
                            "label": f"Atoms {atom1}-{atom2}",
                            "value": float(value),
                            "count": 1,
                            "atom_indices": [atom1, atom2],
                        }
                    )
            else:
                annotation = np.asarray(raw_annotation)
                mask = np.asarray(condition.mask(self.array, default="generate"))
                if spec.kind == "enum":
                    for member in spec.enum_values:
                        if member.value == spec.default:
                            continue
                        member_mask = mask & (annotation == member.value)
                        if member_mask.any():
                            indices = atom_indices(member_mask)
                            values.append(
                                {
                                    "label": member.name,
                                    "value": int(member.value),
                                    "count": len(indices),
                                    "atom_indices": indices,
                                }
                            )
                elif spec.kind == "integer":
                    for group in np.unique(annotation):
                        if group == spec.default:
                            continue
                        group_mask = annotation == group
                        indices = atom_indices(group_mask)
                        values.append(
                            {
                                "label": f"Group {int(group)}",
                                "value": int(group),
                                "count": len(indices),
                                "atom_indices": indices,
                            }
                        )
                elif spec.kind == "text":
                    for text in np.unique(annotation[mask]):
                        indices = atom_indices(mask & (annotation == text))
                        values.append(
                            {"label": str(text), "value": str(text), "count": len(indices), "atom_indices": indices}
                        )
                elif spec.kind == "scalar":
                    for scalar in np.unique(annotation[mask]):
                        if scalar == spec.default:
                            continue
                        scalar_mask = annotation == scalar
                        indices = atom_indices(scalar_mask)
                        values.append(
                            {
                                "label": str(float(scalar)),
                                "value": float(scalar),
                                "count": len(indices),
                                "atom_indices": indices,
                            }
                        )
                elif spec.kind == "vector3":
                    for chain in np.unique(self.array.chain_iid[mask]):
                        chain_mask = mask & (self.array.chain_iid == chain)
                        indices = atom_indices(chain_mask)
                        if not indices:
                            continue
                        xyz = annotation[indices[0]]
                        values.append(
                            {
                                "label": f"Chain {chain}",
                                "value": [float(value) for value in xyz],
                                "count": len(indices),
                                "atom_indices": indices,
                            }
                        )

            if values:
                if spec.count_unit == "residues":
                    active = np.asarray(condition.mask(self.array, default="generate"))
                    count = int(active[struc.get_residue_starts(self.array)].sum())
                elif spec.count_unit in {"groups", "chains"}:
                    count = len(values)
                else:
                    count = sum(value["count"] for value in values)
                entries.append(
                    {
                        "name": spec.key,
                        "label": spec.label,
                        "count": count,
                        "unit": spec.count_unit,
                        "values": values,
                    }
                )

        if condition_name is not None:
            definition = self.condition_provider.definitions_by_name.get(condition_name)
            if definition is None:
                raise KeyError(f"unsupported condition: {condition_name}")
            return [entry for entry in entries if entry["name"] == definition.key]
        return entries

    def stored_annotation_fields(self, field_name: str | None = None) -> list[dict[str, Any]]:
        """Inventory every serialized condition/mask/annotation field, including unknown future ones."""

        fields: list[dict[str, Any]] = []

        def json_value(value: Any) -> Any:
            value = value.item() if isinstance(value, np.generic) else value
            if isinstance(value, float) and not np.isfinite(value):
                return None
            return value

        categories = sorted(
            category
            for category in self.array.get_annotation_categories()
            if category.startswith(("mask_", "condition_", "annotation_"))
        )
        for category in categories:
            annotation = np.asarray(self.array.get_annotation(category))
            values: list[dict[str, Any]] = []
            truncated = False
            if annotation.ndim == 1:
                unique, counts = np.unique(annotation, return_counts=True)
                truncated = len(unique) > 64
                for value, count in zip(unique[:64], counts[:64], strict=True):
                    if isinstance(value, float | np.floating) and np.isnan(value):
                        value_mask = np.isnan(annotation)
                    else:
                        value_mask = annotation == value
                    indices = np.flatnonzero(value_mask).astype(int).tolist()
                    values.append(
                        {
                            "label": str(json_value(value)),
                            "value": json_value(value),
                            "count": int(count),
                            "atom_indices": indices,
                        }
                    )
            else:
                finite = np.isfinite(annotation).any(axis=tuple(range(1, annotation.ndim)))
                indices = np.flatnonzero(finite).astype(int).tolist()
                values.append(
                    {
                        "label": f"Stored {tuple(annotation.shape[1:])} values",
                        "count": len(indices),
                        "atom_indices": indices,
                    }
                )
            fields.append(
                {
                    "name": category,
                    "label": category,
                    "count": len(annotation),
                    "unit": "rows",
                    "values": values,
                    "truncated": truncated,
                }
            )

        if field_name is not None:
            return [field for field in fields if field["name"] == field_name]
        return fields

    def scalar_annotation_fields(self, field_name: str | None = None) -> list[dict[str, Any]]:
        """Expose per-atom confidence fields as stable color buckets."""

        palette = [
            ("Very low (<50)", 0.0, 50.0, {"name": "red", "value": 0xEF5350}),
            ("Low (50-70)", 50.0, 70.0, {"name": "orange", "value": 0xFFA726}),
            ("Confident (70-90)", 70.0, 90.0, {"name": "yellow", "value": 0xFFD54F}),
            ("Very high (≥90)", 90.0, float("inf"), {"name": "blue", "value": 0x42A5F5}),
        ]
        fields = []
        for category in sorted(self.array.get_annotation_categories()):
            lowered = category.lower()
            if category != "b_factor" and "plddt" not in lowered and "confidence" not in lowered:
                continue
            annotation = np.asarray(self.array.get_annotation(category))
            if annotation.ndim != 1 or not np.issubdtype(annotation.dtype, np.number):
                continue
            values = annotation.astype(float)
            finite = np.isfinite(values)
            if not finite.any() or np.nanmax(np.abs(values[finite])) == 0:
                continue
            display_values = values * 100.0 if np.nanmax(values[finite]) <= 1.0 else values
            groups = []
            for label, minimum, maximum, color in palette:
                mask = finite & (display_values >= minimum) & (display_values < maximum)
                indices = np.flatnonzero(mask).astype(int).tolist()
                if indices:
                    groups.append(
                        {
                            "label": label,
                            "count": len(indices),
                            "atom_indices": indices,
                            "color": color,
                        }
                    )
            if groups:
                fields.append(
                    {
                        "name": category,
                        "label": "pLDDT / confidence" if category == "b_factor" else category,
                        "count": int(finite.sum()),
                        "unit": "atoms",
                        "values": groups,
                    }
                )
        if field_name is not None:
            return [field for field in fields if field["name"] == field_name]
        return fields

    def atom_annotation_details(self, atom_index: int) -> dict[str, Any]:
        index = int(self.resolve_indices([atom_index])[0])
        annotations = []
        for entry in self.annotation_details():
            matching_values = []
            for value in entry["values"]:
                if index in value["atom_indices"]:
                    matching_values.append({key: item for key, item in value.items() if key != "atom_indices"})
            if matching_values:
                annotations.append(
                    {
                        "name": entry["name"],
                        "label": entry["label"],
                        "values": matching_values,
                    }
                )
        stored_fields = []
        for field in self.stored_annotation_fields():
            for value in field["values"]:
                if index in value["atom_indices"]:
                    stored_fields.append(
                        {
                            "name": field["name"],
                            "value": value.get("value"),
                            "label": value["label"],
                        }
                    )
                    break
        scalar_fields = []
        for field in self.scalar_annotation_fields():
            value = self.array.get_annotation(field["name"])[index]
            scalar_fields.append(
                {
                    "name": field["name"],
                    "label": field["label"],
                    "value": float(value),
                }
            )
        chain_key = "chain_iid" if "chain_iid" in self.array.get_annotation_categories() else "chain_id"
        result: dict[str, Any] = {
            "atom_index": index,
            "chain": str(self.array.get_annotation(chain_key)[index]),
            "chain_id": str(self.array.chain_id[index]),
            "residue_id": int(self.array.res_id[index]),
            "residue_name": str(self.array.res_name[index]),
            "atom_name": str(self.array.atom_name[index]),
            "annotations": annotations,
            "stored_fields": stored_fields,
            "scalar_fields": scalar_fields,
        }
        if "charge" in self.array.get_annotation_categories():
            result["formal_charge"] = int(self.array.charge[index])
        return result

    def resolve_indices(self, indices: list[int], scope: ConditionScope = "atom") -> np.ndarray:
        if not indices:
            raise ValueError("at least one atom must be selected")
        selected = np.unique(np.asarray(indices, dtype=np.int64))
        if selected[0] < 0 or selected[-1] >= len(self.array):
            raise IndexError(f"atom index outside [0, {len(self.array) - 1}]")
        if scope == "atom":
            return selected

        mask = np.zeros(len(self.array), dtype=bool)
        if scope == "chain":
            chain_key = "chain_iid" if "chain_iid" in self.array.get_annotation_categories() else "chain_id"
            chains = np.unique(self.array.get_annotation(chain_key)[selected])
            mask = np.isin(self.array.get_annotation(chain_key), chains)
        elif scope == "residue":
            chain_key = "chain_iid" if "chain_iid" in self.array.get_annotation_categories() else "chain_id"
            ins_code = (
                self.array.ins_code
                if "ins_code" in self.array.get_annotation_categories()
                else np.full(len(self.array), "")
            )
            for index in selected:
                mask |= (
                    (self.array.get_annotation(chain_key) == self.array.get_annotation(chain_key)[index])
                    & (self.array.res_id == self.array.res_id[index])
                    & (ins_code == ins_code[index])
                )
        else:
            raise ValueError(f"unsupported selection scope: {scope}")
        return np.flatnonzero(mask)

    def query_indices(
        self,
        expression: str,
        *,
        syntax: Literal["expression", "path"] = "expression",
        scope: ConditionScope = "atom",
    ) -> np.ndarray:
        """Resolve a safe AtomWorks query into document atom indices."""
        if not expression.strip():
            raise ValueError("selection query must not be empty")
        if syntax == "expression":
            selected = np.flatnonzero(resolve_mask(self.array, expression))
        elif syntax == "path":
            selected = np.flatnonzero(
                AtomSelectionStack.from_query(expression).get_mask(self.array, raise_on_empty=False)
            )
        else:
            raise ValueError(f"unsupported AtomWorks query syntax: {syntax}")
        if len(selected) == 0:
            return selected.astype(np.int64)
        return self.resolve_indices(selected.tolist(), scope)

    def set_condition(
        self,
        name: str,
        indices: list[int],
        *,
        enabled: bool = True,
        value: int | float | str | list[int | float] | None = None,
        scope: ConditionScope = "atom",
        allow_target_discard: bool = False,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        spec = self.condition_provider.definitions_by_name.get(name)
        if spec is None:
            raise ValueError(f"unsupported condition: {name}")
        selected = self.resolve_indices(indices, scope)
        if spec.whole_residues:
            selected = self.resolve_indices(selected.tolist(), "residue")
        self._set_condition(
            name,
            selected.tolist(),
            enabled=enabled,
            value=value,
            allow_target_discard=allow_target_discard,
            expected_revision=expected_revision,
        )
        return {
            "affected_count": len(selected),
            "message": f"{'Applied' if enabled else 'Removed'} {spec.label} on {len(selected)} atoms.",
        }

    def _set_condition(
        self,
        name: str,
        indices: list[int],
        *,
        enabled: bool = True,
        value: int | float | str | list[int | float] | None = None,
        scope: ConditionScope = "atom",
        allow_target_discard: bool = False,
        expected_revision: int | None = None,
    ) -> None:
        with self._condition_edit(name, allow_target_discard, expected_revision):
            if name not in self.condition_provider.definitions_by_name:
                raise ValueError(f"unsupported condition: {name}")
            selected = self.resolve_indices(indices, scope)
            spec = self.condition_provider.definitions_by_name[name]
            condition = spec.condition
            if spec.whole_residues:
                selected = self.resolve_indices(selected.tolist(), "residue")
            if enabled and spec.normalize_value is not None:
                value = spec.normalize_value(value)
            if spec.mutate is not None:
                spec.mutate(self.array, selected, enabled, value)
                self.condition_provider.after_condition_update(spec.key, self.array)
                return
            if spec.kind == "operation":
                raise ValueError(f"{name} is applied via its operation endpoint, not set_condition")
            if spec.kind == "pair":
                if condition is not C_DIS:
                    raise ValueError(f"{name} is a pair annotation without a registered mutation handler")
                if len(selected) != 2:
                    raise ValueError(f"{name} requires exactly two different atoms")
                if value is not None and (isinstance(value, bool) or not isinstance(value, int | float)):
                    raise ValueError(f"{name} requires a numeric pair value")
                pair_value = None if value is None else float(value)
                self.edit_distance_restraint(
                    int(selected[0]),
                    int(selected[1]),
                    "set" if enabled else "remove",
                    pair_value,
                )
                return
            if spec.kind == "mask":
                set_condition_mask(self.array, condition, selected, enabled, invert=spec.invert_mask)
                self.condition_provider.after_condition_update(spec.key, self.array)
                return
            if spec.kind == "vector3":
                annotation = np.asarray(condition.annotation(self.array, default="generate")).copy()
                mask = np.asarray(condition.mask(self.array, default="generate")).copy()
                if enabled:
                    vector = np.asarray(value, dtype=np.float32)
                    if vector.shape != (3,) or not np.isfinite(vector).all():
                        raise ValueError("chain_centroid requires three finite coordinates")
                    annotation[selected] = vector
                    mask[selected] = True
                else:
                    annotation[selected] = np.nan
                    mask[selected] = False
                condition.set_annotation(self.array, annotation)
                set_annotation_mask(condition, self.array, mask)
                return
            annotation = np.asarray(condition.annotation(self.array, default="generate")).copy()
            default = spec.default
            if enabled and value is None:
                raise ValueError(f"{name} requires a value")
            if enabled and spec.kind == "text" and not isinstance(value, str):
                raise ValueError(f"{name} requires a text value")
            if enabled and spec.kind == "enum":
                allowed = {member.value for member in spec.enum_values}
                if isinstance(value, bool) or value not in allowed:
                    raise ValueError(f"{name} value must be one of {sorted(allowed)}")
            if enabled and spec.kind == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
                raise ValueError(f"{name} requires an integer value")
            if (
                enabled
                and spec.kind == "scalar"
                and (isinstance(value, bool) or not isinstance(value, int | float) or not np.isfinite(value))
            ):
                raise ValueError(f"{name} requires a finite numeric value")
            if spec.kind == "text":
                annotation = annotation.astype(object)
            annotation[selected] = value if enabled else np.asarray(condition.default_annotation(self.array))[selected]
            if spec.kind == "text":
                annotation = annotation.astype(str)
            condition.set_annotation(self.array, annotation)
            if spec.kind in {"enum", "text", "scalar"}:
                mask = np.asarray(condition.mask(self.array, default="generate")).copy()
                mask[selected] = enabled and value != default
                set_annotation_mask(condition, self.array, mask)
            self.condition_provider.after_condition_update(spec.key, self.array)

    def apply_selection_transform(
        self,
        indices: list[int],
        scope: ConditionScope,
        transform: ConditionOperation,
        enabled: bool,
        *,
        operation_name: str | None = None,
        allow_target_discard: bool = False,
        expected_revision: int | None = None,
    ) -> dict[str, object] | None:
        """Apply a provider-supplied in-place array transform to the resolved selection, with undo."""
        with self._condition_edit(operation_name or transform.__name__, allow_target_discard, expected_revision):
            selected = self.resolve_indices(indices, scope)
            return transform(self.array, selected, enabled)

    def condition_groups(self, name: str) -> list[dict[str, Any]]:
        """List the groups offered by both editors, including the unassigned index group."""
        spec = self.condition_provider.definitions_by_name[name]
        if not spec.group_editor:
            raise ValueError(f"{name} is not a group condition")
        values, counts = np.unique(spec.condition.annotation(self.array, default="generate"), return_counts=True)
        return [
            {"id": int(value), "count": int(count), "can_delete": bool(value != spec.default)}
            for value, count in zip(values, counts, strict=True)
            if value not in spec.reserved_group_ids
        ]

    def edit_condition_group(
        self,
        name: str,
        action: Literal["new", "add", "remove", "delete"],
        indices: list[int],
        *,
        group_id: int | None = None,
        scope: ConditionScope = "atom",
        allow_target_discard: bool = False,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        """Apply the desktop group actions through the common confirmation/undo transaction."""
        spec = self.condition_provider.definitions_by_name[name]
        if not spec.group_editor:
            raise ValueError(f"{name} is not a group condition")
        with self._condition_edit(spec.key, allow_target_discard, expected_revision):
            values = spec.condition.annotation(self.array, default="generate")
            if action in ("add", "delete"):
                if group_id is None or group_id not in {group["id"] for group in self.condition_groups(name)}:
                    raise ValueError("Pick an existing group first")
                if action == "delete" and group_id == spec.default:
                    raise ValueError("The unassigned group cannot be deleted")
            if action == "new":
                group_id = max(int(np.max(values, initial=0)) + 1, 1)
                while group_id in spec.reserved_group_ids:
                    group_id += 1
            if action == "delete":
                selected = np.flatnonzero(values == group_id)
            elif action in ("new", "add", "remove"):
                selected = self.resolve_indices(indices, scope)
            else:
                raise ValueError(f"Unsupported group action: {action}")
            reset_to_unassigned = action in ("remove", "delete") and not spec.reserved_group_ids
            self.set_condition(
                name,
                selected.tolist(),
                enabled=action in ("new", "add") or reset_to_unassigned,
                value=int(spec.default) if reset_to_unassigned else group_id,
                allow_target_discard=allow_target_discard,
            )
            count = len(selected)
            message = {
                "new": f"Created group {group_id} with {count} atoms.",
                "add": f"Added {count} atoms to group {group_id}.",
                "remove": f"Restored default group assignments for {count} atoms.",
                "delete": f"Deleted group {group_id} ({count} atoms reassigned).",
            }[action]
            return {"group_id": group_id, "affected_count": count, "message": message}

    def chain_centroids(self, name: str) -> list[dict[str, Any]]:
        """Return saved targets and the desktop's NaN-aware current centroids."""
        spec = self.condition_provider.definitions_by_name[name]
        if spec.kind != "vector3" or spec.level.value != "chain":
            raise ValueError(f"{name} is not a chain centroid condition")
        annotation = spec.condition.annotation(self.array, default="generate")
        result = []
        for chain in np.unique(self.array.chain_iid):
            mask = self.array.chain_iid == chain
            coords = self.array.coord[mask]
            current = np.nanmean(coords, axis=0) if np.isfinite(coords).any(axis=0).all() else None
            target = annotation[mask][0]
            result.append(
                {
                    "chain": str(chain),
                    "current": current.tolist() if current is not None and np.isfinite(current).all() else None,
                    "target": target.tolist() if np.isfinite(target).all() else None,
                }
            )
        return result

    def edit_chain_centroid(
        self,
        name: str,
        chain: str,
        value: list[float] | None,
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        if chain not in {entry["chain"] for entry in self.chain_centroids(name)}:
            raise ValueError(f"Unknown chain: {chain}")
        self.set_condition(
            name,
            np.flatnonzero(self.array.chain_iid == chain).tolist(),
            scope="chain",
            value=value,
            enabled=value is not None,
            expected_revision=expected_revision,
        )
        return {"message": f"{'Set' if value is not None else 'Cleared'} centroid for chain {chain!r}."}

    def condition_editor_state(self) -> dict[str, Any]:
        return {
            "groups": {
                spec.key: self.condition_groups(spec.key)
                for spec in self.condition_provider.definitions
                if spec.group_editor
            },
            "centroids": {
                spec.key: self.chain_centroids(spec.key)
                for spec in self.condition_provider.definitions
                if spec.kind == "vector3" and spec.level.value == "chain"
            },
            "restraints": self.distance_restraints(),
        }

    def protonate(self, ph: float = 7.4) -> dict[str, Any]:
        """Update the whole structure's protonation state as one undoable edit."""
        if not np.isfinite(ph) or not 0 <= ph <= 14:
            raise ValueError("pH must be a finite number between 0 and 14")
        with self.edit(), custom_ccd_residues(self.array._custom_ccd_registry):
            self.array = as_atom_array_plus(add_hydrogens(self.array, ph=ph))
        count = int(np.count_nonzero(self.array.element == "H"))
        return {"message": f"Protonated at pH {ph:g}; {count} hydrogen atoms.", "hydrogen_count": count}

    def set_charge(self, indices: list[int], value: int | None = None, delta: int | None = None) -> None:
        with self.edit():
            selected = self.resolve_indices(indices)
            set_formal_charge(self.array, selected, value=value, delta=delta)

    def assign_chain(self, indices: list[int], chain_id: str) -> None:
        with self.edit():
            selected = self.resolve_indices(indices)
            assign_chain_id(self.array, selected, chain_id)

    def edit_bond(self, atom1: int, atom2: int, action: Literal["add", "remove"], bond_type: str = "SINGLE") -> None:
        with self.edit():
            selected = self.resolve_indices([atom1, atom2])
            if len(selected) != 2:
                raise ValueError("a bond requires two different atoms")
            mutate_bond(
                self.array,
                int(selected[0]),
                int(selected[1]),
                action,
                BOND_TYPES[bond_type],
            )

    def delete_atoms(self, indices: list[int], close_residue_gaps: bool = False) -> None:
        with self.edit():
            selected = self.resolve_indices(indices)
            keep = np.ones(len(self.array), dtype=bool)
            keep[selected] = False
            if not keep.any():
                raise ValueError("cannot delete every atom")
            self.array = mutate_delete_atoms(
                self.array,
                keep,
                close_res_id_gaps=close_residue_gaps,
            )

    def reset_residue_ids(self) -> None:
        with self.edit():
            for chain in np.unique(self.array.chain_iid):
                mask = self.array.chain_iid == chain
                self.array.res_id[mask] -= int(self.array.res_id[mask].min()) - 1

    def insert_segment(
        self,
        minimum: int,
        maximum: int,
        atom_index: int | None = None,
        *,
        before: bool = True,
        new_chain: bool = False,
        chain_id: str | None = None,
        chain_type: str | None = None,
    ) -> None:
        with self.edit():
            if atom_index is not None and not new_chain:
                selected = int(self.resolve_indices([atom_index])[0])
                bounds = struc.get_residue_starts(self.array, add_exclusive_stop=True)
                residue = int(np.searchsorted(bounds[:-1], selected, side="right")) - 1
                atom_index = int(bounds[residue] if before else bounds[residue + 1] - 1)
            self.array = insert_expandable_segment(
                self.array,
                minimum,
                maximum,
                atom_idx=atom_index,
                insert_before=before,
                new_chain=new_chain,
                new_chain_id=chain_id,
                new_chain_type=chain_type,
            )

    def realize_segments(self, seed: int | None = None) -> None:
        with self.edit():
            self.array = realize_expandable_segments(self.array, np.random.default_rng(seed))

    def collapse_segments(self) -> None:
        with self.edit():
            self.array = collapse_expandable_segments(self.array)

    def align_to(self, reference: StudioDocument) -> dict[str, float | int]:
        """Rigidly align common protein-backbone atoms to a reference document."""

        with self.edit():

            def identity_map(array: AtomArrayPlus) -> dict[tuple[str, int, str, str], int]:
                ins_codes = (
                    array.ins_code if "ins_code" in array.get_annotation_categories() else np.full(len(array), "")
                )
                mapping: dict[tuple[str, int, str, str], int] = {}
                duplicates: set[tuple[str, int, str, str]] = set()
                for index in range(len(array)):
                    key = (
                        str(array.chain_id[index]),
                        int(array.res_id[index]),
                        str(ins_codes[index]),
                        str(array.atom_name[index]),
                    )
                    if key in mapping:
                        duplicates.add(key)
                    else:
                        mapping[key] = index
                for key in duplicates:
                    mapping.pop(key, None)
                return mapping

            moving = identity_map(self.array)
            target = identity_map(reference.array)
            common = sorted(set(moving) & set(target))
            backbone = {"N", "CA", "C", "O"}
            common_backbone = [key for key in common if key[3] in backbone]
            keys = common_backbone if len(common_backbone) >= 3 else common
            pairs = [
                (moving[key], target[key])
                for key in keys
                if np.isfinite(self.array.coord[moving[key]]).all()
                and np.isfinite(reference.array.coord[target[key]]).all()
            ]
            if len(pairs) < 3:
                raise ValueError("alignment requires at least three common finite-coordinate atoms")

            moving_indices, target_indices = zip(*pairs, strict=True)
            moving_coords = self.array.coord[list(moving_indices)].astype(np.float64)
            target_coords = reference.array.coord[list(target_indices)].astype(np.float64)
            moving_center = moving_coords.mean(axis=0)
            target_center = target_coords.mean(axis=0)
            centered_moving = moving_coords - moving_center
            centered_target = target_coords - target_center
            u_matrix, _, v_transpose = np.linalg.svd(centered_moving.T @ centered_target)
            if np.linalg.det(u_matrix @ v_transpose) < 0:
                v_transpose[-1] *= -1
            rotation = u_matrix @ v_transpose
            before = float(np.sqrt(np.mean(np.sum((moving_coords - target_coords) ** 2, axis=1))))
            aligned_matches = centered_moving @ rotation + target_center
            after = float(np.sqrt(np.mean(np.sum((aligned_matches - target_coords) ** 2, axis=1))))

            finite = np.isfinite(self.array.coord).all(axis=1)
            transformed = self.array.coord[finite].astype(np.float64)
            self.array.coord[finite] = ((transformed - moving_center) @ rotation + target_center).astype(
                self.array.coord.dtype
            )
            return {
                "matched_atom_count": len(pairs),
                "rmsd_before": before,
                "rmsd_after": after,
            }

    def combine(self, others: list[StudioDocument]) -> None:
        with self.edit():
            arrays = [copy.deepcopy(self.array), *(copy.deepcopy(other.array) for other in others)]
            used: set[str] = set()
            for array in arrays:
                chains = np.unique(array.chain_id)
                available = {chain for chain in chains if chain not in used}
                generator = create_chain_id_generator(used | available)
                renames = {chain: next(generator) for chain in chains if chain in used}
                if renames:
                    array.chain_id = np.array([renames.get(chain, chain) for chain in array.chain_id])
                used.update(available)
                used.update(renames.values())
            prepare = getattr(self.condition_provider, "prepare_combination", None)
            if prepare is not None:
                arrays = prepare(arrays)
            self.array = concatenate_atom_array_plus(
                arrays, fill_missing_standard_annotations=True, on_annotation_mismatch_policy="raise"
            )
            refresh_chain_derived_annotations(self.array)
            self.condition_provider.after_condition_update("index", self.array)

    def inspect_bonds(self, atom_index: int | None = None) -> list[dict[str, Any]]:
        """Return covalent bonds, optionally restricted to one atom."""
        if atom_index is not None:
            atom_index = int(self.resolve_indices([atom_index])[0])
        if self.array.bonds is None:
            return []
        bonds = []
        for atom1, atom2, bond_type in self.array.bonds.as_array():
            atom1, atom2, bond_type = int(atom1), int(atom2), int(bond_type)
            if atom_index is not None and atom_index not in (atom1, atom2):
                continue
            bonds.append(
                {
                    "atom1": atom1,
                    "atom2": atom2,
                    "bond_type": BOND_TYPE_NAMES.get(bond_type, str(bond_type)),
                    "distance": float(np.linalg.norm(self.array.coord[atom1] - self.array.coord[atom2])),
                }
            )
        return bonds

    def infer_bonds_from_ccd(self) -> None:
        """Merge bonds inferred by AtomWorks' CCD templates into the document."""
        with self.edit():
            result = infer_bonds_from_residue_names(self.array, sanitize=False)
            if result is not None:
                self.array = as_atom_array_plus(result)

    def distance_restraints(self) -> list[dict[str, Any]]:
        annotation = C_DIS.annotation(self.array, default="generate")
        restraints = []
        seen: set[tuple[int, int]] = set()
        for pair, value in zip(annotation.pairs, annotation.values, strict=True):
            atom1, atom2 = sorted((int(pair[0]), int(pair[1])))
            if atom1 == atom2 or (atom1, atom2) in seen:
                continue
            seen.add((atom1, atom2))
            restraints.append(
                {
                    "atom1": atom1,
                    "atom2": atom2,
                    "atom1_label": self.atom_label(atom1),
                    "atom2_label": self.atom_label(atom2),
                    "distance": float(value),
                    "current_distance": self.atom_distance(atom1, atom2),
                }
            )
        return restraints

    def atom_label(self, index: int) -> str:
        self.resolve_indices([index])
        array = self.array
        ins = array.ins_code[index] if "ins_code" in array.get_annotation_categories() else ""
        return f"{array.chain_iid[index]}/{array.res_name[index]} {array.res_id[index]}{ins}/{array.atom_name[index]}"

    def atom_distance(self, atom1: int, atom2: int) -> float | None:
        self.resolve_indices([atom1, atom2])
        value = float(np.linalg.norm(self.array.coord[atom1] - self.array.coord[atom2]))
        return value if np.isfinite(value) else None

    def replace_distance_restraints(
        self,
        pairs: list[tuple[int, int]],
        values: list[float],
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        with self._condition_edit("distance", False, expected_revision):
            replace_distance_restraints(self.array, pairs, values)
        return {"message": f"Saved {len(self.distance_restraints())} distance restraints."}

    def edit_distance_restraint(
        self,
        atom1: int,
        atom2: int,
        action: Literal["set", "remove"],
        distance: float | None = None,
    ) -> None:
        with self.edit():
            selected = self.resolve_indices([atom1, atom2])
            if len(selected) != 2:
                raise ValueError("a distance restraint requires two different atoms")
            pair = tuple(sorted((int(selected[0]), int(selected[1]))))
            mutate_distance_restraint(self.array, pair[0], pair[1], action, distance)

    def analyze_interactions(
        self,
        *,
        interaction_types: tuple[str, ...] = INTERACTION_TYPES,
        hbond_model: Literal["rosetta", "plip"] = "rosetta",
        inter_chain_only: bool = True,
        source_atom_indices: tuple[int, ...] = (),
        target_atom_indices: tuple[int, ...] = (),
    ) -> dict[str, Any]:
        """Run AtomWorks interaction annotation without mutating the document."""
        source = (
            tuple(int(value) for value in self.resolve_indices(list(source_atom_indices)))
            if source_atom_indices
            else ()
        )
        target = (
            tuple(int(value) for value in self.resolve_indices(list(target_atom_indices)))
            if target_atom_indices
            else ()
        )
        cache_key = (self.revision, interaction_types, hbond_model, inter_chain_only, source, target)
        if cache_key in self._interaction_cache:
            response = copy.deepcopy(self._interaction_cache[cache_key])
            response["cached"] = True
            return response

        analysis_input = copy.deepcopy(self.array)
        # Interaction chemistry uses live atoms, bonds and formal charges, not
        # model targets. Avoid sending editor fields through protonation's
        # annotation inheritance path (which differs across AtomWorks versions).
        categories = set(analysis_input.get_annotation_categories())
        for annotation in STANDARD_ANNOTATIONS:
            if annotation.n_body != 1:
                continue
            names = {annotation.full_name, *annotation.aliases}
            if hasattr(annotation, "mask_name"):
                names.add(annotation.mask_name)
            for name in names & categories:
                analysis_input.del_annotation(name)
                categories.remove(name)
        analyzed = AnnotateInteractions(
            interaction_types=interaction_types,
            hbond_model=hbond_model,
            inter_chain_only=inter_chain_only,
            silence_rdkit_warnings=True,
        )({"atom_array": analysis_input})["atom_array"]
        source_set, target_set = set(source), set(target)
        interactions = []
        for interaction_type in interaction_types:
            annotation = analyzed.get_annotation(INTERACTION_ANNOTATIONS[interaction_type], n_body=2)
            roles = INTERACTION_ROLES[interaction_type]
            for pair, value in zip(annotation.pairs, annotation.values, strict=True):
                atom1, atom2 = int(pair[0]), int(pair[1])
                role1, role2 = roles
                if source_set and target_set:
                    if atom1 in source_set and atom2 in target_set:
                        pass
                    elif atom2 in source_set and atom1 in target_set:
                        atom1, atom2, role1, role2 = atom2, atom1, role2, role1
                    else:
                        continue
                elif source_set:
                    if atom1 not in source_set and atom2 in source_set:
                        atom1, atom2, role1, role2 = atom2, atom1, role2, role1
                    elif atom1 not in source_set:
                        continue
                elif target_set:
                    if atom2 not in target_set and atom1 in target_set:
                        atom1, atom2, role1, role2 = atom2, atom1, role2, role1
                    elif atom2 not in target_set:
                        continue
                item = {
                    "type": INTERACTION_FAMILIES[interaction_type],
                    "interaction_type": interaction_type,
                    "atom1": atom1,
                    "atom2": atom2,
                    "atom1_role": role1,
                    "atom2_role": role2,
                    "distance": float(np.linalg.norm(self.array.coord[atom1] - self.array.coord[atom2])),
                }
                if interaction_type == "pistacking":
                    item["subtype"] = "parallel" if int(value) == int(InteractionType.PISTACKING_P) else "t_shaped"
                elif interaction_type == "pication":
                    item["subtype"] = "cation"
                interactions.append(item)

        response = {
            "revision": self.revision,
            "cached": False,
            "interaction_count": len(interactions),
            "interactions": interactions,
        }
        self._interaction_cache[cache_key] = copy.deepcopy(response)
        return response

    def validate(self, full_pipeline: bool = False) -> list[dict[str, str]]:
        issues = validate_atom_array_for_save(self.array) if full_pipeline else validate_atom_array(self.array)
        issues.extend(self.validation_provider.validate(self.array, full_pipeline=full_pipeline))
        return issues

    def sequence_view(self) -> list[dict[str, Any]]:
        """Return a compact chain/residue model for the interactive sequence strip."""
        chain_key = "chain_iid" if "chain_iid" in self.array.get_annotation_categories() else "chain_id"
        residue_bounds = struc.get_residue_starts(self.array, add_exclusive_stop=True)
        if len(residue_bounds) < 2:
            return []

        condition_masks: dict[str, np.ndarray] = {}
        for key in ("sequence", "coordinate", "index", "hotspot"):
            definition = self.condition_provider.definitions_by_name.get(key)
            if definition is not None:
                condition_masks[key] = definition.condition.mask(self.array, default="generate")

        has_segments = has_stored_mask(S_SEGMIN, self.array) and has_stored_mask(S_SEGMAX, self.array)
        segment_mask = S_SEGMIN.mask(self.array) if has_segments else np.zeros(len(self.array), dtype=bool)
        segment_min = S_SEGMIN.annotation(self.array) if has_segments else np.zeros(len(self.array), dtype=int)
        segment_max = S_SEGMAX.annotation(self.array) if has_segments else np.zeros(len(self.array), dtype=int)
        chains: list[dict[str, Any]] = []

        residue_index = 0
        while residue_index < len(residue_bounds) - 1:
            start = int(residue_bounds[residue_index])
            chain_id = str(self.array.get_annotation(chain_key)[start])
            items: list[dict[str, Any]] = []
            while residue_index < len(residue_bounds) - 1:
                start = int(residue_bounds[residue_index])
                stop = int(residue_bounds[residue_index + 1])
                if str(self.array.get_annotation(chain_key)[start]) != chain_id:
                    break
                if segment_mask[start]:
                    realized = str(self.array.res_name[start]) == MASKED
                    minimum = int(segment_min[start])
                    maximum = int(segment_max[start])
                    run_start = residue_index
                    while residue_index + 1 < len(residue_bounds) - 1:
                        next_start = int(residue_bounds[residue_index + 1])
                        if (
                            str(self.array.get_annotation(chain_key)[next_start]) != chain_id
                            or not segment_mask[next_start]
                            or (str(self.array.res_name[next_start]) == MASKED) != realized
                            or int(segment_min[next_start]) != minimum
                            or int(segment_max[next_start]) != maximum
                        ):
                            break
                        residue_index += 1
                    run_stop = int(residue_bounds[residue_index + 1])
                    items.append(
                        {
                            "kind": "segment",
                            "atom_indices": list(range(int(residue_bounds[run_start]), run_stop)),
                            "minimum": minimum,
                            "maximum": maximum,
                            "realized": realized,
                            "realized_length": residue_index - run_start + 1 if realized else None,
                        }
                    )
                else:
                    conditions = [key for key, mask in condition_masks.items() if bool(np.any(mask[start:stop]))]
                    residue_name = str(self.array.res_name[start])
                    items.append(
                        {
                            "kind": "residue",
                            "atom_indices": list(range(start, stop)),
                            "residue_id": int(self.array.res_id[start]),
                            "residue_name": residue_name,
                            "code": RESIDUE_CODES.get(residue_name, residue_name),
                            "conditions": conditions,
                        }
                    )
                residue_index += 1
            chains.append({"chain_id": chain_id, "items": items})
        return chains

    def summary(self) -> dict[str, Any]:
        chain_key = "chain_iid" if "chain_iid" in self.array.get_annotation_categories() else "chain_id"
        details = self.annotation_details()
        annotations = [
            {
                **{key: value for key, value in entry.items() if key != "values"},
                "values": [
                    {key: value for key, value in item.items() if key != "atom_indices"} for item in entry["values"]
                ],
            }
            for entry in details
        ]
        stored_fields = [
            {
                **{key: value for key, value in field.items() if key != "values"},
                "values": [
                    {key: value for key, value in item.items() if key != "atom_indices"} for item in field["values"]
                ],
            }
            for field in self.stored_annotation_fields()
        ]
        scalar_fields = [
            {
                **{key: value for key, value in field.items() if key != "values"},
                "values": [
                    {key: value for key, value in item.items() if key != "atom_indices"} for item in field["values"]
                ],
            }
            for field in self.scalar_annotation_fields()
        ]
        return {
            "name": self.name,
            "revision": self.revision,
            "atom_count": len(self.array),
            "condition_editors": self.condition_editor_state(),
            "chain_ids": sorted(str(value) for value in np.unique(self.array.get_annotation(chain_key))),
            "sequence": self.sequence_view(),
            "condition_counts": {entry["name"]: entry["count"] for entry in details},
            "annotations": annotations,
            "stored_fields": stored_fields,
            "scalar_fields": scalar_fields,
            "undo_depth": len(self._undo),
            "validation": self.validate(),
        }

    def to_cif(self) -> str:
        return self._array_to_cif(self.array)

    @staticmethod
    def _array_to_cif(array: AtomArrayPlus) -> str:
        config = CIFWriteConfig(
            include_entity_categories=True,
            save_standard_annotations=True,
            chain_disambiguation="chain_iid",
        )
        return to_cif_string(array, config=config)
