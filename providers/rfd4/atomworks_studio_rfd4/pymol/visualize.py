"""Custom PyMOL view functions for rfproteina conditions.

Provides color-by-group views for :py:data:`~rfproteina.conditions.C_CRDGRP`
and :py:data:`~rfproteina.conditions.C_IDXGRP`, registered as
entries in :py:mod:`atomworks_studio_pymol.views`.

Only imported inside a running PyMOL process.
"""

import json
from importlib.resources import files

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks_studio_pymol.display import display_atom_ids
from pymol import cmd

from atomworks_studio_rfd4.model import C_CRDGRP, C_IDXGRP

# Colours for named CoordinateGroup constants and cycling relative groups
_CRDGRP_NAMED_COLORS = {
    -1: "gray60",  # UNKNOWN_COORDS
    0: "lightblue",  # KNOWN_ABSOLUTE_COORDS
}
# Annotation overlays use the same palette in web and native viewers.
_PALETTE_RGB: list[tuple[str, tuple[float, float, float]]] = [
    (f"aw_grp_{index:02d}", tuple(((color["value"] >> shift) & 255) / 255 for shift in (16, 8, 0)))
    for index, color in enumerate(
        json.loads(files("atomworks_studio_editing").joinpath("annotation_palette.json").read_text())
    )
]
_PALETTE = [name for name, _ in _PALETTE_RGB]


def _ensure_palette_registered() -> None:
    """Register the custom group colors with PyMOL (idempotent)."""
    for name, rgb in _PALETTE_RGB:
        cmd.set_color(name, list(rgb))


def color_by_coord_group(arr: AtomArrayPlus, obj_name: str) -> None:
    """Color *obj_name* by :py:data:`~rfproteina.conditions.C_CRDGRP`.

    No-op if the annotation is not present on *arr*.
    """
    groups = C_CRDGRP.annotation(arr, default="generate")
    _color_by_group(arr, obj_name, groups, named_colors=_CRDGRP_NAMED_COLORS)


def color_by_index_group(arr: AtomArrayPlus, obj_name: str) -> None:
    """Color *obj_name* by :py:data:`~rfproteina.conditions.C_IDXGRP`.

    Always generates a default if not explicitly annotated, since
    :py:class:`~rfproteina.conditions.IndexGroup` is derived from
    chain structure and is always well-defined.
    """
    groups = C_IDXGRP.annotation(arr, default="generate")
    _color_by_group(arr, obj_name, groups, named_colors={})


def _color_by_group(
    arr: AtomArrayPlus,
    obj_name: str,
    groups: np.ndarray,
    named_colors: dict[int, str],
) -> None:
    """Shared implementation: write group ids into b-factor, then color per group."""
    _ensure_palette_registered()

    unique_groups = sorted({int(g) for g in groups})
    cycled = [g for g in unique_groups if g not in named_colors]
    if len(cycled) > len(_PALETTE):
        from pymol.Qt import QtWidgets

        choices = [str(group) for group in unique_groups if group >= 0]
        selected, accepted = QtWidgets.QInputDialog.getItem(
            None,
            "Highlight a group",
            "Too many groups for distinct colors. Choose one to highlight:",
            choices,
            0,
            False,
        )
        if not accepted:
            return
        cmd.color("atomic", obj_name)
        selected = int(selected)
        ids = display_atom_ids(arr)[groups == selected]
        cmd.color(_PALETTE[0], f"model {obj_name} and id {'+'.join(str(int(atom)) for atom in ids)}")
        return

    color_for: dict[int, str] = dict(named_colors)
    for palette_color, group_val in zip(_PALETTE, cycled, strict=False):
        color_for[group_val] = palette_color

    lookup: dict[tuple[str, str, str], int] = {}
    for i in range(len(arr)):
        key = (arr.chain_iid[i], str(arr.res_id[i]), arr.atom_name[i])
        lookup[key] = int(groups[i])

    def _get_group(chain: str, resi: str, name: str) -> int:
        resi_clean = resi.rstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") or "0"
        return lookup.get((chain, resi_clean, name), -999)

    cmd.alter(obj_name, "b = _g(chain, resi, name)", space={"_g": _get_group})

    for group_val in unique_groups:
        cmd.color(color_for[group_val], f"{obj_name} and b={group_val}")


def _warn_too_many_chains_for_distinct_colors(n_chains: int, n_colors: int) -> None:
    """Warn (console + popup) that some chains will share a marker color."""
    msg = (
        f"{n_chains} chains need distinct colors but only {n_colors} are available. "
        "Some chains' centroid markers will share a color (labels still disambiguate them)."
    )
    print(f"AtomWorks: {msg}")
    try:
        from pymol.Qt import QtWidgets

        QtWidgets.QMessageBox.warning(None, "Too many chains to color distinctly", msg)
    except Exception:
        pass
