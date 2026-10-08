# AtomWorks Studio for PyMOL

Load, annotate, and save molecular structures inside PyMOL. The plugin uses the
same editing library as the browser, with native Qt controls and no web server.
Install it in the Python environment that runs PyMOL; PyMOL and Qt are host
dependencies. See [installation](INSTALLATION.md) for wheel installs.

## Setup

Install the plugin wheel in the Python environment that runs PyMOL:

```bash
python -m pip install --find-links dist dist/atomworks_studio_pymol-0.1.0-*.whl
atomworks-studio-pymol install
pymol
```

For a native environment and source installation:

```bash
conda env create -f packages/pymol-plugin/pymol_env.yaml
conda activate atomworks
python -m pip install -e packages/editing -e providers/rfd4 -e packages/pymol-plugin
atomworks-studio-pymol install
pymol
```

The plugin automatically loads the same RFD4 annotation adapter as the browser
and VS Code, including hotspots. Built wheels include the required scientific
definitions; no model checkout, weights, or separate validation environment is
needed. Save checks cover document and annotation consistency, not model inference.

The registration command preserves unrelated PyMOL settings, backs up a changed
`.pymolrc`, and migrates the old AtomWorks startup entry. Use the normal Conda
PyMOL/Qt packages; do not install the `pymol-pip` CI extra over them.

## Use the panel

Open **Plugin → AtomWorks Studio**. The tabs are **Main**, **Annotations**,
**Bonds**, **Charges**, and **Chains**.

1. Choose **Load CIF** in Main. The load dialog controls annotations, assembly,
   model, waters, hydrogens, and missing-atom preparation.
2. Select the **Active** object. All panel edits apply to that structure.
3. Select atoms or residues in PyMOL and edit through the appropriate tab.
4. Use **Summarize changes** to inspect annotations, **Undo** to revert an edit,
   and **Save Active As** to write the annotated CIF. Undo keeps ten edits per object.

**Combine visible** merges visible plugin objects under a new name, resolves
chain conflicts, and hides the source objects. **Delete selection** removes the
selected atoms from the active document. **Reset Res ID** renumbers each chain
starting at 1.

## Annotations, bonds, charges, and chains

In **Annotations**, select a condition and use its editor on the current
selection. Registered extensions add model-specific editors. To mark residues
as unindexed, disable their Index condition. PyMOL condition selections show
which atoms carry each annotation.

In **Bonds**, pick two atoms to add or remove a bond. The table lists bonds
involving the current selection. **Infer Bonds from CCD** merges bonds from CCD
templates while preserving atoms and charges. It requires `CCD_MIRROR_PATH`. Check ligand and nonstandard
bond graphs before saving; a PyMOL display alone does not establish stored bonds.

**Charges** sets or adjusts selected atoms' formal charges. **Protonate active
object** uses the pH field (default 7.4) to update hydrogens and formal charges
through AtomWorks. It acts on the whole active object, including atoms outside
`sele`. Use **Undo** to restore its previous state. **Chains** assigns
selected atoms to a chain. These edits share validation and undo with the browser.

## Expandable segments

In Main, **Insert Expandable Segment** takes a minimum and maximum length and
inserts before or after the selection, or in a new chain. **Realize Segments**
replaces segment sentinels with placeholder residues; **Collapse Segments**
restores the sentinels. Save segments collapsed if the model should sample their
lengths at inference time. Realized segments already have a sampled length.

## PyMOL edits and document state

The plugin saves its in-memory `AtomArrayPlus`, not the PyMOL display. Use plugin
actions for loading, editing, and saving. **Reload AtomArray** redraws that
stored structure. PyMOL mutations, rotamer changes, and coordinate dragging may
not be captured by the plugin.

For an unsupported edit, make the change in PyMOL, save with **File → Save
Molecule**, then load that CIF through the plugin and reapply annotations.
PyMOL's native save does not preserve AtomWorks annotations. Only CIF load/save
is supported by the plugin; PDB objects can be displayed alongside it.

## Console Commands

All panel operations are also available as `aw_*` console commands for scripting:

| Command | Description |
|---|---|
| `aw_load <path> [obj_name]` | Load a CIF into AtomWorks |
| `aw_save <path> [obj_name]` | Save the active (or named) object as annotated CIF |
| `aw_delete [selection] [obj_name]` | Delete selection from the active object |
| `aw_insert_segment [selection] [min] [max] [before]` | Insert an expandable segment at the selection |
| `aw_undo [obj_name]` | Undo the last edit |
| `aw_combine_visible [new_name]` | Combine all visible tracked objects |
| `aw_set_active <obj_name>` | Set the active object |

## Update

Install the new plugin and annotation wheels in the same environment, then restart
PyMOL. Source users can update the checkout and repeat the source installation.
Report bugs in the [Studio issue tracker](https://github.com/RosettaCommons/atomworks-studio/issues).
