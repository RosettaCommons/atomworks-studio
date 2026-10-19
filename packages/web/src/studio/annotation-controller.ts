import { api, ApiError } from "../api";
import { AnnotationOverlayState } from "../annotation-overlay";
import { element } from "../dom";
import { ANNOTATION_PALETTE } from "../viewers/contract";
import type { SelectionController } from "../selection-controller";
import type { AnnotationSummary, AnnotationValue } from "../types";
import type { MolecularViewer } from "../viewers";

export interface AnnotationControllerOptions {
  viewer: () => MolecularViewer;
  selection: SelectionController;
  getSessionId: () => string | null;
  log: (message: string, level?: "info" | "error") => void;
  runViewerUpdate: (operation: () => Promise<void>) => Promise<void>;
}

export class AnnotationController {
  private readonly list = element<HTMLDivElement>("annotation-list");
  private readonly detail = element<HTMLDivElement>("annotation-detail");
  private readonly overlay = new AnnotationOverlayState();
  private inspectionGeneration = 0;
  private activeView: string | null = null;
  private activeValue: string | null = null;

  constructor(private readonly options: AnnotationControllerOptions) {}

  bind(): void {
    element("clear-annotation-view").addEventListener("click", () => {
      void this.clearView();
    });
  }

  private async clearView(): Promise<void> {
    const session = this.options.getSessionId();
    const generation = ++this.inspectionGeneration;
    this.activeView = null;
    this.activeValue = null;
    this.activateRow(null);
    element<HTMLButtonElement>("clear-annotation-view").disabled = true;
    try {
      await this.options.runViewerUpdate(async () => {
        if (session !== this.options.getSessionId()) return;
        await this.overlay.clear(this.options.viewer(), this.options.selection.values);
        if (generation !== this.inspectionGeneration) return;
        this.detail.textContent = "Condition colors cleared. Choose a condition or click an atom to see its values.";
      });
    } catch (error) {
      this.options.log(`Could not clear annotation colors: ${String(error)}`, "error");
    }
  }

  render(annotations: AnnotationSummary[]): void {
    this.list.replaceChildren();
    if (!annotations.length) {
      this.list.className = "annotation-list muted";
      this.list.textContent = "No non-default conditions are stored on this structure.";
      this.detail.textContent = "Pick an atom in the molecular viewer to inspect it.";
      return;
    }
    this.list.className = "annotation-list";
    for (const annotation of annotations) {
      const row = this.appendRow(annotation.label, `${annotation.count} ${annotation.unit}`, (row) => {
        void this.inspectAnnotation(annotation.name, row);
      });
      row.dataset.viewKey = `annotations/${annotation.name}`;
      row.classList.toggle("active", annotation.name === this.activeView);
      row.setAttribute("aria-pressed", String(annotation.name === this.activeView));
    }
    this.detail.textContent = "Choose a condition to see its values, or click an atom to see its conditions.";
  }

