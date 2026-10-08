"""Extension configuration compatibility tests."""

from pathlib import Path

import atomworks_studio_pymol.extensions as extensions

RFD4_EXTENSION = "atomworks_studio_rfd4.pymol.editors"


def _configure_paths(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    current = tmp_path / ".atomworks-studio" / "pymol_extensions"
    legacy = tmp_path / ".atomworks" / "pymol_extensions"
    monkeypatch.setattr(extensions, "_EXTENSIONS_FILE", current)
    monkeypatch.setattr(extensions, "_LEGACY_EXTENSIONS_FILE", legacy)
    return current, legacy


def test_read_extensions_migrates_legacy_file_and_module_names(monkeypatch, tmp_path: Path) -> None:
    current, legacy = _configure_paths(monkeypatch, tmp_path)
    legacy.parent.mkdir(parents=True)
    legacy.write_text(
        "# old configuration\nrfproteina.pymol.editors\natomworks_studio_rfd4.pymol.editors\n",
        encoding="utf-8",
    )

    assert extensions.read_extensions() == [RFD4_EXTENSION]
    assert current.read_text(encoding="utf-8") == f"{RFD4_EXTENSION}\n"
    assert legacy.exists()


def test_add_and_remove_extensions_use_current_file(monkeypatch, tmp_path: Path) -> None:
    current, _legacy = _configure_paths(monkeypatch, tmp_path)

    assert extensions.add_extension("rfproteina.pymol.editors")
    assert not extensions.add_extension(RFD4_EXTENSION)
    assert extensions.read_extensions() == [RFD4_EXTENSION]

    assert extensions.remove_extension("rfproteina.pymol.editors")
    assert not extensions.remove_extension(RFD4_EXTENSION)
    assert current.read_text(encoding="utf-8") == ""
