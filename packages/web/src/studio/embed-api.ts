/**
 * The surface a host page drives Studio through, on `window.atomworksStudio`.
 *
 * Studio is embedded two ways. In an iframe a host talks to it over `postMessage` and the HTTP API, which needs
 * nothing from this file. Embedded in the same page — a model running in the browser, a notebook, a Space that
 * streams results — a host needs to show frames as they arrive and drive the open document directly, and was
 * previously reduced to reaching into Studio's internals. This is that surface, named and documented, so an embedder
 * can be written against it and keep working across releases.
 *
 * Everything here goes through the same paths as the UI: edits are ordinary document mutations, so Undo, validation
 * and the "changed" notification behave exactly as they do for a click. The document on the server stays the source
 * of truth; nothing here writes to the viewer behind its back.
 */
import type { ViewerLoadOptions, ViewerOverlayOptions } from "../viewers";

export type StudioEmbedApi = {
  /** The Studio release this page was built from, so a host can check what it is talking to. */
  readonly version: string;

  /**
   * Show one frame of a structure the host is producing — a running trajectory, a live prediction. Successive calls
   * replace the data in place, so the scene does not flash; `keepCamera` leaves the view where the user put it.
   */
  renderFrame(cif: string, name: string, options?: ViewerLoadOptions): Promise<void>;

  /**
   * Show a display-only structure alongside the document under `key` (a reference motif, a target pose), updated in
   * place on later calls and removed with `null`. Overlays take no part in selection, annotation or analysis.
   */
  setOverlay(key: string, cif: string | null, options?: ViewerOverlayOptions): Promise<void>;

  /**
   * Trade picture quality for frame rate while you are streaming frames, and put the view back exactly as it was
   * when you stop. Worth doing around a run of `renderFrame` calls.
   */
  setLiveMode(on: boolean): void;

  /** Go back to showing the open document, after frames or a failed run. */
  showDocument(): Promise<void>;

  /** Open a session the host created, optionally with a trajectory to scrub. */
  openSession(sessionId: string, options?: { trajectoryUrl?: string | null }): Promise<void>;

  /** Open a file the host already has, exactly as the Open button would. */
  openFile(file: File): Promise<boolean>;

  /** Open one of the bundled examples by id. */
  openExample(id: string): Promise<void>;

  /**
   * Apply a document mutation by its API path, e.g. `/conditions/batch`. Goes through Studio's own mutate path, so
   * it is one Undo step and the viewer and panels refresh as usual.
   */
  applyEdit(path: string, body?: unknown): Promise<void>;

  /** The current selection, as document atom indices in ascending order. */
  getSelection(): number[];

  /** The colour Studio draws a chain in, so a host's own UI can match it. */
  chainColor(chainId: string): string;
};

declare global {
  interface Window {
    atomworksStudio?: StudioEmbedApi;
  }
}

/** Installs `window.atomworksStudio`. Called once at start-up; the host may be listening for `atomworks-studio`. */
export function installEmbedApi(api: StudioEmbedApi): void {
  window.atomworksStudio = api;
  notifyEmbedder("ready");
}

/** The `source` an iframe host already matches on, carried on the same-page event too. */
export const HOST_MESSAGE_SOURCE = "atomworks-annotation-studio";

/**
 * Tell a same-page host what happened: `ready`, `changed` and `example` as an iframe host hears them over
 * `postMessage`, plus `selection` when the user's selection changes, which a host offering selection-based actions
 * needs and cannot poll for.
 */
export function notifyEmbedder(
  type: "ready" | "changed" | "example" | "selection",
  detail: Record<string, unknown> = {},
): void {
  window.dispatchEvent(new CustomEvent("atomworks-studio", { detail: { type, ...detail } }));
}