  async display(annotation: AnnotationSummary, clearSelection = true): Promise<void> {
    let values = annotation.values.filter((value) => value.atom_indices?.length);
    if (values.length > ANNOTATION_PALETTE.length) {
      const selected = values.find(value => value.label === this.activeValue) ?? values[0];
      this.activeValue = selected.label;
      values = [selected];
    }
    const groups = values.map((value, index) => ({
      label: value.label, atomIndices: value.atom_indices!, color: value.color ?? ANNOTATION_PALETTE[index],
      showAtoms: annotation.unit === "atoms" || annotation.unit === "pairs",
    }));
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
            return value.label;
          });
          return `${annotation.label}: ${values.join(", ")}`;
        }),
      ].filter(Boolean);
      if (!atom.annotations.length) lines.push("No active conditions on this atom.");
      this.detail.textContent = lines.join("\n");
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
          `/api/sessions/${session}/annotations/${encodeURIComponent(view)}`,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        result = { annotation: null };
      }
      if (generation !== this.inspectionGeneration || session !== this.options.getSessionId()) return;
      if (result.annotation) {
        await this.display(result.annotation, false);
        const row = [...this.list.querySelectorAll<HTMLButtonElement>(".annotation-row")]
          .find((row) => row.dataset.viewKey === `annotations/${view}`);
        if (row) this.activateRow(row);
        this.renderDetail(result.annotation);
      } else {
        await this.overlay.clear(this.options.viewer(), this.options.selection.values);
        element<HTMLButtonElement>("clear-annotation-view").disabled = true;
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
    this.activeValue = null;
    element<HTMLButtonElement>("clear-annotation-view").disabled = true;
  }

  setDetail(message: string): void {
    this.detail.textContent = message;
  }

  private appendRow(
    labelText: string,
    countText: string,
    onClick: (row: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const row = document.createElement("button");
    row.className = "annotation-row";
    const label = document.createElement("span");
    label.textContent = labelText;
    const count = document.createElement("span");
    count.textContent = countText;
    row.append(label, count);
    row.addEventListener("click", () => onClick(row));
    this.list.appendChild(row);
    return row;
  }

  private formatValue(value: AnnotationValue, index: number, unit: string): string {
    const suffix = Array.isArray(value.value)
      ? ` = (${value.value.map((item) => item.toFixed(3)).join(", ")})`
      : unit === "pairs" ? ` = ${value.value}` : "";
    const color = value.color ?? ANNOTATION_PALETTE[index];
    return `${value.label}${suffix}: ${value.count.toLocaleString()} ${unit === "pairs" ? "pair" : "atom"}${value.count === 1 ? "" : "s"} (${color.name})`;
  }

  private renderDetail(annotation: AnnotationSummary): void {
    const values = annotation.values.filter(value => value.atom_indices?.length);
    this.detail.textContent = `${annotation.label}: ${annotation.count} ${annotation.unit}\n`;
    if (values.length <= ANNOTATION_PALETTE.length) {
      this.detail.append(values.map((value, index) => this.formatValue(value, index, annotation.unit)).join("\n"));
      return;
    }
    const label = document.createElement("label");
    label.textContent = "Highlight one group (too many for distinct colors)";
    const select = document.createElement("select");
    select.id = "annotation-value";
    for (const value of values) select.add(new Option(`${value.label}: ${value.count} atoms`, value.label));
    select.value = this.activeValue ?? values[0].label;
    select.addEventListener("change", () => {
      const row = this.list.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (row) void this.inspectAnnotation(annotation.name, row, select.value);
    });
    label.append(select);
    this.detail.append(label, this.formatValue(values.find(value => value.label === select.value)!, 0, annotation.unit));
  }

  private activateRow(row: HTMLButtonElement | null): void {
    for (const other of this.list.querySelectorAll(".annotation-row")) {
      other.classList.toggle("active", other === row);
      other.setAttribute("aria-pressed", String(other === row));
    }
  }

  private async inspectAnnotation(name: string, row: HTMLButtonElement, value?: string): Promise<void> {
    if (this.activeView === name && value === undefined) {
      await this.clearView();
      return;
    }
    if (this.activeView !== name) this.activeValue = null;
    if (value !== undefined) this.activeValue = value;
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
          this.activeView = null;
          this.activeValue = null;
          this.activateRow(null);
          await this.overlay.clear(this.options.viewer(), this.options.selection.values);
          element<HTMLButtonElement>("clear-annotation-view").disabled = true;
          this.detail.textContent = "This annotation is no longer active.";
          return;
        }
        await this.display(annotation);
        if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
        this.activeView = name;
        this.activateRow(row);
        this.renderDetail(annotation);
      });
    } catch (error) {
      if (generation !== this.inspectionGeneration || sessionId !== this.options.getSessionId()) return;
      this.detail.textContent = `Could not inspect annotation: ${String(error)}`;
    }
  }

}
