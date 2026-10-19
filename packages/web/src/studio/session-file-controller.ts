import { api, apiText, ApiError } from "../api";
import { confirmAction } from "../confirmation";
import { element } from "../dom";
import type { StudioExample } from "../examples";
import type { SessionResponse, StudioSchema } from "../types";
import { inspect_cif } from "../wasm/annotation_studio_core.js";
import { prepareCifDownload } from "./authoring-actions";
import { PENDING_EXAMPLE_KEY } from "./persistence";

export interface SessionFileControllerOptions {
  getSessionId: () => string | null;
  onOpened: (response: SessionResponse) => Promise<void>;
  onCombined: (response: SessionResponse, filename: string) => Promise<void>;
  log: (message: string, level?: "info" | "error") => void;
  runViewerUpdate: (operation: () => Promise<void>) => Promise<void>;
}

export class SessionFileController {
  private readonly fileInput = element<HTMLInputElement>("file-input");
  private readonly combineInput = element<HTMLInputElement>("combine-input");
  private examples: StudioExample[] = [];
  private openGeneration = 0;
  private openQueue: Promise<void> = Promise.resolve();
  private manualBase = "minimal";
  private importDialog: HTMLDialogElement | null = null;
  private loadFields: StudioSchema["loading"]["fields"] = {};

  constructor(private readonly options: SessionFileControllerOptions) {}

  initializeLoading(schema: StudioSchema["loading"]): void {
    this.loadFields = schema.fields;
    const container = element("parse-fields");
    for (const [name, field] of Object.entries(schema.fields)) {
      const label = document.createElement("label"); label.textContent = field.label;
      const input = document.createElement(field.kind === "choice" ? "select" : "input");
      input.id = `parse-${name}`;
      if (input instanceof HTMLSelectElement) {
        for (const choice of field.choices ?? []) input.add(new Option(choice, choice));
      } else {
        input.type = field.kind === "boolean" ? "checkbox" : field.kind === "integer" ? "number" : "text";
        if (field.kind === "integer") { input.min = "0"; input.step = "1"; }
        if (field.kind === "boolean") label.className = "checkbox";
      }
      label.append(input); container.append(label);
    }
    const warning = document.createElement("p");
    warning.textContent = "Loading without saved annotations discards the existing conditions in this CIF.";
    container.append(warning);
    const annotations = element<HTMLInputElement>("parse-load_standard_annotations");
    annotations.addEventListener("change", () => { warning.hidden = annotations.checked; });
    const preset = element<HTMLSelectElement>("parse-preset");
    const apply = () => {
      element("parse-manual").hidden = preset.value !== "manual";
      element("parse-description").textContent = {
        auto: "Infer a preset from the file",
        minimal: "Keep saved StandardAnnotations and the existing atom list.",
        rcsb: "Discard saved annotations and prepare the structure, including adding missing heavy-atom records. Added atoms have no coordinates.",
        manual: "Customize the settings below. Adding atoms and keeping saved annotations cannot be combined.",
      }[preset.value] ?? "";
      if (preset.value === "manual") return;
      this.manualBase = preset.value === "auto" ? "minimal" : preset.value;
      for (const [name, value] of Object.entries(schema.presets[preset.value === "auto" ? "minimal" : preset.value])) {
        const input = element<HTMLInputElement | HTMLSelectElement>(`parse-${name}`);
        if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(value);
        else input.value = Array.isArray(value) ? value.join(",") : String(value ?? "");
      }
      element<HTMLInputElement>("parse-assembly").value = "1";
      warning.hidden = annotations.checked;
    };
    preset.addEventListener("change", apply); apply();
  }

