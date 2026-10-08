"""Install a guarded PyMOL startup hook and migrate the old registration."""

import argparse
import re
import shutil
from importlib.util import find_spec
from pathlib import Path

from atomworks_studio_pymol.extensions import add_extension

STARTUP = """# BEGIN AtomWorks Studio
python
from importlib.util import find_spec
if find_spec("atomworks_studio_pymol") is not None:
    from atomworks_studio_pymol import __init_plugin__
    __init_plugin__()
python end
# END AtomWorks Studio
"""


def install(pymolrc: Path, *, extensions_file: Path | None = None) -> None:
    """Preserve unrelated startup settings and back up a changed existing file."""
    if find_spec("pymol") is None:
        raise RuntimeError("Run setup in the Conda environment that contains PyMOL.")
    startup = STARTUP
    if extensions_file is not None:
        from atomworks_studio_pymol import extensions

        extensions_file = extensions_file.expanduser().resolve()
        extensions._EXTENSIONS_FILE = extensions_file
        extensions._LEGACY_EXTENSIONS_FILE = extensions_file.with_name("legacy_extensions")
        startup = startup.replace(
            "    __init_plugin__()",
            "    from pathlib import Path\n"
            "    from atomworks_studio_pymol import extensions\n"
            f"    extensions._EXTENSIONS_FILE = Path({str(extensions_file)!r})\n"
            f"    extensions._LEGACY_EXTENSIONS_FILE = Path({str(extensions._LEGACY_EXTENSIONS_FILE)!r})\n"
            "    __init_plugin__()",
        )
    if find_spec("atomworks_studio_rfd4") is not None:
        from atomworks_studio_rfd4.model import source_root

        source_root()  # Fail before changing startup settings if the source is missing.
        add_extension("atomworks_studio_rfd4.pymol.editors")

    original = pymolrc.read_text(encoding="utf-8") if pymolrc.exists() else ""
    contents = re.sub(r"(?m)^# BEGIN AtomWorks Studio\n.*?^# END AtomWorks Studio\n?", "", original, flags=re.DOTALL)
    lines = []
    for line in contents.splitlines(keepends=True):
        # The old `atomworks setup pymol` command wrote exactly this run command.
        if re.fullmatch(r"\s*run\s+['\"]?.*[/\\]atomworks[/\\]pymol_plugin[/\\]__init__\.py['\"]?\s*", line):
            continue
        lines.append(line)
    contents = "".join(lines)
    contents = contents + ("\n" if contents and not contents.endswith("\n") else "") + startup
    if contents == original:
        print(f"Already registered in {pymolrc}")
        return
    if pymolrc.exists():
        backup = pymolrc.with_name(pymolrc.name + ".before-atomworks-studio")
        if not backup.exists():
            shutil.copy2(pymolrc, backup)
        print(f"Original startup settings backed up to {backup}")
    pymolrc.parent.mkdir(parents=True, exist_ok=True)
    pymolrc.write_text(contents, encoding="utf-8")
    print(f"Registered Plugin > AtomWorks Studio in {pymolrc}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["install"])
    parser.add_argument("--pymolrc", type=Path, default=Path.home() / ".pymolrc")
    parser.add_argument("--extensions-file", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    install(args.pymolrc.expanduser(), extensions_file=args.extensions_file)
