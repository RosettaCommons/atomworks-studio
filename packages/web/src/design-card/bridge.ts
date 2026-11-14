/**
 * The card inside an iframe of a host page (Studio opened with `?embed=1&card=1&parent_origin=<origin>`): generate and
 * refold requests cross to the parent with `postMessage`, and the parent answers with the same events a same-page
 * `DesignCardProvider` reports through its hooks. The Gradio host is one: ZeroGPU needs the call to come from the top
 * level Gradio page, which the frame cannot make itself. Documented in docs/INTEGRATIONS.md, "Design card in a frame".
 */
import type { RefoldLimits, RefoldModelInput, RefoldProvider, RefoldResult } from "../refold/types.ts";
import type { DesignCardProvider, DesignInfo, EngineInfo, GenerateHooks, ProviderSettings } from "./types.ts";

/** Messages the frame sends carry `source: "atomworks-studio"`, the parent's `source: "atomworks-design-host"`. */
export const STUDIO_SOURCE = "atomworks-studio";
export const HOST_SOURCE = "atomworks-design-host";

type HostMessage = { source: typeof HOST_SOURCE; type: string; id?: string; [key: string]: unknown };

type HostConfig = {
  engine: EngineInfo;
  settings?: ProviderSettings;
  refold?: { models: RefoldModelInput[]; limits?: RefoldLimits };
  guide?: boolean;
  zipTitle?: string;
};

let counter = 0;

/** Ask the parent for its engine; null when there is no parent, or it does not answer in `timeoutMs`. */
export async function connectDesignHost(parentOrigin: string, timeoutMs = 3000): Promise<DesignCardProvider | null> {
  if (window.parent === window) return null;
  let origin: string;
  try { origin = new URL(parentOrigin).origin; } catch { return null; }
  const send = (type: string, body: Record<string, unknown> = {}): void => {
    window.parent.postMessage({ source: STUDIO_SOURCE, channel: "design-card", type, ...body }, origin);
  };
  const ours = (ev: MessageEvent): ev is MessageEvent<HostMessage> =>
    ev.source === window.parent && ev.origin === origin && ev.data?.source === HOST_SOURCE;
  /** Listen for the messages of request `id` until `handler` says it is done. */
  const listen = (id: string, handler: (m: HostMessage) => boolean | void): (() => void) => {
    const on = (ev: MessageEvent): void => {
      if (!ours(ev) || ev.data.id !== id) return;
      if (handler(ev.data)) window.removeEventListener("message", on);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  };

  const config = await new Promise<HostConfig | null>((resolve) => {
    const timer = setTimeout(() => { window.removeEventListener("message", on); resolve(null); }, timeoutMs);
    function on(ev: MessageEvent): void {
      if (!ours(ev) || ev.data.type !== "config") return;
      clearTimeout(timer);
      window.removeEventListener("message", on);
      resolve(ev.data as unknown as HostConfig);
    }
    window.addEventListener("message", on);
    send("hello");
  });
  if (!config) return null;

  const refold: RefoldProvider | undefined = config.refold ? {
    models: config.refold.models,
    limits: config.refold.limits,
    refold: (design, settings, context) => new Promise<RefoldResult>((resolve, reject) => {
      const id = `refold-${(counter += 1)}`;
      const stop = listen(id, (m) => {
        if (m.type === "refold-status") { context.onStatus(m.status as never); return false; }
        if (m.type === "refold-result") { context.signal.removeEventListener("abort", abort); resolve(m.result as RefoldResult); return true; }
        if (m.type === "refold-error") { context.signal.removeEventListener("abort", abort); reject(new Error(String(m.message ?? "the refold failed"))); return true; }
        return false;
      });
      const abort = (): void => { send("abort", { id }); stop(); reject(new Error("aborted")); };
      if (context.signal.aborted) { abort(); return; }
      context.signal.addEventListener("abort", abort, { once: true });
      send("refold", { id, design: { id: design.id, name: design.name, cif: design.cif, kind: design.kind ?? null, data: design.data }, settings });
    }),
  } : undefined;

  return {
    engine: config.engine,
    settings: config.settings,
    zipTitle: config.zipTitle,
    refold,
    guide: config.guide ? () => send("guide") : undefined,
    generate: (request, hooks: GenerateHooks) => new Promise((resolve, reject) => {
      const id = `generate-${(counter += 1)}`;
      // Frames and designs are handed over in the order they came.
      let queue: Promise<unknown> = Promise.resolve();
      const stop = listen(id, (m) => {
        switch (m.type) {
          case "status": hooks.status(String(m.text ?? ""), m.options as { error?: boolean; visible?: boolean } | undefined); return false;
          case "progress": hooks.progress(Number(m.fraction) || 0, m.label as string | undefined); return false;
          case "loading": hooks.loading((m.text as string | null) ?? null); return false;
          case "frame": queue = queue.then(() => hooks.frame(String(m.cif), m.options as never)); return false;
          case "design": queue = queue.then(() => hooks.design(m.design as DesignInfo)); return false;
          case "done":
            request.signal.removeEventListener("abort", abort);
            void queue.then(() => resolve(m.result as { message?: string } | undefined), reject);
            return true;
          case "error":
            request.signal.removeEventListener("abort", abort);
            void queue.finally(() => reject(Object.assign(new Error(String(m.message ?? "generation failed")), { userMessage: m.userMessage as string | undefined })));
            return true;
          default: return false;
        }
      });
      const abort = (): void => { send("abort", { id }); stop(); reject(new Error("aborted")); };
      if (request.signal.aborted) { abort(); return; }
      request.signal.addEventListener("abort", abort, { once: true });
      send("generate", {
        id,
        request: { sessionId: request.sessionId, cif: request.cif, name: request.name, revision: request.revision, task: request.spec.task.key, settings: request.settings },
      });
    }),
  };
}