  bind(): void {
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) void this.openFile(file);
    });
    this.combineInput.addEventListener("change", () => void this.combineFile());
    element("close-structure").addEventListener("click", () => void this.closeStructure());
    element("download").addEventListener("click", () => {
      const sessionId = this.options.getSessionId();
      if (sessionId) void this.options.runViewerUpdate(() => this.download(sessionId));
    });
  }

  private async closeStructure(): Promise<void> {
    const sessionId = this.options.getSessionId();
    if (!sessionId || !await confirmAction(
      "Close this document and remove its saved session? Save CIF first if you want to keep your edits. Your original file is unchanged.",
      "Close structure", "Close structure",
    )) return;
    if (sessionId !== this.options.getSessionId()) return;
    ++this.openGeneration;
    this.importDialog?.close("cancel");
    const button = element<HTMLButtonElement>("close-structure");
    button.disabled = true;
    try {
      await this.options.runViewerUpdate(async () => {
        if (sessionId !== this.options.getSessionId()) return;
        try {
          await apiText(`/api/sessions/${sessionId}`, { method: "DELETE" });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        if (sessionId !== this.options.getSessionId()) return;
        for (const key of [
          "annotation-studio-session", "annotation-studio-name", "annotation-studio-message", PENDING_EXAMPLE_KEY,
        ]) sessionStorage.removeItem(key);
        const url = new URL(window.location.href);
        for (const key of ["session", "example", "trajectory"]) url.searchParams.delete(key);
        window.location.replace(url.href);
      });
    } catch (error) {
      this.options.log(`Could not close structure: ${String(error)}. The document is still open.`, "error");
    } finally {
      button.disabled = !this.options.getSessionId();
    }
  }

  async initializeExamples(): Promise<void> {
    this.examples = await api<StudioExample[]>("/api/examples");
    const container = element("example-list");
    container.replaceChildren();
    for (const example of this.examples) {
      const button = document.createElement("button");
      button.className = "secondary example-load";
      button.dataset.example = example.id;
      button.textContent = example.label;
      button.addEventListener("click", () => void this.loadExample(example, button));
      container.append(button);
    }
  }

  async loadPendingExample(id: string): Promise<void> {
    const example = this.examples.find((candidate) => candidate.id === id);
    if (!example) return;
    const button = document.querySelector<HTMLButtonElement>(
      `.example-load[data-example="${example.id}"]`,
    );
    if (example && button) await this.loadExample(example, button);
  }

  private openFile(file: File, targetSession: string | null = null): Promise<boolean> {
    const generation = ++this.openGeneration;
    this.importDialog?.close("cancel");
    const request = this.openQueue.then(() => this.performOpen(file, generation, targetSession));
    this.openQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  private async performOpen(file: File, generation: number, targetSession: string | null): Promise<boolean> {
    const isCurrent = () => generation === this.openGeneration
      && (targetSession === null || targetSession === this.options.getSessionId());
    if (!isCurrent()) return false;
    let temporarySession: string | null = null;
    try {
      const cif = await file.text();
      inspect_cif(cif);
      const form = await this.prepareImport(file, isCurrent);
      if (!form) return false;
      const response = await api<SessionResponse>("/api/sessions", { method: "POST", body: form });
      temporarySession = response.session_id;
      if (!isCurrent()) return false;
      if (targetSession) {
        const combined = await api<SessionResponse>(`/api/sessions/${targetSession}/combine`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_ids: [response.session_id] }),
        });
        if (!isCurrent()) return false;
        await this.options.onCombined(combined, file.name);
      } else {
        await this.options.onOpened(response);
        temporarySession = null;
        this.options.log("Native AtomWorks session ready.");
      }
      return true;
    } catch (error) {
      if (isCurrent()) this.options.log(`${targetSession ? "Combine" : "Open"} failed: ${String(error)}`, "error");
      return false;
    } finally {
      if (temporarySession && temporarySession !== this.options.getSessionId()) {
        try {
          await apiText(`/api/sessions/${temporarySession}`, { method: "DELETE" });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) {
            this.options.log(`Could not remove the temporary import session: ${String(error)}`, "error");
          }
        }
      }
    }
  }

  private async prepareImport(file: File, isCurrent: () => boolean): Promise<FormData | null> {
    const form = new FormData();
    form.append("file", file);
    const preset = element<HTMLSelectElement>("parse-preset").value;
    if (preset !== "auto") {
      this.appendParseOptions(form);
      return form;
    }
    this.options.log(`Inspecting ${file.name}…`);
    const inspection = await api<{ preset: string | null; message: string }>("/api/import/inspect", {
      method: "POST", body: form,
    });
    if (!isCurrent()) return null;
    if (inspection.preset) {
      form.append("parse_preset", inspection.preset);
      this.options.log(inspection.message);
      return form;
    }
    const accepted = await this.chooseImportOptions(inspection.message, form);
    return accepted && isCurrent() ? form : null;
  }

  private chooseImportOptions(message: string, form: FormData): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      this.importDialog = dialog;
      dialog.className = "confirmation import-dialog";
      dialog.setAttribute("aria-labelledby", "import-title");
      dialog.innerHTML = '<h2 id="import-title">Choose how to import this file</h2><p></p>'
        + '<form method="dialog"><button value="cancel" class="secondary" autofocus>Cancel</button>'
        + '<button value="import" disabled>Import</button></form>';
      dialog.querySelector("p")!.textContent = message;
      const preset = element<HTMLSelectElement>("parse-preset");
      const settings = element("import-settings");
      const parent = settings.parentElement!;
      dialog.insertBefore(settings, dialog.querySelector("form"));
      const errorMessage = document.createElement("p");
      errorMessage.className = "error-text";
      errorMessage.setAttribute("role", "alert");
      dialog.insertBefore(errorMessage, dialog.querySelector("form"));
      const automatic = preset.querySelector<HTMLOptionElement>('option[value="auto"]')!;
      const automaticLabel = automatic.text;
      automatic.disabled = true;
      automatic.text = "Choose a preset or Custom";
      settings.querySelector<HTMLElement>("#parse-description")!.textContent = "Choose how to handle this file before importing.";
      const update = () => { dialog.querySelector<HTMLButtonElement>('button[value="import"]')!.disabled = preset.value === "auto"; };
      preset.addEventListener("change", update);
      dialog.querySelector("form")!.addEventListener("submit", (event) => {
        if ((event.submitter as HTMLButtonElement)?.value !== "import") return;
        try { this.appendParseOptions(form); }
        catch (error) { event.preventDefault(); errorMessage.textContent = String(error); }
      });
      dialog.addEventListener("close", () => {
        parent.append(settings);
        automatic.disabled = false;
        automatic.text = automaticLabel;
        preset.value = "auto";
        preset.dispatchEvent(new Event("change"));
        preset.removeEventListener("change", update);
        this.importDialog = null;
        dialog.remove();
        resolve(dialog.returnValue === "import");
      }, { once: true });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  private appendParseOptions(form: FormData): void {
    const preset = element<HTMLSelectElement>("parse-preset").value;
    const options: Record<string, unknown> = {};
    if (preset !== "manual") {
      form.set("parse_preset", preset);
      form.delete("advanced_options");
      form.delete("assembly");
      return;
    }

    for (const [name, field] of Object.entries(this.loadFields)) {
      const input = element<HTMLInputElement>(`parse-${name}`);
      if (!input.checkValidity()) throw new Error(`Invalid ${field.label}`);
      options[name] = field.kind === "boolean" ? input.checked
        : field.kind === "integer" ? (input.value === "" ? null : Number(input.value)) : input.value;
    }
    if (options.load_standard_annotations && (options.add_missing_atoms || options.convert_mse_to_met)) {
      throw new Error("Keeping saved annotations cannot be combined with adding atoms or converting MSE to MET.");
    }
    form.set("parse_preset", this.manualBase);
    form.set("assembly", element<HTMLInputElement>("parse-assembly").value.trim() || "asym");
    form.set("advanced_options", JSON.stringify(options));
  }

  private async loadExample(
    example: StudioExample,
    activeButton: HTMLButtonElement,
  ): Promise<void> {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".example-load")];
    for (const button of buttons) button.disabled = true;
    const originalLabel = activeButton.textContent;
    activeButton.textContent = "Loading…";
    try {
      const loaded = await this.openFile(
        new File([await apiText(`/api/examples/${example.id}/cif`)], example.file, { type: "chemical/x-mmcif" }),
      );
      if (!loaded) return;
      this.options.log(`Loaded ${example.label}.`);
      window.dispatchEvent(new CustomEvent("studio-example-loaded", { detail: example }));
    } catch (error) {
      this.options.log(`Example failed: ${String(error)}`, "error");
    } finally {
      activeButton.textContent = originalLabel;
      for (const button of buttons) button.disabled = false;
    }
  }

  private async combineFile(): Promise<void> {
    const file = this.combineInput.files?.[0];
    const targetSession = this.options.getSessionId();
    this.combineInput.value = "";
    if (file && targetSession) await this.openFile(file, targetSession);
  }

  private async download(sessionId: string): Promise<void> {
    if (sessionId !== this.options.getSessionId()) return;
    const button = element<HTMLButtonElement>("download");
    button.disabled = true;
    try {
      this.options.log("Validating structure before saving…");
      const result = await prepareCifDownload(sessionId, () => sessionId === this.options.getSessionId());
      if (!result) {
        this.options.log("Save cancelled.");
        return;
      }
      const blob = new Blob([result.cif], { type: "chemical/x-mmcif" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = `${result.name}_annotated.cif`;
      anchor.click();
      URL.revokeObjectURL(anchor.href);
      this.options.log(result.issues.length ? "Saved with validation issues." : "Validation passed. Structure saved.");
    } catch (error) {
      this.options.log(`Download failed: ${String(error)}`, "error");
    } finally {
      button.disabled = this.options.getSessionId() === null;
    }
  }
}
