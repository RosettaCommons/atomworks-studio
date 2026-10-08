import { api, ApiError } from "../api";
import { AnnotationOverlayState } from "../annotation-overlay";
import { element } from "../dom";
import type { SelectionController } from "../selection-controller";
import type { AnnotationSummary, AnnotationValue } from "../types";
import type { MolecularViewer } from "../viewers";

export interface AnnotationControllerOptions {
  viewer: () => MolecularViewer;
  selection: SelectionController;
  getSessionId: () => string | null;
  log: (message: string) => void;
  runViewerUpdate: (operation: () => Promise<void>) => Promise<void>;
}

export class AnnotationController {
  private readonly list = element<HTMLDivElement>("annotation-list");
  private readonly detail = element<HTMLDivElement>("annotation-detail");
  private readonly search = element<HTMLInputElement>("annotation-search");
  private readonly overlay = new AnnotationOverlayState();
  private inspectionGeneration = 0;
  private activeView: { endpoint: string; name: string } | null = null;

  constructor(private readonly options: AnnotationControllerOptions) {}

  bind(): void {
    this.search.addEventListener("input", () => this.filterRows());
    element("clear-annotation-view").addEventListener("click", () => {
      ++this.inspectionGeneration;
      this.activeView = null;
      void this.options.runViewerUpdate(async () => {
        await this.overlay.clear(this.options.viewer(), this.options.selection.values);
        element<HTMLButtonElement>("clear-annotation-view").disabled = true;
        this.detail.textContent = "Annotation colors cleared. Click an annotation or pick an atom.";
      }).catch((error) => this.options.log(`Could not clear annotation colors: ${String(error)}`));
    });
  }

  render(
    annotations: AnnotationSummary[],
    storedFields: AnnotationSummary[],
    scalarFields: AnnotationSummary[],
  ): void {
    this.list.replaceChildren();
    if (!annotations.length && !storedFields.length && !scalarFields.length) {
      this.list.className = "annotation-list muted";
      this.list.textContent = "No explicitly stored, non-default annotations.";
      this.detail.textContent = "Pick an atom in the molecular viewer to inspect it.";
      return;
    }
    this.list.className = "annotation-list";
    for (const annotation of annotations) {
      const row = this.appendRow(annotation.label, `${annotation.count} ${annotation.unit}`, (row) => {
        void this.inspectAnnotation(annotation.name, row);
      });
      row.dataset.viewKey = `annotations/${annotation.name}`;
    }
    this.appendFields("Raw CIF fields (includes defaults)", storedFields, "annotation-fields");
    this.appendFields("Output confidence", scalarFields, "scalar-fields");
    this.detail.textContent = "Click an annotation to color it, or pick an atom for per-atom details.";
    this.filterRows();
  }

  async display(annotation: AnnotationSummary, clearSelection = true): Promise<void> {
    const groups = annotation.values
      .filter((value) => value.atom_indices?.length)
      .map((value) => ({ label: value.label, atomIndices: value.atom_indices!, color: value.color }));
    // Inspection must not leave unrelated editing-selection markers over the annotation.
    if (clearSelection) this.options.selection.clear();
    await this.overlay.show(this.options.viewer(), groups, this.options.selection.values);
    element<HTMLButtonElement>("clear-annotation-view").disabled = groups.length === 0;
  }

