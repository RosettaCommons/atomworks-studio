import { api, apiText } from "../api";
import { element } from "../dom";
import type { StudioExample } from "../examples";
import type { SessionResponse, StudioSchema } from "../types";
import { inspect_cif } from "../wasm/annotation_studio_core.js";
import { prepareCifDownload } from "./authoring-actions";

export interface SessionFileControllerOptions {
  getSessionId: () => string | null;
  onOpened: (response: SessionResponse) => Promise<void>;
  onCombined: (response: SessionResponse, filename: string) => Promise<void>;
  log: (message: string) => void;
  runViewerUpdate: (operation: () => Promise<void>) => Promise<void>;
}

export class SessionFileController {
  private readonly fileInput = element<HTMLInputElement>("file-input");
  private readonly combineInput = element<HTMLInputElement>("combine-input");
  private examples: StudioExample[] = [];
  private openGeneration = 0;
  private openQueue: Promise<void> = Promise.resolve();
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
      for (const [name, value] of Object.entries(schema.presets[preset.value])) {
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
      if (file) void this.openFile(file);
    });
    this.combineInput.addEventListener("change", () => void this.combineFile());
    element("download").addEventListener("click", () => {
      const sessionId = this.options.getSessionId();
      if (sessionId) void this.options.runViewerUpdate(() => this.download(sessionId));
    });
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

  private openFile(file: File): Promise<boolean> {
    const generation = ++this.openGeneration;
    const request = this.openQueue.then(() => this.performOpen(file, generation));
    this.openQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  private async performOpen(file: File, generation: number): Promise<boolean> {
    if (generation !== this.openGeneration) return false;
    try {
      const cif = await file.text();
      inspect_cif(cif);
      const form = new FormData();
      form.append("file", file);
      this.appendParseOptions(form);
      const response = await api<SessionResponse>("/api/sessions", { method: "POST", body: form });
      if (generation !== this.openGeneration) return false;
      await this.options.onOpened(response);
      this.options.log("Native AtomWorks session ready.");
      return true;
    } catch (error) {
      if (generation === this.openGeneration) this.options.log(`Open failed: ${String(error)}`);
      return false;
    }
  }

  private appendParseOptions(form: FormData): void {
    form.append("parse_preset", element<HTMLSelectElement>("parse-preset").value);
    form.append("assembly", element<HTMLInputElement>("parse-assembly").value.trim() || "asym");
    const options: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(this.loadFields)) {
      const input = element<HTMLInputElement>(`parse-${name}`);
      if (!input.checkValidity()) throw new Error(`Invalid ${field.label}`);
      options[name] = field.kind === "boolean" ? input.checked
        : field.kind === "integer" ? (input.value === "" ? null : Number(input.value)) : input.value;
    }
    form.append("advanced_options", JSON.stringify(options));
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
    } finally {
      activeButton.textContent = originalLabel;
      for (const button of buttons) button.disabled = false;
    }
  }

  private async combineFile(): Promise<void> {
    const file = this.combineInput.files?.[0];
    const targetSession = this.options.getSessionId();
    if (!file || !targetSession) return;
    try {
      const cif = await file.text();
      inspect_cif(cif);
      const form = new FormData();
      form.append("file", file);
      this.appendParseOptions(form);
      const incoming = await api<SessionResponse>("/api/sessions", { method: "POST", body: form });
      const combined = await api<SessionResponse>(`/api/sessions/${targetSession}/combine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: [incoming.session_id] }),
      });
      if (this.options.getSessionId() !== targetSession) return;
      await this.options.onCombined(combined, file.name);
    } catch (error) {
      this.options.log(`Combine failed: ${String(error)}`);
    } finally {
      this.combineInput.value = "";
    }
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
      this.options.log(`Download failed: ${String(error)}`);
    } finally {
      button.disabled = this.options.getSessionId() === null;
    }
  }
}
