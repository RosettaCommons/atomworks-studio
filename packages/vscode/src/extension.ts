import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { StudioServer, serviceIsHealthy } from "./server.js";

const DEFAULT_SERVER_URL = "";
const SETUP_URL =
  "https://github.com/RosettaCommons/atomworks-studio#install";
type ViewerBackend = "patinae" | "molstar";
type HostTheme = "dark" | "light" | "high-contrast" | "high-contrast-light";
const studioPanels = new Map<string, vscode.WebviewPanel>();
const localPanels = new Set<vscode.WebviewPanel>();
let server: StudioServer;
let output: vscode.OutputChannel;

interface PythonApi {
  environments: {
    getActiveEnvironmentPath(): { path: string };
    resolveEnvironment(path: { path: string }): Promise<{ executable: { uri?: vscode.Uri } } | undefined>;
  };
}

async function localCommand(): Promise<{ command: string; args: string[] }> {
  let python = vscode.workspace.getConfiguration("annotationStudio").get<string>("pythonPath", "").trim();
  if (!python) {
    const extension = vscode.extensions.getExtension<PythonApi>("ms-python.python");
    if (extension) {
      const api = await extension.activate();
      const environment = await api.environments.resolveEnvironment(api.environments.getActiveEnvironmentPath());
      python = environment?.executable.uri?.fsPath ?? "";
    }
  }
  return python ? { command: python, args: ["-m", "atomworks_studio"] }
    : { command: "atomworks-studio", args: [] };
}

async function configurePython(): Promise<boolean> {
  const configuration = vscode.workspace.getConfiguration("annotationStudio");
  const value = await vscode.window.showInputBox({
    title: "Studio Python interpreter",
    prompt: "Python executable with atomworks-studio installed. Leave empty to use the selected Python environment or PATH.",
    value: configuration.get<string>("pythonPath", ""),
    ignoreFocusOut: true,
  });
  if (value === undefined) return false;
  await configuration.update("pythonPath", value.trim(), configurationTarget(configuration, "pythonPath"));
  return true;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function activeHostTheme(kind = vscode.window.activeColorTheme.kind): HostTheme {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return "light";
    case vscode.ColorThemeKind.HighContrast:
      return "high-contrast";
    case vscode.ColorThemeKind.HighContrastLight:
      return "high-contrast-light";
    default:
      return "dark";
  }
}

function parseServerUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    url.hash = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  } catch {
    return undefined;
  }
}

