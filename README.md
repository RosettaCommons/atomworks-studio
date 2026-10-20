# AtomWorks Studio

[![CI](https://github.com/RosettaCommons/atomworks-studio/actions/workflows/ci.yaml/badge.svg)](https://github.com/RosettaCommons/atomworks-studio/actions/workflows/ci.yaml)
[![PyPI](https://img.shields.io/pypi/v/atomworks-studio.svg)](https://pypi.org/project/atomworks-studio/)
[![Python](https://img.shields.io/pypi/pyversions/atomworks-studio.svg)](https://pypi.org/project/atomworks-studio/)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](https://github.com/RosettaCommons/atomworks-studio/blob/main/LICENSE.md)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)

[Documentation](https://github.com/RosettaCommons/atomworks-studio/blob/main/docs/index.md) · [Installation](https://github.com/RosettaCommons/atomworks-studio/blob/main/docs/INSTALLATION.md) · [Tutorial](https://github.com/RosettaCommons/atomworks-studio/blob/main/docs/TUTORIAL.md)

Open, annotate, and edit molecular structures in a browser, VS Code, or PyMOL.
Studio uses public **AtomWorks 3.0.1**, including its ML APIs and Torch.

The browser and VS Code use one editor. The PyMOL plugin runs inside PyMOL.
All three share annotation definitions, editing operations, CIF storage, and Undo.
Hotspots and other RFD4 conditions come from pinned **RosettaCommons/RFD4-Proteina**
definitions included in the annotation package. No model runtime or weights are needed.
The optional [Gradio host](https://github.com/RosettaCommons/atomworks-studio/blob/main/docs/INTEGRATIONS.md#model-enabled-gradio-host) adds
generation controls and result viewing around the same editor. The model
deployment supplies inference; Studio does not manage GPU jobs.

## Install

Studio requires Python 3.12.

```bash
python -m pip install atomworks-studio
atomworks-studio
```

Open <http://127.0.0.1:8000/>. The guide is at <http://127.0.0.1:8000/guide/>.
Patinae and Mol* are included in the package;
Node and Rust are only needed to build from source.

For VS Code, install the release VSIX, then
run **AtomWorks: Open Studio** from the Command Palette. Its Python backend starts automatically.

For native PyMOL, install `atomworks-studio-pymol` in PyMOL's Python environment
and run `atomworks-studio-pymol install`. Open **Plugin → AtomWorks Studio**.
PyMOL and Qt are supplied by the host environment, not the browser wheel.

## Use

Open a CIF, select atoms, and choose an annotation in **Edit → Annotations**. Inspect the stored
values, change bonds or charges, protonate, or edit chains and expandable segments.
Save with **Save CIF**. The resulting file opens in any Studio interface.

See the [documentation](https://github.com/RosettaCommons/atomworks-studio/blob/main/docs/index.md) for selection syntax, interface guides,
Python and HTTP integration, and development notes.

## Build from source

```bash
make bootstrap
make test
make build
make run
```

The required RFD4 annotation definitions and license are included in source and
release builds, verified against SHA-256 hashes
in `providers/rfd4/UPSTREAM.toml`. See [provenance](https://github.com/RosettaCommons/atomworks-studio/blob/main/docs/PROVENANCE.md).
