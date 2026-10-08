import { element } from "../dom";
import type { StudioSchema } from "../types";

/** Match the native PyMOL tab order, supplied by the shared editing package. */
export function initializeEditorTabs(tabs: StudioSchema["editor_tabs"]): void {
  const inspector = element("atomworks-studio-popover");
  const list = document.createElement("div");
  list.className = "editor-tabs";
  list.setAttribute("role", "tablist");
  list.setAttribute("aria-label", "Structure editor");
  const buttons: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];
  const activate = (index: number): void => {
    buttons.forEach((button, i) => {
      button.setAttribute("aria-selected", String(i === index));
      button.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
  };
  tabs.forEach(({ id, label }, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `editor-tab-${id}`;
    button.textContent = label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `editor-panel-${id}`);
    button.addEventListener("click", () => activate(index));
    button.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); activate(next); buttons[next].focus();
    });
    const panel = document.createElement("section");
    panel.id = `editor-panel-${id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    for (const card of inspector.querySelectorAll<HTMLElement>(`[data-editor-card="${id}"]`)) {
      if (id !== "main" && card instanceof HTMLDetailsElement) card.open = true;
      panel.append(card);
    }
    buttons.push(button); panels.push(panel); list.append(button);
    inspector.append(panel);
  });
  inspector.querySelector(".editor-document")!.after(list);
  activate(0);
}