  async inspectAtom(atomIndex: number): Promise<void> {
    const sessionId = this.options.getSessionId();
    if (!sessionId) return;
    const generation = ++this.inspectionGeneration;
    try {
      const atom = await api<{
        atom_index: number;
        chain: string;
        residue_id: number;
        residue_name: string;
        atom_name: string;
        formal_charge?: number;
        annotations: Array<{ label: string; values: AnnotationValue[] }>;
        stored_fields: Array<{ name: string; label: string; value?: AnnotationValue["value"] }>;
        scalar_fields: Array<{ name: string; label: string; value: number }>;
      }>(`/api/sessions/${sessionId}/atoms/${atomIndex}/annotations`);
      if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
      const lines = [
        `${atom.chain}/${atom.residue_name} ${atom.residue_id}/${atom.atom_name} (atom ${atom.atom_index})`,
        atom.formal_charge
          ? `Formal charge: ${atom.formal_charge > 0 ? "+" : ""}${atom.formal_charge}`
          : "",
        ...atom.annotations.map((annotation) => {
          const values = annotation.values.map((value) => {
            if (Array.isArray(value.value)) return `${value.label} (${value.value.join(", ")})`;
            return value.value === undefined ? value.label : `${value.label} (${value.value})`;
          });
          return `${annotation.label}: ${values.join(", ")}`;
        }),
        ...atom.stored_fields.map((field) => `${field.name}: ${field.label}`),
        ...atom.scalar_fields.map((field) => `${field.label}: ${field.value.toFixed(2)}`),
      ].filter(Boolean);
      if (!atom.annotations.length) lines.push("No active annotations on this atom.");
      this.detail.textContent = lines.join("\n");
      for (const row of this.list.querySelectorAll(".annotation-row")) row.classList.remove("active");
    } catch (error) {
      if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
      this.detail.textContent = `Could not inspect atom: ${String(error)}`;
    }
  }

  async restore(): Promise<void> {
    const session = this.options.getSessionId();
    const view = this.activeView;
    if (session && view) {
      const generation = ++this.inspectionGeneration;
      let result: { annotation: AnnotationSummary | null };
      try {
        result = await api<{ annotation: AnnotationSummary | null }>(
          `/api/sessions/${session}/${view.endpoint}/${encodeURIComponent(view.name)}`,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        result = { annotation: null };
      }
      if (generation !== this.inspectionGeneration || session !== this.options.getSessionId()) return;
      if (result.annotation) {
        await this.display(result.annotation, false);
        const row = [...this.list.querySelectorAll<HTMLButtonElement>(".annotation-row")]
          .find((row) => row.dataset.viewKey === `${view.endpoint}/${view.name}`);
        if (row) this.activateRow(row);
        this.detail.textContent = [result.annotation.label, ...result.annotation.values.map((value) => this.formatValue(value))].join("\n");
      } else {
        await this.overlay.clear(this.options.viewer(), this.options.selection.values);
        element<HTMLButtonElement>("clear-annotation-view").disabled = true;
        if (view.endpoint !== "annotations") this.activeView = null;
        this.detail.textContent = "This annotation currently has no active values.";
      }
      return;
    }
    await this.overlay.restore(this.options.viewer(), this.options.selection.values);
  }

  reset(): void {
    ++this.inspectionGeneration;
    this.overlay.reset();
    this.activeView = null;
    element<HTMLButtonElement>("clear-annotation-view").disabled = true;
  }

  setDetail(message: string): void {
    this.detail.textContent = message;
  }

  private appendFields(
    headingText: string,
    fields: AnnotationSummary[],
    endpoint: "annotation-fields" | "scalar-fields",
  ): void {
    if (!fields.length) return;
    const rawFields = endpoint === "annotation-fields";
    const section = document.createElement(rawFields ? "details" : "div");
    section.className = "annotation-fields";
    const heading = document.createElement(rawFields ? "summary" : "div");
    heading.className = "annotation-fields-heading";
    heading.textContent = rawFields ? `${headingText} (${fields.length})` : headingText;
    section.appendChild(heading);
    if (rawFields) {
      const explanation = document.createElement("p");
      explanation.className = "muted";
      explanation.textContent = "These previews include unset/default values. Use the annotation rows above to see active constraints only.";
      section.appendChild(explanation);
    }
    this.list.appendChild(section);
    for (const field of fields) {
      const count = endpoint === "annotation-fields"
        ? `${field.values.length} value${field.values.length === 1 ? "" : "s"}`
        : `${field.count} ${field.unit}`;
      const row = this.appendRow(field.label, count, (row) => {
        void this.inspectStoredField(field.name, row, endpoint);
      }, rawFields, section);
      row.dataset.viewKey = `${endpoint}/${field.name}`;
    }
  }

  private appendRow(
    labelText: string,
    countText: string,
    onClick: (row: HTMLButtonElement) => void,
    field = false,
    parent: HTMLElement = this.list,
  ): HTMLButtonElement {
    const row = document.createElement("button");
    row.className = `annotation-row${field ? " annotation-field-row" : ""}`;
    const label = document.createElement("span");
    label.textContent = labelText;
    const count = document.createElement("span");
    count.textContent = countText;
    row.append(label, count);
    row.addEventListener("click", () => onClick(row));
    parent.appendChild(row);
    return row;
  }

  private filterRows(): void {
    const query = this.search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of this.list.querySelectorAll<HTMLElement>(".annotation-row")) {
      row.hidden = Boolean(query) && !row.textContent?.toLocaleLowerCase().includes(query);
      if (!row.hidden) visible += 1;
    }
    this.search.setAttribute("aria-description", `${visible} matching annotations`);
  }

