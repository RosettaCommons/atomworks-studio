"""PyMOL plugin extension management.

Extensions are Python modules with a ``register()`` function that hook
custom annotation editors into the AtomWorks Studio PyMOL plugin.

The list of active extensions is stored in
``~/.atomworks-studio/pymol_extensions``, one module path per line. The first
read migrates the former ``~/.atomworks/pymol_extensions`` file and known
legacy RFD4 module names. Manage the list from the plugin's ``Extensions...``
dialog.
"""

import importlib
import logging
from pathlib import Path

logger = logging.getLogger("atomworks_studio_pymol")

_EXTENSIONS_FILE = Path.home() / ".atomworks-studio" / "pymol_extensions"
_LEGACY_EXTENSIONS_FILE = Path.home() / ".atomworks" / "pymol_extensions"
_MODULE_ALIASES = {
    "proteinfoundation.pymol.editors": "atomworks_studio_rfd4.pymol.editors",
    "rfproteina.pymol.editors": "atomworks_studio_rfd4.pymol.editors",
}


def extensions_file() -> Path:
    """Return the path to the extensions config file."""
    return _EXTENSIONS_FILE


def _normalize_module(module: str) -> str:
    return _MODULE_ALIASES.get(module.strip(), module.strip())


def _read_file(path: Path) -> list[str]:
    if not path.exists():
        return []

    modules: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        module = line.strip()
        if not module or module.startswith("#"):
            continue
        module = _normalize_module(module)
        if module not in modules:
            modules.append(module)
    return modules


def _write_file(modules: list[str]) -> None:
    _EXTENSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(f"{module}\n" for module in modules)
    _EXTENSIONS_FILE.write_text(text, encoding="utf-8")


def _migrate_legacy_file() -> None:
    if _EXTENSIONS_FILE.exists() or not _LEGACY_EXTENSIONS_FILE.exists():
        return
    _write_file(_read_file(_LEGACY_EXTENSIONS_FILE))


def read_extensions() -> list[str]:
    """Return normalized extension paths, migrating the legacy file if needed."""
    _migrate_legacy_file()
    return _read_file(_EXTENSIONS_FILE)


def add_extension(module: str) -> bool:
    """Append *module* to the extensions file.

    Args:
        module: Dotted Python module path, e.g.
            ``atomworks_studio_rfd4.pymol.editors``.

    Returns:
        True if added, False if already present.
    """
    module = _normalize_module(module)
    if not module:
        raise ValueError("extension module path must not be empty")
    modules = read_extensions()
    if module in modules:
        return False
    _write_file([*modules, module])
    return True


def remove_extension(module: str) -> bool:
    """Remove *module* from the extensions file.

    Args:
        module: Dotted Python module path to remove.

    Returns:
        True if removed, False if it was not present.
    """
    module = _normalize_module(module)
    modules = read_extensions()
    if module not in modules:
        return False
    _write_file([registered for registered in modules if registered != module])
    return True


def load_extensions() -> None:
    """Import each registered extension module and call its ``register()`` function.

    Errors in individual extensions are logged as warnings and do not prevent
    other extensions from loading.
    """
    from atomworks_studio_editing.providers import load_providers

    modules = dict.fromkeys((*load_providers().pymol_editors, *read_extensions()))
    for module_path in modules:
        try:
            mod = importlib.import_module(module_path)
            mod.register()
            logger.info("AtomWorks: loaded extension '%s'", module_path)
        except Exception as e:
            logger.warning("AtomWorks: failed to load extension '%s': %s", module_path, e)
