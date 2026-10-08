"""AtomWorks PyMOL plugin entry point.

The standalone distribution publishes :func:`__init_plugin__` through the
``pymol.plugins`` entry-point group. The function remains compatible with
PyMOL's traditional startup-file loader.
"""

import logging
from importlib.util import find_spec

logger = logging.getLogger("atomworks_studio_pymol")
_INITIALIZED = False


def __init_plugin__(app: object | None = None) -> None:
    """PyMOL plugin entry point.

    Checks that atomworks is importable, then registers the menu item,
    console commands, and command intercepts.

    Args:
        app: PyMOL application object (passed by PyMOL; may be None).
    """
    global _INITIALIZED
    if _INITIALIZED:
        return

    if find_spec("atomworks") is None:
        _register_unavailable_menu()
        return

    # Newer PyMOL builds may discover the package entry point and also source a
    # legacy ~/.pymolrc. Mark the process initialized before registering hooks
    # so the two loaders cannot duplicate extension callbacks or menu entries.
    _INITIALIZED = True
    try:
        _register_plugin(app)
    except Exception:
        _INITIALIZED = False
        raise


def _register_unavailable_menu() -> None:
    """Register a placeholder menu item that shows an install error."""
    try:
        from pymol.plugins import addmenuitemqt

        addmenuitemqt("AtomWorks Studio [NOT INSTALLED]", _show_install_error)
    except Exception:
        print(
            "AtomWorks plugin: atomworks is not installed in this Python environment.\n"
            "Reinstall with: python -m pip install atomworks-studio-pymol"
        )


def _show_install_error() -> None:
    """Show a Qt message box explaining that atomworks is not installed."""
    try:
        from pymol.Qt import QtWidgets

        QtWidgets.QMessageBox.critical(
            None,
            "AtomWorks Not Installed",
            "atomworks is not installed in this Python environment.\n\n"
            "Reinstall it with:\n    python -m pip install atomworks-studio-pymol\n\n"
            "Ensure you install in the same conda/venv where PyMOL is running.",
        )
    except Exception:
        print(
            "AtomWorks is not installed.\n"
            "Run: python -m pip install atomworks-studio-pymol "
            "(in the environment where PyMOL runs)"
        )


def _register_plugin(app: object | None) -> None:
    """Register the full plugin: menu, commands, and command intercepts."""
    try:
        from pymol.plugins import addmenuitemqt
    except Exception as e:
        logger.warning("Could not register AtomWorks menu item: %s", e)
        return

    # Register the custom editors for specific annotation classes
    try:
        from atomworks_studio_pymol.editors.custom import register_custom_editors

        register_custom_editors()
    except Exception as e:
        logger.warning("AtomWorks: could not register custom editors: %s", e)

    # Load user-registered extensions (before commands/intercepts so editors are ready)
    try:
        from atomworks_studio_pymol.extensions import load_extensions

        load_extensions()
    except Exception as e:
        logger.warning("AtomWorks: could not load pymol extensions: %s", e)

    # Register aw_* console commands
    try:
        from atomworks_studio_pymol.commands import register_commands

        register_commands()
    except Exception as e:
        logger.warning("AtomWorks: could not register console commands: %s", e)

    # Add the menu item — must tolerate headless environments (e.g. pytest)
    # where Qt isn't available even though ``pymol`` itself imports fine.
    try:
        from atomworks_studio_pymol.panel import open_main_panel

        addmenuitemqt("AtomWorks Studio", open_main_panel)
    except Exception as e:
        logger.warning("AtomWorks: could not register Qt menu item: %s", e)
        return
    logger.info("AtomWorks PyMOL plugin loaded successfully.")
    print("AtomWorks Studio loaded. Use Plugin → AtomWorks Studio or type aw_load in the console.")


# When executed by PyMOL's traditional startup-file loader, initialize directly.
if __name__ != "atomworks_studio_pymol":
    # Delegate to the canonical imported module so its idempotence guard is
    # shared with entry-point discovery in the same PyMOL process.
    from atomworks_studio_pymol import __init_plugin__ as _initialize_plugin

    _initialize_plugin()
