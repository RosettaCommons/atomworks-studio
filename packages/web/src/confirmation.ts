/** HTML dialogs also work in editor webviews, where window.confirm is blocked. */
export function confirmAction(message: string, action = "Apply", title = "Confirm edit"): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "confirmation";
    dialog.setAttribute("aria-labelledby", "confirmation-title");
    dialog.innerHTML = '<h2 id="confirmation-title"></h2><p></p><form method="dialog">'
      + '<button value="cancel" class="secondary" autofocus>Cancel</button>'
      + '<button value="confirm"></button></form>';
    dialog.querySelector("h2")!.textContent = title;
    dialog.querySelector("p")!.textContent = message;
    dialog.querySelector('button[value="confirm"]')!.textContent = action;
    dialog.addEventListener("close", () => {
      const accepted = dialog.returnValue === "confirm";
      dialog.remove();
      resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
