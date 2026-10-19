# Edit, save, and reopen a structure

This walkthrough uses the bundled NIM inverse-folding example (2KL8). Run Studio using the
[installation guide](INSTALLATION.md), then open its URL in your browser.
No GPU is needed to edit or save a structure.

## Try it here

The installed guide can open the same editor used by the browser and VS Code.
Choose **Open 2KL8 example**, then follow the steps below. On a narrow screen,
use the editor's **Guide** link to keep the instructions in a separate tab.

```{raw} html
<div class="studio-example">
  <button type="button" data-studio-example="inverse_folding">Open 2KL8 example</button>
  <p role="status">Interactive editing is available when this guide is served by Studio at /guide/.</p>
</div>
```

## Open and select

1. In **Edit → Main → Examples**, choose **Inverse folding · 2KL8**. Wait for the molecule and sequence to appear.
2. Set the command bar to **AtomWorks query**, enter `atom_name == 'CA'`, and
   choose **Select**. The selection count should read **59 atoms** for the bundled example.
3. In the same **AtomWorks query** mode, enter `sel('*/*/*/CA')`. It selects the same atoms.
4. Click a residue in the sequence to replace the selection. Ctrl/Cmd-click
   toggles a residue; Shift-click extends a range.

The [selection reference](SELECTIONS.md) includes chain, residue, and atom lists.
Viewer styling and selection do not edit the CIF.

## Apply an annotation and undo it

1. With a residue selected, open **Edit → Annotations** and choose **Sequence conditioning**.
2. Leave **Enable condition** checked and choose **Apply to selection**.
   The confirmation reports the affected atoms; successful edits clear the selection.
3. Under **Conditions on this structure**, choose the Sequence conditioning row to color its atoms.
4. Choose **Undo** to restore the preceding document state. Select the residue
   again and repeat the edit if you want to keep it.

Sequence, coordinate, index, terminal, and distance conditions are included in
the default installation. All three interfaces also include hotspots, coordinate
groups, and CATH labels from the same RFD4 definitions registered with AtomWorks.

To remove a condition, select its atoms again, uncheck **Enable condition**, and
choose **Remove from selection**. **Clear colors** only clears the visualization;
it does not remove saved annotations. If an edit fails, the message beside the
controls explains why and the selection remains available for correction.

## Save and reopen

1. Choose **Save CIF** and keep the downloaded file.
2. Choose **Open CIF** and load that file with the annotated-CIF preset.
3. Inspect the Sequence annotation again. It should retain the edit you saved.
4. To continue in PyMOL, open **Plugin → AtomWorks Studio**, use **Load CIF**,
   and choose the downloaded file. Select its **Active** object before editing.

Use Studio's save action in each interface. PyMOL's own molecule export does not
preserve AtomWorks annotations.

## Edit a ligand

Choose **Small-molecule binder · SAM** from the NIM examples to work with a ligand.

- **Protonation:** in **Charges**, set pH and choose **Protonate structure**.
  It updates the whole structure, including hydrogens, and can be undone.
- **Charges:** select an atom, enter its formal charge, and apply. This changes
  the stored formal charge, not a partial charge or a display label.
- **Bonds:** select two atoms and add or remove their bond. Inspect the bond table
  afterward; a line drawn by the viewer is not proof of a stored bond.
- **Chains:** select atoms, assign the destination chain, and check the resulting
  chain list. Use Undo to reverse a mistaken assignment.

Save and reopen after editing. Bond inference from CCD needs a configured
`CCD_MIRROR_PATH`; loading existing stored bonds does not require inference.

## Groups and segments

Use groups and expandable segments to describe an RFD4 input.
Group actions operate on the current selection. Save expandable segments
collapsed when their length should remain unspecified. Editing these annotations
does not run a model.

Generic AtomWorks distance restraints are not supported RFD4 design conditions.
RFD4's editor excludes them; Analyze can measure current distances without adding conditions.

For native PyMOL workflows, continue with the [panel guide](PYMOL.md).
For the same browser editor inside VS Code, see [VS Code and Cursor](VSCODE.md).
