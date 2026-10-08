"""Migration from the old startup hook must preserve other PyMOL settings."""

from pathlib import Path

import atomworks_studio_pymol.installation as installation
import pytest


@pytest.mark.parametrize(
    "legacy_path", ["/repo/atomworks/pymol_plugin/__init__.py", r"C:\repo\atomworks\pymol_plugin\__init__.py"]
)
def test_install_migrates_only_old_hook_and_is_repeatable(monkeypatch, tmp_path: Path, legacy_path: str) -> None:
    monkeypatch.setattr(installation, "find_spec", lambda name: object() if name == "pymol" else None)
    rc = tmp_path / "pymolrc"
    original = f"bg_color white\nrun {legacy_path}\nrun /my/other/plugin.py\nset orthoscopic, on"
    rc.write_text(original)
    installation.install(rc)
    installed = rc.read_text()
    assert legacy_path not in installed
    assert "run /my/other/plugin.py\nset orthoscopic, on\n" in installed
    assert installed.count("# BEGIN AtomWorks Studio") == 1
    assert rc.with_name("pymolrc.before-atomworks-studio").read_text() == original
    installation.install(rc)
    assert rc.read_text() == installed
    assert rc.with_name("pymolrc.before-atomworks-studio").read_text() == original


def test_startup_guard_handles_other_environments_and_duplicate_loading(monkeypatch) -> None:
    import importlib.util

    import atomworks_studio_pymol as plugin

    calls = []
    monkeypatch.setattr(plugin, "_INITIALIZED", False)
    monkeypatch.setattr(plugin, "find_spec", lambda _: object())
    monkeypatch.setattr(plugin, "_register_plugin", calls.append)
    body = installation.STARTUP.split("\npython\n", 1)[1].split("\npython end", 1)[0]
    monkeypatch.setattr(importlib.util, "find_spec", lambda _: None)
    exec(body, {})
    assert calls == []
    monkeypatch.setattr(importlib.util, "find_spec", lambda _: object())
    exec(body, {})
    exec(body, {})
    assert calls == [None]


def test_install_registers_rfd4_without_importing_its_runtime(monkeypatch, tmp_path: Path) -> None:
    from atomworks_studio_rfd4 import model

    registered = []
    monkeypatch.setattr(installation, "find_spec", lambda _: object())
    monkeypatch.setattr(installation, "add_extension", registered.append)
    monkeypatch.setattr(model, "source_root", lambda: tmp_path)
    installation.install(tmp_path / "pymolrc")
    assert registered == ["atomworks_studio_rfd4.pymol.editors"]
