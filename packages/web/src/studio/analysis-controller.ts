import { api, postJson } from "../api";
import { closeToolbarMenus, element } from "../dom";
import type { SelectionController } from "../selection-controller";
import type { InteractionAnalysisResponse, SequenceChain } from "../types";
import { interactionDisplayContacts } from "./interaction-overlays";
import type { MolecularViewer, ViewerInteraction } from "../viewers";

type MeasurementKind = "distance" | "angle" | "dihedral";

interface MeasurementDraft {
  kind: MeasurementKind;
  atomIndices: number[];
}

export interface AnalysisControllerOptions {
  viewer: () => MolecularViewer;
  selection: SelectionController;
  getSessionId: () => string | null;
  getAtomCount: () => number;
  getSequence: () => SequenceChain[];
  mutate: (path: string, body?: unknown) => Promise<void>;
  renderViewerDrawers: () => void;
  log: (message: string, level?: "info" | "error") => void;
  onSelectionUiChange: () => void;
}

export class AnalysisController {
  private draft: MeasurementDraft | null = null;
  private readonly results = element("analysis-results");
  private readonly bondList = element("bond-list");
  private readonly inspectBondsButton = element("inspect-bonds");
  private bondInspectionGeneration = 0;

  constructor(private readonly options: AnalysisControllerOptions) {}

  bind(): void {
    element("run-analysis").addEventListener("click", () => void this.runInteractionAnalysis());
    element("measurement-kind").addEventListener("change", () => {
      this.draft = null;
      this.options.onSelectionUiChange();
    });
    element("add-measurement").addEventListener("click", () => this.addMeasurement());
    element("clear-analysis-visuals").addEventListener("click", () => {
      void this.options.viewer().clearInteractions().then(() => {
        this.results.replaceChildren();
        this.options.renderViewerDrawers();
        this.options.log("Interaction visuals cleared; user measurements were preserved.");
      });
    });
    this.inspectBondsButton.addEventListener("click", () => void this.inspectBonds());
    element("infer-bonds").addEventListener("click", () => void this.options.mutate("/bonds/infer-ccd"));

  }

  updateSelectionUi(hasSession: boolean): void {
    const kind = element<HTMLSelectElement>("measurement-kind").value as MeasurementKind;
    const required = this.requiredAtoms(kind);
    const button = element<HTMLButtonElement>("add-measurement");
    const viewer = this.options.viewer();
    button.disabled = !hasSession || !viewer.initialized || !viewer.capabilities.measurements;
    button.textContent = this.options.selection.size === required
      ? "Add measurement"
      : `Pick ${required} atoms`;
  }

  async handleAtomPicked(atomIndex: number, label?: string): Promise<boolean> {
    if (!this.draft) return false;
    if (!this.draft.atomIndices.includes(atomIndex)) this.draft.atomIndices.push(atomIndex);
    const required = this.requiredAtoms(this.draft.kind);
    this.options.selection.replace(this.draft.atomIndices);
    if (this.draft.atomIndices.length < required) {
      this.options.log(
        `${label ?? `Atom ${atomIndex}`} added to ${this.draft.kind}; `
        + `pick ${required - this.draft.atomIndices.length} more.`,
      );
      return true;
    }
    const request = this.draft;
    this.draft = null;
    try {
      await this.options.viewer().addMeasurement(request);
      this.options.renderViewerDrawers();
      this.openMeasurementsDrawer();
      this.options.log(`${request.kind} measurement added and visualized.`);
    } catch (error) {
      this.options.log(`Measurement failed: ${String(error)}`, "error");
    }
    this.options.onSelectionUiChange();
    return true;
  }

  private addMeasurement(): void {
    const kind = element<HTMLSelectElement>("measurement-kind").value as MeasurementKind;
    const atoms = [...this.options.selection.values];
    const required = this.requiredAtoms(kind);
    if (atoms.length !== required) {
      this.draft = { kind, atomIndices: [] };
      closeToolbarMenus();
      this.options.log(`${kind} measurement armed: pick ${required} atoms in order.`);
      return;
    }
    void this.options.viewer().addMeasurement({ kind, atomIndices: atoms }).then(() => {
      this.options.renderViewerDrawers();
      this.openMeasurementsDrawer();
      this.options.log(`${kind} measurement added and visualized.`);
    }).catch((error) => this.options.log(`Measurement failed: ${String(error)}`, "error"));
  }

