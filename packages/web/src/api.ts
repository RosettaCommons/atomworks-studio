import type { paths } from "./generated/api";

export type StudioApiPaths = paths;
export type ApiErrorKind = "http" | "network" | "aborted" | "timeout" | "parse";

export class ApiError extends Error {
  readonly name = "ApiError";
  readonly status: number;
  readonly url: string;
  readonly kind: ApiErrorKind;
  readonly detail?: unknown;

  constructor(
    message: string,
    status: number,
    url: string,
    kind: ApiErrorKind,
    detail?: unknown,
  ) {
    super(message);
    this.status = status;
    this.url = url;
    this.kind = kind;
    this.detail = detail;
  }
}

export type ApiRequestInit = RequestInit & { timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 30_000;

export function versionedApiPath(path: string): string {
  return path.startsWith("/api/") && !path.startsWith("/api/v1/")
    ? `/api/v1/${path.slice("/api/".length)}`
    : path;
}

async function request(path: string, init: ApiRequestInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...requestInit } = init;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Request timed out", "TimeoutError"));
      }, timeoutMs)
    : undefined;

  try {
    const response = await fetch(versionedApiPath(path), { ...requestInit, signal: controller.signal });
    if (response.ok) return response;
    const contentType = response.headers.get("content-type") ?? "";
    let detail: unknown;
    try {
      detail = contentType.includes("json") ? await response.json() : await response.text();
    } catch {
      detail = undefined;
    }
    const message =
      typeof detail === "object" && detail !== null && "detail" in detail
        ? String((detail as { detail: unknown }).detail)
        : typeof detail === "string" && detail.trim()
          ? detail
          : `${response.status} ${response.statusText}`;
    throw new ApiError(message, response.status, path, "http", detail);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) {
      throw new ApiError(`Request timed out after ${timeoutMs} ms`, 0, path, "timeout", error);
    }
    if (callerSignal?.aborted || controller.signal.aborted) {
      throw new ApiError("Request was aborted", 0, path, "aborted", error);
    }
    throw new ApiError(
      error instanceof Error ? error.message : "Network request failed",
      0,
      path,
      "network",
      error,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function api<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const response = await request(path, init);
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ApiError("API returned invalid JSON", response.status, path, "parse", error);
  }
}

export async function apiText(path: string, init?: ApiRequestInit): Promise<string> {
  return request(path, init).then((response) => response.text());
}

export async function apiBlob(path: string, init?: ApiRequestInit): Promise<Blob> {
  return request(path, init).then((response) => response.blob());
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
