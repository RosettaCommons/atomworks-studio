"""The generated startup file exposes the editor through PyMOL's native menu."""

import os
from types import SimpleNamespace

import pytest


def test_installed_startup_opens_menu_and_loads_rfd4(monkeypatch, tmp_path):
    pytest.importorskip("atomworks_studio_rfd4")
    if "QT_QPA_PLATFORM" not in os.environ:
        monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    import atomworks_studio_pymol as plugin
    import atomworks_studio_pymol.extensions as extensions
    import atomworks_studio_pymol.panel as panel
    from atomworks_studio_pymol.installation import install
    from atomworks_studio_pymol.views import VIEWS
    from pmg_qt.mimic_pmg_tk import PmwMenuBar
    from pymol import cmd, plugins
    from pymol.Qt import QtWidgets

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    window = QtWidgets.QMainWindow()
    menu = window.menuBar().addMenu("Plugin")
    monkeypatch.setattr(plugins, "HAVE_QT", True)
    monkeypatch.setattr(plugins, "get_pmgapp", lambda: SimpleNamespace(menuBar=PmwMenuBar({"PluginQt": menu})))
    monkeypatch.setattr(plugin, "_INITIALIZED", False)
    monkeypatch.setattr(panel, "_panel_instance", None)
    monkeypatch.setattr(panel, "_dock_instance", None)
    monkeypatch.setattr(extensions, "_EXTENSIONS_FILE", tmp_path / "unused")
    monkeypatch.setattr(extensions, "_LEGACY_EXTENSIONS_FILE", tmp_path / "unused-legacy")
    rc = tmp_path / "pymolrc"
    install(rc, extensions_file=tmp_path / "registered.extensions")
    # A new PyMOL process starts with the default registry paths.
    extensions._EXTENSIONS_FILE = tmp_path / "unused"
    extensions._LEGACY_EXTENSIONS_FILE = tmp_path / "unused-legacy"
    try:
        cmd._parser.parse(f"@{rc}")
        assert extensions.read_extensions() == ["atomworks_studio_rfd4.pymol.editors"]
        actions = [action for action in menu.actions() if action.text() == "AtomWorks Studio"]
        assert len(actions) == 1
        assert not any(action.text() == "AtomWorks" for action in menu.actions())
        assert {"Color by index group", "Color by coord group"} <= VIEWS.keys()
        actions[0].trigger()
        app.processEvents()
        assert panel.get_main_panel() is not None
        from atomworks_studio_editing.layout import EDITOR_TABS

        tabs = window.findChild(QtWidgets.QTabWidget)
        assert [tabs.tabText(i) for i in range(tabs.count())] == [label for _, label in EDITOR_TABS]
        from atomworks_studio_editing.providers import load_providers

        definitions = load_providers().condition_provider.definitions
        condition_list = panel.get_main_panel()._annotation_wizard._list
        assert [condition_list.item(i + 1).text() for i in range(len(definitions))] == [
            definition.label for definition in definitions
        ]
        assert window.findChildren(QtWidgets.QDockWidget)
        cmd._parser.parse(f"@{rc}")
        assert len([action for action in menu.actions() if action.text() == "AtomWorks Studio"]) == 1
    finally:
        window.close()
        window.deleteLater()
        app.processEvents()
