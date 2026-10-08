"""Exercise native controls on complete enzyme/PPI/ligand authoring workflows."""

import json
import os
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests/fixtures/workflow_cases.json").read_text())
CASES += json.loads((ROOT / "tests/fixtures/nim_workflow_cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_native_design_input_workflow(case, tmp_path, monkeypatch):
    pymol = pytest.importorskip("pymol")
    monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    pymol.finish_launching(["pymol", "-qck"])
    from atomworks_studio_editing.loading import build_load_config
    from atomworks_studio_pymol.bridge import load_structure, selection_to_indices
    from atomworks_studio_pymol.display import display_atom_ids
    from atomworks_studio_pymol.editors import editor_for
    from atomworks_studio_pymol.extensions import load_extensions
    from atomworks_studio_pymol.panel import MainPanel
    from atomworks_studio_pymol.state import STATE
    from pymol import cmd
    from pymol.Qt import QtWidgets

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    monkeypatch.setattr(QtWidgets.QMessageBox, "critical", lambda *args: pytest.fail(str(args)))

    def warning(*args):
        if args[1] == "Validation Issues":
            return QtWidgets.QMessageBox.Yes
        pytest.fail(str(args))

    monkeypatch.setattr(QtWidgets.QMessageBox, "warning", warning)
    cmd.reinitialize()
    STATE.clear_all()
    load_extensions()
    source = ROOT / "examples" / case.get("file", "")
    if "example_id" in case:
        from annotation_studio.main import EXAMPLES, EXAMPLES_DIR

        source = EXAMPLES_DIR / next(item["file"] for item in EXAMPLES if item["id"] == case["example_id"])
    name = load_structure(source, config=build_load_config("minimal"), obj_name=case["name"])
    document = STATE.document(name)
    assert len(document.array) == case["atoms"]
    if case["name"] == "ppi":
        colors = set()
        cmd.iterate(f"model {name} and polymer and elem C", "colors.add(color)", space={"colors": colors})
        assert len(colors) > 1, "Fresh PyMOL must color protein residues without custom startup colors"
    panel = MainPanel(STATE)
    output = Path(os.environ.get("STUDIO_WORKFLOW_OUTPUT", str(tmp_path)))
    output.mkdir(parents=True, exist_ok=True)

    def snapshot(stage):
        (output / f"pymol-{case['name']}-{stage}.cif").write_text(document.to_cif())

    def select(query):
        indices = document.query_indices(query).tolist()
        ids = display_atom_ids(document.array)[indices]
        cmd.select("sele", f"model {name} and id {'+'.join(str(int(i)) for i in ids)}")
        assert sorted(selection_to_indices("sele", STATE.index_maps[name])) == indices
        assert indices
        return indices

    snapshots = []
    snapshot("00")
    for i, action in enumerate(case["actions"], 1):
        kind = action["kind"]
        editor = None
        indices = []
        previous = document.array.copy()
        if kind in {"condition", "group", "pair"}:
            definition = document.condition_provider.definitions_by_name[action.get("key", "distance")]
            editor = editor_for(definition.condition)(definition.condition, STATE)
            indices = select(action["query"])
            if kind == "pair":
                assert len(indices) == 2
                keys = {index: key for key, index in STATE.index_maps[name].items()}
                editor._pairs.append(
                    (keys[indices[0]], keys[indices[1]], action["value"], name, STATE.structure_version(name))
                )
                editor.apply_to_selection()
                assert document.distance_restraints()[-1]["distance"] == action["value"]
            elif kind == "group":
                editor._new_group_from_selection()
                assert np.all(definition.condition.mask(document.array)[indices])
            elif "value" in action:
                editor._apply_value(action["value"])
                np.testing.assert_equal(definition.condition.annotation(document.array)[indices], action["value"])
            else:
                editor._set_mask(not action["enabled"] if definition.invert_mask else action["enabled"])
                expected = not action["enabled"] if definition.invert_mask else action["enabled"]
                np.testing.assert_equal(definition.condition.mask(document.array)[indices], expected)
        elif kind == "charge":
            indices = select(action["query"])
            panel._charge_wizard._set_charge(action["value"])
            np.testing.assert_equal(document.array.charge[indices], action["value"])
        elif kind == "realize":
            panel._realize_expandable_segments()
            assert len(document.array) > case["atoms"]
        elif kind == "undo":
            panel._undo()
            assert len(document.array) == case["atoms"]
        if kind not in {"realize", "undo"}:
            np.testing.assert_allclose(document.array.coord, previous.coord, equal_nan=True)
        snapshot(f"{i:02d}")
        snapshots.append({"step": i, "action": kind, "indices": indices, "atoms": len(document.array)})
        if editor is not None:
            editor.close()
    final = output / f"pymol-{case['name']}-saved.cif"
    monkeypatch.setattr(QtWidgets.QFileDialog, "getSaveFileName", lambda *args: (str(final), ""))
    panel._save_active()
    assert final.is_file()
    reopened = load_structure(final, config=build_load_config("minimal"), obj_name=f"{name}_reopened")
    (output / f"pymol-{case['name']}-reopened.cif").write_text(STATE.document(reopened).to_cif())
    (output / f"pymol-{case['name']}-actions.json").write_text(json.dumps(snapshots))
    STATE.active = name
    panel._widget.resize(680, 800)
    panel._widget.show()
    panel._widget.findChild(QtWidgets.QTabWidget).setCurrentIndex(1)
    app.processEvents()
    panel._widget.grab().save(str(output / f"pymol-{case['name']}.png"))
    panel._widget.close()
    cmd.reinitialize()
    STATE.clear_all()
