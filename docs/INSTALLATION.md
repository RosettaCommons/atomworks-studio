# Installation and packaging

Studio uses **public AtomWorks 3.0.1 from PyPI**. No private AtomWorks checkout
is needed. Python 3.12 is supported. RFD4 annotation definitions are included; no model checkout or weights are needed.

## Choose an interface

| Package | Use |
| --- | --- |
| `atomworks-studio` | Browser application, API, and launch command. |
| `atomworks-studio-pymol` | Native PyMOL plugin, without the web server. |

Pip installs either package. The PyMOL plugin belongs in the Python environment
that runs PyMOL; Conda supplies PyMOL, Qt, and compatible native libraries.
Register the plugin once, then use **Plugin → AtomWorks Studio**.

Both packages are published on PyPI; the public AtomWorks dependency
resolves automatically.

## What the pip installation provides

Run `atomworks-studio`, then open <http://127.0.0.1:8000/> in a browser.
The server runs on your machine with **Mol*/WebGL** as the default viewer and
**Patinae/WebGPU** available in **More → Renderer**. You do not need a separate
Patinae installation, Node, Rust, or VS Code. The **Guide** link opens the
bundled documentation at <http://127.0.0.1:8000/guide/>.

The local editor opens CIF files, selects atoms using AtomWorks expressions,
edits annotations and molecular structure, protonates at a chosen pH, and
saves annotated CIF files with Undo available during editing. Follow the
[walkthrough](TUTORIAL.md) for a complete example.

The browser installation includes public AtomWorks conditions and the RFD4
adapter: sequence, coordinates, hotspots, RASA, groups, CATH, and other supported
conditions are ready to edit. The adapter bundles pinned RosettaCommons scientific
definitions and vocabulary; annotation editing needs no RFD4 checkout.
The independent PyMOL package includes the same annotation adapter and editors.

| Interface | What runs |
| --- | --- |
| Local browser | The installed Studio server and bundled editor. |
| VS Code | The same editor; the extension starts the installed Python backend automatically. |
| Hosted website | The same application on an operator's server; visitors need no local Python installation. |
| Native PyMOL | The optional plugin runs inside an existing PyMOL application, without a Studio server. |

PyMOL and Qt are native desktop dependencies and are not bundled into the default
Studio wheel. Use the Conda environment below for the native plugin. A separate
OS desktop wrapper is not needed for the browser application.

The default editor does install AtomWorks' `ml` dependencies: its annotation,
interaction, and expandable-segment operations use those APIs. Model weights
and GPU provisioning belong to the model deployment. The optional
[`gradio` extra](INTEGRATIONS.md#model-enabled-gradio-host) connects that deployment
to the same editor.

## Install from PyPI

The Studio wheel and source archive contain the API, compiled browser, WASM, and searchable guide.
Installing built wheels does not require Node, Rust, or the source checkout.
In a fresh Python 3.12 environment:

```bash
python -m pip install atomworks-studio
atomworks-studio
```

For an existing PyMOL environment, install only the plugin:

```bash
python -m pip install atomworks-studio-pymol
atomworks-studio-pymol install
```

`atomworks-studio[pymol]` is also available for an environment intentionally
running both interfaces. Neither installation includes model weights or workers.

## PyMOL from source

From the Studio checkout:

```bash
conda env create -f packages/pymol-plugin/pymol_env.yaml
conda activate atomworks
python -m pip install -e packages/editing -e providers/rfd4 -e packages/pymol-plugin
python -m atomworks_studio_pymol install
pymol
```

The registration command preserves unrelated startup settings and backs up a
changed `.pymolrc`. It is needed for PyMOL versions that do not discover Python
package entry points. `atomworks-studio-pymol install` is equivalent.

Do not install the optional `pymol-pip` extra over Conda's PyMOL/Qt. The native
environment files include NumPy/SciPy and pthreads OpenBLAS constraints tested
with the plugin. See the [PyMOL guide](PYMOL.md) for RFD4 authoring and validation.

## Browser from source

Build the browser with the [development prerequisites](DEVELOPMENT.md), then:

```bash
pnpm --dir packages/web build
make docs
python -m pip install -e packages/editing -e providers/rfd4 -e .
atomworks-studio
```

Open <http://127.0.0.1:8000/>. Set another address with
`atomworks-studio --host 127.0.0.1 --port 8001`.
`python -m atomworks_studio` starts the same server. For VS Code, install the VSIX and follow the [extension guide](VSCODE.md); it starts the backend automatically.

## Release checks

See [acceptance checks](ACCEPTANCE.md) for installed-package and interface tests,
and the [release guide](RELEASE.md) for version tags and publishing.

## Install built wheels

To test a local build, build from a bootstrapped checkout and install from `dist/`:

```bash
make build
uv run scripts/check_distribution_assets.py dist
python -m pip install --find-links dist atomworks-studio
```
