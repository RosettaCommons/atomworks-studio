# VS Code and Cursor

Studio runs in an editor tab and follows your VS Code theme. It uses the same
application and Python server as the browser.

## Local setup

1. Install Studio from the [wheel bundle](INSTALLATION.md#install-built-wheels)
   in a Python 3.12 environment.
2. Install the matching `.vsix`: **Extensions → ··· → Install from VSIX…**.
   Alternatively, run `code --install-extension path/to/extension.vsix`.
3. Run **AtomWorks: Open Studio** from the Command Palette.

Studio starts in the background on an available local port. No terminal or manual
server command is needed. The extension uses your selected Python environment
when the Microsoft Python extension is available; otherwise it runs
`atomworks-studio` from PATH. To use another installation, run
**AtomWorks: Select Python Interpreter** and enter that environment's Python
executable. The extension does not install Python packages automatically.

Use **Open CIF**, then follow the [walkthrough](TUTORIAL.md). Repeated Open
commands reuse the backend and existing tab. Changing renderers also reuses the
backend. Closing an editor tab keeps the backend available until the VS Code
window closes or reloads; then the extension stops only the process it started.
Save your CIF before closing or reloading the window.

Automatic startup requires a trusted workspace. The same setup works in Cursor.

## Download the extension

Use the VSIX supplied with your Studio build. CI also provides a
[build from main](https://github.com/RosettaCommons/atomworks-studio/releases/download/vscode-latest/atomworks-annotation-studio.vsix)
and attaches versioned builds to [GitHub releases](https://github.com/RosettaCommons/atomworks-studio/releases).
The repository currently requires GitHub access; Studio is not listed on the
VS Code Marketplace yet.

## Another server or renderer

To use an existing server, run **AtomWorks: Configure Studio Server** and enter
its URL, then **AtomWorks: Open Studio**. The extension connects without starting
or stopping that server. Clear the URL to return to automatic startup.
For example, an independently managed server on port 8001 can be started with
`atomworks-studio --vscode --port 8001`.

Mol*/WebGL is selected by default. **AtomWorks: Select Studio Renderer**
lets you choose Patinae/WebGPU instead. Run Open Studio to open the chosen
renderer. Both provide the same structure-editing operations.

With Remote SSH, install Studio in the remote Python environment. Automatic
startup runs on the extension host; VS Code forwards its address to the webview. Hosted services must allow the
editor's webview origin and its parent in `ANNOTATION_STUDIO_FRAME_ANCESTORS`.
The local `--vscode` option supplies the desktop/editor origins. Browser-hosted
VS Code may additionally need its specific top-level HTTPS origin.

## Troubleshooting

- **Startup failed:** use **Show logs**, or open **Output → AtomWorks Studio**.
  Check that Studio is installed in the selected Python environment. Use
  **AtomWorks: Select Python Interpreter** to choose another Python executable.
- **Server unreachable:** check the configured URL. Clear it for automatic startup.
- **Blank tab on an existing server:** start it with `--vscode` or check its embedding policy.
- **Viewer unavailable:** select Mol* when the editor cannot use WebGPU.
- **Old extension:** reinstall the matching VSIX and reload the editor window.

See [development](DEVELOPMENT.md) to build the extension.
