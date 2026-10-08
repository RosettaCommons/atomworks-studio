"""Read RFD4's scientific definitions without initializing its inference runtime.

RFD4's package initializer loads cluster configuration and the model stack. Its
condition and annotation modules are standalone scientific definitions, loaded
from the bundled or explicitly configured source under Studio's own namespace. This never
inserts a substitute ``rfproteina`` package into the application's import table.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType


def source_root() -> Path:
    """Locate the explicitly configured or bundled RFD4 source."""
    configured = os.environ.get("ANNOTATION_STUDIO_RFD4_ROOT") or os.environ.get("RFPROTEINA_ROOT")
    if configured:
        root = Path(configured).expanduser().resolve() / "src" / "rfproteina"
    else:
        root = Path(__file__).with_name("_upstream") / "src" / "rfproteina"
    if not (root / "conditions.py").is_file():
        raise ImportError(
            "RFD4 definitions are missing; install a complete Studio RFD4 wheel or configure its source checkout"
        )
    return root


def _load_definition(module_name: str, relative_path: str) -> ModuleType:
    if module_name in sys.modules:
        return sys.modules[module_name]
    local_name = f"{__package__}._source_{Path(relative_path).stem}"
    spec = importlib.util.spec_from_file_location(local_name, source_root() / relative_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load RFD4 definition: {relative_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[local_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(local_name, None)
        raise
    return module


conditions = _load_definition("rfproteina.conditions", "conditions.py")
standard_annotations = _load_definition("rfproteina.utils.standard_annotations", "utils/standard_annotations.py")


def __getattr__(name: str):
    if name == "parse_presets":
        module = _load_definition("rfproteina.utils.parse_presets", "utils/parse_presets.py")
        globals()[name] = module
        return module
    return getattr(conditions, name)
