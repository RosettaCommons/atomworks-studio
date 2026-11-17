/**
 * The guide as a popup over the designer. `provider.guide = { url }` names a guide page (a page of its own that also
 * reads on its own); the card fetches it once, takes its `<main>`, and shows it in a <dialog> inside the page the card
 * lives in, so the Guide button opens the same popup in a browser page and in a host's frame. Links resolve against the
 * guide's address, its contents links scroll within the popup, and "back to the designer" is dropped (it is this page).
 */
import type { DesignCardProvider } from "./types.ts";

export type GuideOpener = { open(): Promise<void>; destroy(): void };

/** A guide that is an address (`{ url }`), as the card shows it; anything else is the provider's own action. */
export function guideUrl(guide: DesignCardProvider["guide"]): string | null {
  return guide && typeof guide === "object" && typeof guide.url === "string" && guide.url ? guide.url : null;
}

async function build(url: URL): Promise<HTMLDialogElement> {
  // Revalidated, not taken from the cache: a host may let a browser keep the page for minutes, so an edited guide showed stale.
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`guide not found (${res.status})`);
  const page = new DOMParser().parseFromString(await res.text(), "text/html");
  const main = page.querySelector("main");
  if (!main) throw new Error("guide has no content");
  // It is the host's own page, but only its text, links and pictures are wanted.
  for (const el of main.querySelectorAll("script, iframe, object, embed, style, link")) el.remove();
  for (const el of main.querySelectorAll("*")) for (const name of el.getAttributeNames()) if (name.startsWith("on")) el.removeAttribute(name);
  // Links point where they would from the guide's own page; "back to the designer" is the directory above it, so it goes.
  const parent = new URL("../", url).pathname;
  for (const a of main.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    const target = new URL(href, url);
    if (!/^(https?|mailto):$/.test(target.protocol)) { a.removeAttribute("href"); continue; }
    if (target.origin === url.origin && target.pathname === parent) { a.closest("p")?.remove(); continue; }
    a.href = target.href;
    a.target = "_blank";
    a.rel = "noopener";
  }
  // Images too: their paths are the guide page's.
  for (const img of main.querySelectorAll<HTMLImageElement>("img[src]")) img.src = new URL(img.getAttribute("src") ?? "", url).href;
  const dialog = document.createElement("dialog");
  dialog.className = "rfd4p-guide";
  dialog.setAttribute("aria-label", "Guide");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "rfd4p-guide-x";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("aria-label", "Close the guide");
  close.addEventListener("click", () => dialog.close());
  const body = document.createElement("div");
  body.className = "rfd4p-guide-body";
  body.append(...main.childNodes);
  // The contents scroll the popup rather than the page behind it.
  body.addEventListener("click", (ev) => {
    const a = (ev.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href^="#"]');
    if (!a) return;
    ev.preventDefault();
    body.querySelector(`#${CSS.escape(a.getAttribute("href")!.slice(1))}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // A click on the backdrop closes it.
  dialog.addEventListener("click", (ev) => { if (ev.target === dialog) dialog.close(); });
  dialog.append(close, body);
  document.body.append(dialog);
  return dialog;
}

/** Opens the guide at `address` (resolved against the page); if it cannot be read, the guide's own page in a new tab. */
export function createGuide(address: string): GuideOpener {
  const url = new URL(address, location.href);
  let dialog: HTMLDialogElement | null = null;
  return {
    async open() {
      try {
        dialog ??= await build(url);
        if (!dialog.open) dialog.showModal();
      } catch (err) {
        console.warn("Guide popup unavailable:", err);
        window.open(url.href, "_blank", "noopener");
      }
    },
    destroy() { dialog?.remove(); dialog = null; },
  };
}
