"""Run identical native PyMOL, Patinae and Mol* workflows against a local Studio server.

Use a Python environment with Studio, its PyMOL plugin, PyMOL/Qt and pytest installed.
The web bundle must already be built; node and Chrome must be available.
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000/")
    parser.add_argument("--output", type=Path, default=Path("artifacts/parity"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    # A missing native host must fail, rather than turn into pytest's optional skip.
    subprocess.run([sys.executable, "-c", "import pymol; from pymol.Qt import QtWidgets"], check=True)
    args.output.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="run-", dir=args.output.resolve()))
    env = {**os.environ, "STUDIO_WORKFLOW_OUTPUT": str(output), "STUDIO_STRICT_RENDERER": "1",
           "ANNOTATION_STUDIO_URL": args.url.rstrip("/") + "/", "QT_QPA_PLATFORM": "offscreen"}

    def run(command):
        subprocess.run(command, cwd=root, env=env, check=True)

    print(f"Fresh parity artifacts: {output}", flush=True)
    run([
        sys.executable, "scripts/run_pytest.py", "-q",
        "tests/test_design_workflows.py", "tests/test_editor_qol_parity.py",
        "tests/test_pymol_conformance.py", "packages/pymol-plugin/tests",
    ])
    for viewer in ("patinae", "molstar"):
        env["VIEWER_MODE"] = viewer
        run(["node", "packages/web/tests/design-workflows.mjs"])
    run([sys.executable, "scripts/check_workflow_outputs.py", str(output),
         "--reference", "pymol", "--hosts", "patinae", "molstar", "--strict-renderers"])


if __name__ == "__main__":
    main()
