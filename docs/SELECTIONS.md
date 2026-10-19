# Selecting atoms

The browser and VS Code command bar has two modes. **AtomWorks query** selects
atoms in either renderer, using expressions or `sel()` for selection paths.
**PyMOL commands** selects and styles atoms through Patinae.

## Picking in the viewer

The **Pick** control is always visible in the viewer toolbar:

- **Atoms** (default): clicking a cartoon only reveals local sticks and focuses the view.
  Click atoms in those sticks to add or remove individual atoms.
- **Residues:** clicks toggle the whole residue, including clicks on sticks.
- **Chains:** clicks toggle the whole chain.

A click adds all targeted atoms if any are unselected, or removes them if all
are selected. Atoms outside that target never change. There is no automatic
refinement based on previous clicks and no modifier key is required. In Atoms mode, selecting
one atom within an already selected residue removes only that atom.

Showing local sticks and moving the camera do not change selection. **Clear
selection** empties the selection while leaving local sticks available. Query
and sequence-range selections explicitly replace the selection; pending canvas
requests are cancelled by Clear, replacement selections, picking-mode changes,
or document changes.

Clicking a residue in the sequence toggles that whole residue without changing
other selected atoms. Clicking a partially selected residue selects the rest of
it; clicking again removes it. Enter and Space behave the same way.

The sequence strip fills fully selected residues and partially fills residues
with only some atoms selected. All selection counts share the same editing state.

All actions use this same selection: condition edits, charges, bonds, deletion,
measurements, and selection styling. The Pick control determines what future
viewer clicks select; changing it or the condition type leaves existing selections
unchanged. Conditions that inherently operate on residues or chains apply to the
whole residues or chains containing selected atoms, using the same shared editing
logic as the native PyMOL plugin. The condition editor explains this expansion.

## AtomWorks query

Queries are expressions over the current structure's annotations. Studio uses
AtomWorks' `QueryExpression`; this field is not a Python console.

| Expression | Selects |
| --- | --- |
| `atom_name == 'CA'` | Alpha carbons. |
| `chain_id == 'A' and res_id >= 10 and res_id <= 20` | Residues 10–20 in chain A. |
| `element in ['N', 'O']` | Nitrogen and oxygen atoms. |
| `atom_name not in ['N', 'CA', 'C', 'O']` | Atoms outside those four names. |
| `has_bonds()` | Atoms participating in stored bonds. |
| `has_nan_coord()` | Atoms with missing coordinates. |
| `sel('[A,B]/*/*/CA')` | A path selection inside an expression. |

Use `and`, `or`, and `not`, or parenthesized comparisons with `&`, `|`, and `~`.
Names must be stored annotations, supported query functions, or annotations that
AtomWorks can derive. Derived fields are evaluated on a temporary copy; selecting
atoms does not change the saved document or undo history.

`chain_id` is the source chain identifier. Assembly copies can share it.
`chain_iid` identifies the chain instance shown in Studio; for example,
`chain_iid == 'A_1'` selects that instance if it exists. Inspect your structure
before assuming either identifier. `res_id` is a residue number, not its position
in the displayed sequence; `atom_id` is an annotation, not a zero-based row index.

## Selection paths

Use `sel('A/*/[10-20]/CA')` in **AtomWorks query** to select alpha carbons in
residues 10–20 of chain A. A path describes atoms, not a filesystem location.
You can combine it with expressions, for example `sel('A') and element == 'N'`.

Wrap the paths below in `sel('...')`. Fields appear in this order:

```text
CHAIN_ID / RES_NAME / RES_ID / ATOM_NAME / TRANSFORMATION_ID
```

Use `*` for any value. Omitted trailing fields are wildcards. Lists and residue
ranges go inside brackets; top-level commas join selections.

| Path | Selects |
| --- | --- |
| `A` | Source chain A, including its assembly copies. |
| `*/ALA` | All alanine residues. |
| `*/*/*/CA` | Alpha carbons. |
| `[A,B]/*/*/[N,CA,C,O]` | Those backbone atoms in chains A and B. |
| `A/*/[10-20,25]` | Residues 10–20 and 25 in A. |
| `A/*/[10-20], B/*/[3-8]` | Two different residue ranges. |
| `A/*/*/CA/1` | Alpha carbons in transformation 1 of A. |

Ranges are inclusive. Write `[10-20]`, not bare `10-20`. Studio delegates parsing
to AtomWorks' `AtomSelectionStack`; it does not maintain a separate grammar.
A valid query with no matching atoms selects zero atoms. In a union, an unmatched
member does not discard the matching members.

## PyMOL commands

With Patinae active, select **PyMOL commands** and try:

```text
select sele, name CA
show spheres, sele
```

The `select` command also updates Studio’s editing selection, so an annotation
applies to those atoms. `deselect` clears it. Invalid commands retain the input
and selection for correction. **More** contains the supported
command list. Only Patinae's supported PyMOL-style commands work here; arbitrary
PyMOL commands, `aw_*` plugin commands and Python are not supported.
`remove <selection>` uses Studio's delete operation, updating the annotated CIF
and the viewer together. **Undo** restores the atoms and their annotations.
For example, `remove solvent` removes water when present. Other structural
commands such as `alter` and `bond` remain disabled; use Studio's editing controls.
Mol* uses **AtomWorks query** and its menus instead.

Inside the native PyMOL application, use the normal PyMOL selection language:

```text
select sele, name CA
show spheres, sele
```

Then apply edits through the Studio panel. PyMOL uses its own selection parser;
AtomWorks expressions such as `atom_name == 'CA'` belong in the browser's
**AtomWorks query** mode. See the [PyMOL guide](PYMOL.md) for console commands
and the distinction between the displayed molecule and the saved document.

## Show and hide atoms

**Style** uses the same controls in Studio, VS Code, and embedded Gradio.
Choose **All atoms** or **Selection**, then **Show**, **Hide**, or **Show only**
and a representation. **Show only** replaces other representations on that target.
**Hide everything** hides all representations on the target; it does not delete atoms.

For a binding-site view, select the protein and show a cartoon, then select the
ligand and show sticks. Show a surface to inspect the pocket and hide that surface
when it obscures contacts. Both Patinae and Mol* support these controls. Ribbon
uses Mol*'s backbone representation; rendering details differ between engines.

Display changes leave the annotated CIF and edit history unchanged. Selection
styles stay attached to the selected atoms through annotation refreshes and
renderer switches. Opening another structure or changing its atom inventory
resets these styles. Structural changes still go through AtomWorks and **Undo**.