  private formatValue(value: AnnotationValue): string {
    const suffix = Array.isArray(value.value)
      ? ` = (${value.value.map((item) => item.toFixed(3)).join(", ")})`
      : value.value === undefined ? "" : ` = ${value.value}`;
    return `${value.label}${suffix}: ${value.count.toLocaleString()} atom${value.count === 1 ? "" : "s"}`;
  }

  private activateRow(row: HTMLButtonElement): void {
    for (const other of this.list.querySelectorAll(".annotation-row")) {
      other.classList.toggle("active", other === row);
    }
  }

  private async inspectAnnotation(name: string, row: HTMLButtonElement): Promise<void> {
    const sessionId = this.options.getSessionId();
    if (!sessionId) return;
    const generation = ++this.inspectionGeneration;
    try {
      const result = await api<{ annotation: AnnotationSummary | null }>(
        `/api/sessions/${sessionId}/annotations/${encodeURIComponent(name)}`,
      );
      const annotation = result.annotation;
      await this.options.runViewerUpdate(async () => {
        if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
        if (!annotation) {
          await this.overlay.clear(this.options.viewer(), this.options.selection.values);
          element<HTMLButtonElement>("clear-annotation-view").disabled = true;
          this.detail.textContent = "This annotation is no longer active.";
          return;
        }
        await this.display(annotation);
        if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
        this.activeView = { endpoint: "annotations", name };
        this.activateRow(row);
        this.detail.textContent = [
          `${annotation.label}: ${annotation.count} ${annotation.unit}`,
          ...annotation.values.map((value) => this.formatValue(value)),
        ].join("\n");
      });
    } catch (error) {
      if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
      this.detail.textContent = `Could not inspect annotation: ${String(error)}`;
    }
  }

  private async inspectStoredField(
    name: string,
    row: HTMLButtonElement,
    endpoint: "annotation-fields" | "scalar-fields",
  ): Promise<void> {
    const sessionId = this.options.getSessionId();
    if (!sessionId) return;
    const generation = ++this.inspectionGeneration;
    try {
      const result = await api<{ annotation: AnnotationSummary }>(
        `/api/sessions/${sessionId}/${endpoint}/${encodeURIComponent(name)}`,
      );
      await this.options.runViewerUpdate(async () => {
        if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
        await this.display(result.annotation);
        if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
        this.activeView = { endpoint, name };
        this.activateRow(row);
        this.detail.textContent = [
          `${result.annotation.label}: ${result.annotation.count} ${result.annotation.unit}`,
          endpoint === "annotation-fields" ? "Raw field preview: includes unset/default values, not just active constraints." : "",
          ...result.annotation.values.map((value) => this.formatValue(value)),
          result.annotation.truncated ? "Additional distinct values omitted from this preview." : "",
        ].filter(Boolean).join("\n");
      });
    } catch (error) {
      if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
      this.detail.textContent = `Could not inspect stored field: ${String(error)}`;
    }
  }
}
