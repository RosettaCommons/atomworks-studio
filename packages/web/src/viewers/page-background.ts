/** White when the page (body or root, set by a host) is in a light theme, else black. */
export function pageBackground(): "black" | "white" {
  const theme = document.body?.dataset.hostTheme || document.documentElement.dataset.hostTheme || "";
  return theme.includes("light") ? "white" : "black";
}
