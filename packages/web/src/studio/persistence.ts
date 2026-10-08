import type { SessionResponse } from "../types";
import type { ViewerMode } from "../viewers";

// The old key also stored automatic defaults. Persist only explicit choices now.
export const VIEWER_STORAGE_KEY = "annotation-studio-viewer-v2";
export const PENDING_EXAMPLE_KEY = "annotation-studio-pending-example";

export function parseViewerMode(value: string | null): ViewerMode | null {
  return value === "patinae" || value === "molstar" ? value : null;
}

export function requestedViewerMode(
  search: URLSearchParams,
  storage: Pick<Storage, "getItem"> = localStorage,
): ViewerMode | null {
  return parseViewerMode(search.get("viewer")) ?? parseViewerMode(storage.getItem(VIEWER_STORAGE_KEY));
}

export function persistSession(
  response: SessionResponse,
  message?: string,
  storage: Pick<Storage, "setItem"> = sessionStorage,
): void {
  storage.setItem("annotation-studio-session", response.session_id);
  storage.setItem("annotation-studio-name", response.structure.name);
  if (message) storage.setItem("annotation-studio-message", message);
}
