document.addEventListener("DOMContentLoaded", () => {
  /* Tutorials use the installed editor and its real API. */
  for (const block of document.querySelectorAll("div.highlight")) {
    const code = block.querySelector("pre");
    if (!code || !navigator.clipboard) continue;
    const button = document.createElement("button");
    button.className = "copy-code";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code example");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy the code";
      }
    });
    block.prepend(button);
  }
  for (const button of document.querySelectorAll("button[data-studio-example]")) {
    button.addEventListener("click", async () => {
      const container = button.closest(".studio-example");
      const status = container.querySelector("[role=status]");
      button.disabled = true;
      try {
        if (!location.pathname.startsWith("/guide/")) throw new Error("standalone guide");
        const response = await fetch("/api/ready");
        if (!response.ok) throw new Error("backend unavailable");
        const frame = document.createElement("iframe");
        frame.title = "AtomWorks Studio interactive example";
        frame.src = `/?embed=1&viewer=molstar&example=${encodeURIComponent(button.dataset.studioExample)}`;
        container.append(frame);
        status.textContent = "The editor below uses your running Studio server. Edits stay in this session until you save a CIF.";
        button.hidden = true;
      } catch {
        status.textContent = "Start atomworks-studio, then open http://127.0.0.1:8000/guide/TUTORIAL.html to use the interactive editor. This static copy contains the complete written walkthrough.";
        button.disabled = false;
      }
    });
  }
});
