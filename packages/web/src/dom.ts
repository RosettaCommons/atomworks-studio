export function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element #${id}`);
  return value as T;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!,
  );
}

export function closeToolbarMenus(except?: HTMLDetailsElement): void {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(".viewer-menu")) {
    if (menu !== except) {
      menu.open = false;
    }
  }
}

export function applyCapabilities(capabilities: object): void {
  const available = capabilities as Record<string, boolean>;
  for (const control of document.querySelectorAll<HTMLElement>("[data-capability]")) {
    const required = (control.dataset.capability ?? "").split(/\s+/).filter(Boolean);
    control.hidden = required.some((name) => !available[name]);
  }
}
