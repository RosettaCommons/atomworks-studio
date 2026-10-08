# Studio API

The API is included in `atomworks-studio`. Start it with `atomworks-studio`;
use `--vscode` to allow the VS Code webview to embed it. The default address is
`http://127.0.0.1:8000`. Interactive API documentation is at `/docs`.

The API owns bounded editor sessions and delegates every mutation to
`atomworks-studio-editing`. It loads the same annotation adapter as PyMOL.
Routes cover CIF loading and export, selections, annotations, groups, restraints,
protonation, bonds, chains, segments, validation, and Undo. There are no design
or job routes.

See [architecture](../../docs/ARCHITECTURE.md) and [installation](../../docs/INSTALLATION.md).