function configurationTarget(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): vscode.ConfigurationTarget {
  const inspection = configuration.inspect(key);
  if (inspection?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (inspection?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

async function configureServer(): Promise<boolean> {
  const configuration = vscode.workspace.getConfiguration("annotationStudio");
  const current = configuration.get<string>("serverUrl", DEFAULT_SERVER_URL);
  const value = await vscode.window.showInputBox({
    title: "AtomWorks Studio server",
    prompt: "Leave empty to start Studio automatically, or enter the URL of an existing server.",
    value: current,
    ignoreFocusOut: true,
    validateInput: (candidate) =>
      !candidate.trim() || parseServerUrl(candidate) ? undefined : "Enter an http:// or https:// URL.",
  });
  if (value === undefined) return false;
  const parsed = value.trim() ? parseServerUrl(value.trim()) : undefined;
  if (value.trim() && !parsed) return false;
  await configuration.update(
    "serverUrl",
    parsed?.toString() ?? "",
    configurationTarget(configuration, "serverUrl"),
  );
  return true;
}

async function selectViewerBackend(
  configuration: vscode.WorkspaceConfiguration,
  force = false,
): Promise<ViewerBackend | undefined> {
  const configured = configuration.get<string>("viewerBackend");
  // Use Mol* unless Patinae is explicitly configured. Prompt only on request.
  if (!force) return configured === "patinae" ? "patinae" : "molstar";
  const selected = await vscode.window.showQuickPick(
    [
      { label: "Patinae", detail: "WebGPU renderer", backend: "patinae" as const },
      { label: "Mol*", detail: "WebGL renderer", backend: "molstar" as const },
    ],
    {
      title: "Choose an AtomWorks Studio renderer",
      placeHolder: "Choose the molecular viewer.",
      ignoreFocusOut: true,
    },
  );
  if (!selected) return undefined;
  await configuration.update(
    "viewerBackend",
    selected.backend,
    configurationTarget(configuration, "viewerBackend"),
  );
  return selected.backend;
}

async function openStudio(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("annotationStudio");
  const configured = configuration.get<string>("serverUrl", DEFAULT_SERVER_URL);
  const viewerBackend = await selectViewerBackend(configuration);
  if (!viewerBackend) return;

  let serverUrl: URL;
  const automatic = !configured.trim();
  if (automatic) {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before starting its Python environment.");
    }
    try {
      serverUrl = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: "Starting AtomWorks Studio…",
      }, async () => {
        const { command, args } = await localCommand();
        return server.start(command, args);
      });
    } catch (error) {
      output.appendLine(String(error));
      const action = await vscode.window.showErrorMessage(
        "Studio could not start. Install atomworks-studio in your selected Python environment, or select its Python executable.",
        "Select Python", "Show logs", "Open setup instructions",
      );
      if (action === "Select Python" && await configurePython()) await openStudio();
      else if (action === "Show logs") output.show();
      else if (action === "Open setup instructions") void vscode.env.openExternal(vscode.Uri.parse(SETUP_URL));
      return;
    }
  } else {
    const parsed = parseServerUrl(configured);
    if (!parsed) {
      if (await configureServer()) await openStudio();
      return;
    }
    serverUrl = parsed;
    if (!(await serviceIsHealthy(serverUrl))) {
      const action = await vscode.window.showErrorMessage(
        `Studio is not reachable at ${serverUrl.origin}. Check that server or clear the server URL to start Studio automatically.`,
        "Configure server",
      );
      if (action === "Configure server" && await configureServer()) await openStudio();
      return;
    }
  }
  const panelKey = `${serverUrl.toString()}|${viewerBackend}`;
  const existing = studioPanels.get(panelKey);
  if (existing) {
    existing.reveal(vscode.ViewColumn.Active);
    return;
  }
  const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(serverUrl.toString()));
  const studioUrl = new URL(externalUri.toString());
  studioUrl.searchParams.set("embed", "1");
  studioUrl.searchParams.set("viewer", viewerBackend);
  studioUrl.searchParams.set("host", "vscode");
  studioUrl.searchParams.set("hostTheme", activeHostTheme());

  // Another Open command may have completed while the connection was resolving.
  const opened = studioPanels.get(panelKey);
  if (opened) {
    opened.reveal(vscode.ViewColumn.Active);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "atomworksAnnotationStudio",
    "AtomWorks Studio",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  studioPanels.set(panelKey, panel);
  if (automatic) localPanels.add(panel);
  const origin = escapeAttribute(studioUrl.origin);
  const src = escapeAttribute(studioUrl.toString());
  const nonce = randomBytes(16).toString("base64");
  const childOrigin = JSON.stringify(studioUrl.origin);
  const initialTheme = JSON.stringify(activeHostTheme());
  panel.webview.html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
      :root { color-scheme: light dark; }
      html, body, iframe { width: 100%; height: 100%; margin: 0; padding: 0; border: 0; overflow: hidden; }
      body {
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
      }
      iframe { display: block; background: var(--vscode-editor-background); }
    </style>
  </head>
  <body>
    <iframe id="studio-frame" src="${src}" title="AtomWorks Studio"
      allow="clipboard-read; clipboard-write; fullscreen"></iframe>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById("studio-frame");
      const childOrigin = ${childOrigin};
      const tokenMap = {
        "--bg-app": "--vscode-editor-background",
        "--surface-header": "--vscode-editor-background",
        "--surface-panel": "--vscode-sideBar-background",
        "--surface-card": "--vscode-sideBar-background",
        "--surface-raised": "--vscode-list-hoverBackground",
        "--surface-recessed": "--vscode-input-background",
        "--text": "--vscode-foreground",
        "--text-secondary": "--vscode-foreground",
        "--text-muted": "--vscode-descriptionForeground",
        "--text-subtle": "--vscode-descriptionForeground",
        "--border": "--vscode-panel-border",
        "--border-strong": "--vscode-input-border",
        "--accent": "--vscode-button-background",
        "--accent-hover": "--vscode-button-hoverBackground",
        "--accent-ink": "--vscode-button-foreground",
        "--accent-soft": "--vscode-list-inactiveSelectionBackground",
        "--focus": "--vscode-focusBorder",
      };
      const tokens = () => {
        const style = getComputedStyle(document.body);
        return Object.fromEntries(Object.entries(tokenMap).map(([key, value]) => [key, style.getPropertyValue(value).trim()]));
      };
      let currentTheme = ${initialTheme};
      const sendTheme = (theme) => frame.contentWindow?.postMessage({
        source: "atomworks-vscode-host",
        type: "theme",
        theme,
        tokens: tokens(),
      }, childOrigin);
      frame.addEventListener("load", () => sendTheme(currentTheme));
      new MutationObserver(() => sendTheme(currentTheme)).observe(document.body, {
        attributes: true, attributeFilter: ["class", "style", "data-vscode-theme-id"],
      });
      window.addEventListener("message", (event) => {
        if (event.source === frame.contentWindow && event.origin === childOrigin &&
            event.data?.source === "atomworks-studio" && event.data?.type === "open-guide") {
          vscode.postMessage({ type: "open-guide" });
          return;
        }
        if (event.data?.source === "atomworks-vscode-host" && event.data?.type === "theme") {
          currentTheme = event.data.theme;
          sendTheme(currentTheme);
        }
      });
    </script>
  </body>
</html>`;
  const guideSubscription = panel.webview.onDidReceiveMessage((message) => {
    if (message?.type === "open-guide") {
      void vscode.env.openExternal(vscode.Uri.parse(new URL("/guide/", studioUrl).toString()));
    }
  });
  const themeSubscription = vscode.window.onDidChangeActiveColorTheme((theme) => {
    void panel.webview.postMessage({
      source: "atomworks-vscode-host",
      type: "theme",
      theme: activeHostTheme(theme.kind),
    });
  });
  panel.onDidDispose(() => {
    studioPanels.delete(panelKey);
    localPanels.delete(panel);
    themeSubscription.dispose();
    guideSubscription.dispose();
  });
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("AtomWorks Studio");
  server = new StudioServer((message) => output.append(message), () => {
    for (const panel of localPanels) panel.dispose();
    void vscode.window.showWarningMessage("Studio stopped. Reopen Studio to restart it. Unsaved edits may have been lost.");
  });
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand("annotationStudio.open", async () => {
      try {
        await openStudio();
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not open AtomWorks Studio: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("annotationStudio.selectPython", async () => {
      if (await configurePython()) {
        void vscode.window.showInformationMessage("Studio Python updated. A running backend keeps its environment until the window reloads.");
      }
    }),
    vscode.commands.registerCommand("annotationStudio.configureServer", async () => {
      try {
        if (await configureServer()) {
          void vscode.window.showInformationMessage("AtomWorks Studio server updated.");
        }
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not update AtomWorks Studio server: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("annotationStudio.selectViewer", async () => {
      const selected = await selectViewerBackend(
        vscode.workspace.getConfiguration("annotationStudio"),
        true,
      );
      if (selected) void vscode.window.showInformationMessage(`AtomWorks Studio renderer: ${selected}.`);
    }),
  );
}

export async function deactivate(): Promise<void> {
  await server?.dispose();
}