  private async runInteractionAnalysis(): Promise<void> {
    const sessionId = this.options.getSessionId();
    if (!sessionId) return;
    const interactionTypes = [
      ...document.querySelectorAll<HTMLInputElement>('input[name="interaction-type"]:checked'),
    ].map((input) => input.value);
    if (!interactionTypes.length) {
      this.options.log("Choose at least one interaction type.");
      return;
    }
    const selectedAtoms = [...this.options.selection.values];
    const interactionScope = element<HTMLSelectElement>("interaction-scope").value;
    if (interactionScope !== "all" && !selectedAtoms.length) {
      this.options.log("Select atoms before using Selection contacts scope.");
      return;
    }
    const selectedSet = new Set(selectedAtoms);
    const targetAtoms = interactionScope === "within-selection"
      ? selectedAtoms
      : interactionScope === "selection-to-rest"
      ? Array.from({ length: this.options.getAtomCount() }, (_, index) => index)
        .filter((index) => !selectedSet.has(index))
      : [];
    try {
      const response = await postJson<InteractionAnalysisResponse>(
        `/api/sessions/${sessionId}/interactions/analyze`,
        {
          interaction_types: interactionTypes,
          hbond_model: element<HTMLSelectElement>("hbond-model").value,
          inter_chain_only: element<HTMLInputElement>("inter-chain-only").checked,
          source_atom_indices: interactionScope === "all" ? [] : selectedAtoms,
          target_atom_indices: targetAtoms,
        },
      );
      await this.renderInteractionResults(response);
    } catch (error) {
      this.options.log(`Analysis failed: ${String(error)}`, "error");
    }
  }

  private async renderInteractionResults(response: InteractionAnalysisResponse): Promise<void> {
    const colors: Record<string, number> = {
      hbond: 0x4dd0e1,
      hydrophobic: 0xffb74d,
      pistacking: 0xce93d8,
      pication: 0xf06292,
      saltbridge: 0x64b5f6,
      halogen: 0x81c784,
      metal: 0xffd54f,
    };
    const overlays: ViewerInteraction[] = interactionDisplayContacts(response.interactions, this.options.getSequence()).map((interaction, index) => ({
      id: `interaction_${interaction.interaction_type}_${index}`,
      type: interaction.interaction_type,
      atom1: interaction.atom1,
      atom2: interaction.atom2,
      label: `${interaction.distance.toFixed(2)} Å`,
      color: colors[interaction.interaction_type] ?? 0xffd54f,
    }));
    const visualLimit = Number(element<HTMLInputElement>("interaction-visual-limit").value);
    const visualized = element<HTMLInputElement>("visualize-interactions").checked ? overlays.slice(0, visualLimit) : [];
    await this.options.viewer().showInteractions(visualized);
    this.results.replaceChildren();
    if (!response.interactions.length) this.results.textContent = "No matching interactions found.";
    for (const interaction of response.interactions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "interaction-result";
      button.textContent = `${interaction.interaction_type}: atoms ${interaction.atom1}–${interaction.atom2}`
        + ` · ${interaction.distance.toFixed(2)} Å · ${interaction.atom1_role}/${interaction.atom2_role}`;
      button.addEventListener("click", () => {
        this.options.selection.replace([interaction.atom1, interaction.atom2], true);
        this.options.viewer().camera("center");
      });
      this.results.append(button);
    }
    element("editor-tab-main").click();
    element<HTMLDetailsElement>("interactions-drawer").open = true;
    this.options.renderViewerDrawers();
    this.options.log(
      `Interaction analysis completed: ${response.interaction_count} contacts`
      + `${visualized.length ? `; ${visualized.length} visualized` : ""}`
      + `${response.cached ? " (cached)" : ""}.`,
    );
  }

  clearBondInspection(): void {
    ++this.bondInspectionGeneration;
    this.bondList.hidden = true;
    this.bondList.replaceChildren();
    this.inspectBondsButton.setAttribute("aria-expanded", "false");
  }

  private async inspectBonds(): Promise<void> {
    if (!this.bondList.hidden) {
      this.clearBondInspection();
      return;
    }
    const sessionId = this.options.getSessionId();
    if (!sessionId) return;
    const generation = ++this.bondInspectionGeneration;
    this.bondList.hidden = false;
    this.bondList.textContent = "Loading bonds…";
    this.inspectBondsButton.setAttribute("aria-expanded", "true");
    const selected = [...this.options.selection.values];
    const query = selected.length === 1 ? `?atom_index=${selected[0]}` : "";
    try {
      const response = await api<{
        count: number;
        bonds: Array<{ atom1: number; atom2: number; bond_type: string }>;
      }>(`/api/sessions/${sessionId}/bonds${query}`);
      if (generation !== this.bondInspectionGeneration || sessionId !== this.options.getSessionId()) return;
      const list = this.bondList;
      list.replaceChildren();
      if (!response.bonds.length) list.textContent = "No bonds found.";
      for (const bond of response.bonds) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "interaction-result";
        button.textContent = `Atoms ${bond.atom1}–${bond.atom2} · ${bond.bond_type}`;
        button.addEventListener("click", () => this.options.selection.replace([bond.atom1, bond.atom2], true));
        list.append(button);
      }
    } catch (error) {
      if (generation !== this.bondInspectionGeneration || sessionId !== this.options.getSessionId()) return;
      this.bondList.textContent = "Could not load bonds. Close and reopen Inspect bonds to try again.";
      this.options.log(`Bond inspection failed: ${String(error)}`, "error");
    }
  }

  private openMeasurementsDrawer(): void {
    element("editor-tab-main").click();
    element<HTMLDetailsElement>("measurements-drawer").open = true;
  }

  private requiredAtoms(kind: MeasurementKind): number {
    return kind === "distance" ? 2 : kind === "angle" ? 3 : 4;
  }
}
