"""View registry for the AtomWorks PyMOL plugin.

A *view* is a callable ``(arr, obj_name) -> None`` that issues PyMOL
commands to style the named object. Views must not mutate the array.

The registry is a plain ordered dict keyed by display name. One view is
marked the **default** and is applied by every load/reload path in
:py:mod:`atomworks_studio_pymol.bridge`.
"""

import logging
from collections.abc import Callable

import numpy as np
from atomworks.io.utils.atom_array_plus import AtomArrayPlus
from atomworks.io.utils.standard_annotations import S_ATM
from atomworks_studio_editing.annotations import has_stored_mask
from atomworks_studio_pymol.display import (
    _DISPLAY_PLACEHOLDER,
    display_atom_ids,
    get_atom_array_style_cmd,
    prepare_for_display,
)
from atomworks_studio_pymol.state import STATE
from pymol import cmd

logger = logging.getLogger("atomworks_studio_pymol")

ViewFn = Callable[[AtomArrayPlus, str], None]

DEFAULT_VIEW_NAME = "Default"

VIEWS: dict[str, ViewFn] = {}

_default_view_name: str = DEFAULT_VIEW_NAME

# Selection generators are called by _default_view to create named PyMOL
# selections for condition annotations (e.g. rasa_buried_myprotein).
# Extensions register callables (arr, obj_name) -> None here.
_selection_generators: list[ViewFn] = []


def register_selection_generator(fn: ViewFn) -> None:
    """Register *fn* to create named PyMOL selections after the default view renders."""
    if fn not in _selection_generators:
        _selection_generators.append(fn)


def _run_selection_generators(arr: AtomArrayPlus, obj_name: str) -> None:
    for fn in _selection_generators:
        try:
            fn(arr, obj_name)
        except Exception:
            logger.warning("Selection generator %s failed", fn, exc_info=True)


def register_view(name: str, fn: ViewFn, *, make_default: bool = False) -> None:
    """Register *fn* under *name*, replacing any existing entry with that name."""
    global _default_view_name
    VIEWS[name] = fn
    if make_default:
        _default_view_name = name


def unregister_view(name: str) -> None:
    """Remove *name* from the registry; reset default if it was the default."""
    global _default_view_name
    VIEWS.pop(name, None)
    if _default_view_name == name:
        _default_view_name = DEFAULT_VIEW_NAME


def get_default_view_name() -> str:
    """Return the name of the current default view."""
    return _default_view_name


def set_default_view(name: str) -> None:
    """Set *name* as the default view.

    Raises:
      KeyError: If *name* is not a registered view.
    """
    if name not in VIEWS:
        raise KeyError(f"No such view: {name!r}. Available: {list(VIEWS)}")
    global _default_view_name
    _default_view_name = name


def apply_current_view(arr: AtomArrayPlus, obj_name: str) -> None:
    """
    Apply the current default view to *obj_name*.

    View fns must be handed an array whose atom layout matches what PyMOL has
    loaded, otherwise IDs diverge.  We always keep NaN-coord atoms (moved to
    their residue centroid) so the display array matches the CIF load exactly;
    when ``STATE.hide_nans`` is True those placeholder atoms are then hidden.
    """
    display = prepare_for_display(arr, nan_coord_policy="centroid")
    fn = VIEWS.get(_default_view_name) or VIEWS.get(DEFAULT_VIEW_NAME)
    if fn is None:
        logger.warning("apply_current_view: no views registered")
        return
    fn(display, obj_name)

    # Placeholder atoms (originally NaN coords) are kept in the object so they
    # stay selectable/editable, but hidden here so they never clutter any view.
    # Done after fn() so it applies uniformly to every registered view.
    if STATE.hide_nans and _DISPLAY_PLACEHOLDER in display.get_annotation_categories():
        placeholder = display.get_annotation(_DISPLAY_PLACEHOLDER).astype(bool)
        if placeholder.any():
            ids = display_atom_ids(display)[placeholder]
            cmd.hide("everything", f"{obj_name} and id {'+'.join(str(int(i)) for i in ids)}")


# ---------------------------------------------------------------------------
# Built-in views
# ---------------------------------------------------------------------------


def _default_view(arr: AtomArrayPlus, obj_name: str) -> None:
    """Canonical atomworks style — rainbow chains, sticks everywhere.

    Resets stale styling (colors, labels) from other views before applying the
    canonical style, so switching views is idempotent. Creates an
    ``atomize_{obj_name}`` selection only when a stored ``atomize`` mask is
    present (never from a generated default), then runs any registered selection
    generators.
    """
    cmd.color("atomic", obj_name)
    cmd.label(obj_name, '""')

    # "centroid" keeps placeholder atoms so the styled id space matches the
    # loaded object; apply_current_view hides them afterwards when requested.
    cmd.do(get_atom_array_style_cmd(arr, obj_name, nan_coord_policy="centroid"))

    cmd.show("sticks", obj_name)

    # Delete first so the selection never lingers when atomize is absent/empty.
    cmd.delete(f"atomize_{obj_name}")
    if has_stored_mask(S_ATM, arr):
        atomize_mask = S_ATM.mask(arr, default="raise")
        if atomize_mask.any():
            atom_ids = display_atom_ids(arr)[np.where(atomize_mask)[0]]
            id_expr = "+".join(str(int(i)) for i in atom_ids)
            # enable=0: create the selection without activating it, so it never
            # masquerades as the live ``sele`` selection.
            cmd.select(f"atomize_{obj_name}", f"model {obj_name} and id {id_expr}", enable=0)

    _run_selection_generators(arr, obj_name)


def _label_charges_view(arr: AtomArrayPlus, obj_name: str) -> None:
    """Label every non-zero charge on the AtomArray as e.g. ``+1``, ``-2``.

    Resolves PyMOL atoms back to AtomArrayPlus indices via
    :py:data:`STATE.index_maps`, which is keyed by
    ``(chain_id, res_id, ins_code, atom_name)``. PyMOL's ``alter`` namespace
    does not expose ``ins_code`` directly, so we parse it from ``resi``
    (e.g. ``"14A"`` → ``(14, "A")``) using the bridge helper.
    """
    from atomworks_studio_pymol.bridge import _pymol_resi_to_res_id_ins_code  # avoid circular import

    if "charge" not in arr.get_annotation_categories():
        raise ValueError("array must have 'charge' annotation to use this view")

    _default_view(arr, obj_name)

    index_map = STATE.index_maps.get(obj_name)
    if index_map is None:
        raise RuntimeError(f"no index_map for {obj_name!r}; object not tracked by plugin")

    charges = STATE.get_synced_array(obj_name).charge

    def _charge_label(chain: str, resi: str, name: str) -> str:
        try:
            res_id, ins_code = _pymol_resi_to_res_id_ins_code(resi)
        except ValueError:
            return ""
        idx = index_map.get((chain, res_id, ins_code, name))
        if idx is None:
            return ""
        c = int(charges[idx])
        return f"{c:+d}" if c != 0 else ""

    cmd.alter(
        obj_name,
        "label = _lbl(chain, resi, name)",
        space={"_lbl": _charge_label},
    )
    cmd.show("labels", obj_name)


register_view(DEFAULT_VIEW_NAME, _default_view, make_default=True)
register_view("Label charges", _label_charges_view)
