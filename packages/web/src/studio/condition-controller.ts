import { element } from "../dom";
import { confirmAction } from "../confirmation";
import { api } from "../api";
import type { SelectionController } from "../selection-controller";
import type { StudioSchema, ConditionEditorState, StructureSummary, Restraint, SessionResponse } from "../types";

export interface ConditionControllerOptions {
  selection: SelectionController;
  getRevision: () => number | undefined;
  getSessionId: () => string | null;
  onMarkersChanged: () => void;
  mutate: (path: string, body?: unknown) => Promise<void>;
}

// Conditions whose kind is "operation" use a dedicated endpoint for coupled edits.
const OPERATION_ENDPOINTS: Record<string, string> = {
  internal_coordinate: "/internal-coords",
};

export class ConditionController {
  private readonly conditionSelect = element<HTMLSelectElement>("condition");
  private readonly scopeSelect = element<HTMLSelectElement>("scope");
  private readonly enabledInput = element<HTMLInputElement>("enabled");
  private readonly conditionValue = element<HTMLDivElement>("condition-value");
  private readonly applyButton = element<HTMLButtonElement>("apply-condition");
  private readonly feedback = element<HTMLParagraphElement>("condition-feedback");
  private schema: StudioSchema | null = null;
  private hasSession = false;
  private state: ConditionEditorState = { groups: {}, centroids: {}, restraints: [] };
  private revision: number | undefined;
  private session: string | null = null;
  markersVisible = true;
  private picked: Array<number | null> = [null, null];
  private picking: number | null = null;
  private pairs: Restraint[] = [];
  private selectedPair: number | null = null;
  private pairDraftRevision: number | undefined;
  private pairDirty = false;
  private pairApplyPending = false;
  private preferredGroup: string | undefined;

  constructor(private readonly options: ConditionControllerOptions) {}

  update(summary: StructureSummary): void {
    this.state = summary.condition_editors;
    if (this.revision !== summary.revision || this.session !== this.options.getSessionId()) {
      this.picking = null;
      this.picked = [null, null];
      if (!this.pairDirty || this.session !== this.options.getSessionId()) {
        this.pairs = [...this.state.restraints];
        this.pairDraftRevision = summary.revision;
        this.selectedPair = null;
        this.pairDirty = false;
      }
    }
    this.revision = summary.revision;
    this.session = this.options.getSessionId();
    const definition = this.currentDefinition();
    if (definition?.group_editor || definition?.kind === "vector3" || definition?.kind === "pair") this.renderValue();
    this.updateSelectionUi(true);
  }

  acceptMutation(path: string, response: SessionResponse): void {
    if (path === "/distance-restraints/replace") this.pairDirty = false;
    if (path === "/groups" && response.edit_result?.group_id != null) {
      this.preferredGroup = String(response.edit_result.group_id);
    }
  }

  async handleAtomPicked(index: number): Promise<boolean> {
    if (this.picking === null) return false;
    this.picked[this.picking] = index;
    this.picking = null;
    this.options.selection.replace(this.picked.filter((value): value is number => value !== null));
    await this.updatePairEndpoints();
    return true;
  }

  setFeedback(message: string): void { this.feedback.textContent = message; }

  initialize(schema: StudioSchema): void {
    this.schema = schema;
    for (const [name, definition] of Object.entries(schema.conditions)) {
      this.conditionSelect.add(new Option(definition.label, name));
    }
    this.conditionChanged();
  }

  bind(): void {
    this.conditionSelect.addEventListener("change", () => this.conditionChanged());
    this.enabledInput.addEventListener("change", () => {
      this.renderValue();
      this.updateSelectionUi(this.hasSession);
    });
    this.applyButton.addEventListener("click", () => {
      const definition = this.currentDefinition();
      if (definition?.kind === "operation") {
        const endpoint = OPERATION_ENDPOINTS[this.conditionSelect.value];
        if (!endpoint) {
          this.feedback.textContent = "This operation is not available in this build.";
          return;
        }
        this.feedback.textContent = "Applying operation to the selection…";
        void this.options.mutate(endpoint, {
          atom_indices: [...this.options.selection.values],
          scope: this.scopeSelect.value,
          enabled: this.enabledInput.checked,
        });
        return;
      }
      this.feedback.textContent = this.enabledInput.checked
        ? "Applying condition…"
        : "Removing condition from the selection…";
      void this.options.mutate("/conditions", {
        condition: this.conditionSelect.value,
        atom_indices: [...this.options.selection.values],
        enabled: this.enabledInput.checked,
        value: this.selectedValue(),
        scope: this.scopeSelect.value,
      });
    });
  }

  updateSelectionUi(hasSession: boolean): void {
    this.hasSession = hasSession;
    const definition = this.currentDefinition();
    const pair = definition?.kind === "pair";
    const specialized = definition?.group_editor || definition?.kind === "vector3" || pair;
    this.applyButton.hidden = Boolean(specialized);
    this.enabledInput.closest("label")!.hidden = Boolean(specialized);
    this.scopeSelect.closest("label")!.hidden = Boolean(specialized);
    const count = this.options.selection.size;
    this.applyButton.disabled = !hasSession || !definition || (pair ? count !== 2 : count === 0);
    const clearTargets = this.conditionValue.querySelector<HTMLButtonElement>("#clear-internal-targets");
    if (clearTargets) clearTargets.disabled = !hasSession || count === 0;
    for (const button of this.conditionValue.querySelectorAll<HTMLButtonElement>("[data-needs-selection]")) {
      button.disabled = !hasSession || count === 0;
    }
    this.applyButton.textContent = this.enabledInput.checked ? "Apply to selection" : "Remove from selection";
    this.feedback.textContent = !hasSession
      ? "Open a structure to edit conditions."
      : !definition
        ? "Condition editing requires an installed provider."
        : pair
          ? count === 2
            ? "Ready: the selected atoms define one pair."
            : `Select exactly two atoms (${count} selected).`
          : count
            ? `Ready to update ${count} selected atom${count === 1 ? "" : "s"}.`
            : "Select one or more atoms.";
  }

  private conditionChanged(): void {
    this.picking = null;
    const definition = this.currentDefinition();
    if (!definition) return;
    this.scopeSelect.value =
      definition.level === "chain" ? "chain" : definition.level === "atom" ? "atom" : "residue";
    this.scopeSelect.disabled = definition.kind === "pair";
    this.renderValue();
    this.updateSelectionUi(this.hasSession);
  }

  private renderValue(): void {
    const definition = this.currentDefinition();
    const previousGroup = this.preferredGroup ?? this.conditionValue.querySelector<HTMLSelectElement>("#condition-group")?.value;
    this.preferredGroup = undefined;
    const previousChain = this.conditionValue.querySelector<HTMLSelectElement>("#centroid-chain")?.value;
    this.conditionValue.replaceChildren();
    if (definition?.group_editor) {
      const label = document.createElement("label");
      label.textContent = "Group";
      const select = document.createElement("select");
      select.id = "condition-group";
      const groups = this.state.groups[this.conditionSelect.value] ?? [];
      for (const group of groups) select.add(new Option(`Group ${group.id} (${group.count} atoms)`, String(group.id)));
      if (groups.some((group) => String(group.id) === previousGroup)) select.value = previousGroup!;
      label.append(select);
      this.conditionValue.append(label);
      for (const [action, text] of [["new", "New group from selection"], ["add", "Add selection to group"],
        ["remove", "Remove selection from any group"], ["delete", "Delete group"]]) {
        const button = document.createElement("button");
        button.id = `group-${action}`;
        button.textContent = text;
        if (action !== "delete") button.dataset.needsSelection = "true";
        button.addEventListener("click", () => void this.options.mutate("/groups", {
          condition: this.conditionSelect.value, action, atom_indices: [...this.options.selection.values],
          group_id: select.value === "" ? null : Number(select.value), expected_revision: this.options.getRevision(),
        }));
        this.conditionValue.append(button);
      }
      const update = () => {
        element<HTMLButtonElement>("group-delete").disabled = !groups.find((group) => String(group.id) === select.value)?.can_delete;
      };
      select.addEventListener("change", update);
      update();
      return;
    }
    if (definition?.kind === "pair") { this.renderPairs(); return; }
    if (definition?.kind === "vector3" && definition.level === "chain") {
      this.renderCentroid(previousChain);
      return;
    }
    if (this.conditionSelect.value === "internal_coordinate") {
      const clear = document.createElement("button");
      clear.id = "clear-internal-targets";
      clear.type = "button";
      clear.textContent = "Clear saved targets for selected groups";
      clear.disabled = !this.hasSession || this.options.selection.size === 0;
      clear.addEventListener("click", async () => {
        const revision = this.options.getRevision();
        const session = this.options.getSessionId();
        const atoms = [...this.options.selection.values];
        const scope = this.scopeSelect.value;
        if (revision === undefined || !session) return;
        if (!await confirmAction(
          "Clear saved targets for every atom in the selected internal-coordinate groups, " +
          "including group members outside the selection? New targets will be derived from " +
          "the structure when model inputs are prepared. Undo restores the saved targets.", "Clear targets",
        ) || session !== this.options.getSessionId()) return;
        void this.options.mutate("/internal-coords/clear-targets", {
          expected_revision: revision,
          atom_indices: atoms,
          scope,
        });
      });
      this.conditionValue.appendChild(clear);
    }
    if (!definition || definition.kind === "mask" || definition.kind === "operation") return;

    const label = document.createElement("label");
    label.textContent =
      definition.kind === "vector3"
        ? "Centroid (x, y, z)"
        : "Value";
    if (definition.kind === "enum") {
      const select = document.createElement("select");
      select.id = "condition-value-input";
      for (const [name, value] of Object.entries(definition.values ?? {})) {
        if (value !== definition.default) select.add(new Option(name, String(value)));
      }
      label.appendChild(select);
    } else if (definition.kind === "integer" || definition.kind === "scalar") {
      const input = document.createElement("input");
      input.id = "condition-value-input";
      input.type = "number";
      input.step = definition.kind === "integer" ? "1" : "0.1";
      input.value =
        typeof definition.default === "number"
          ? String(definition.default)
          : "0";
      input.disabled = !this.enabledInput.checked;
      label.appendChild(input);
    } else if (definition.kind === "text") {
      const input = document.createElement("input");
      input.id = "condition-value-input";
      input.type = "text";
      input.value = typeof definition.default === "string" ? definition.default : "";
      input.disabled = !this.enabledInput.checked;
      label.appendChild(input);
    } else {
      const wrapper = document.createElement("div");
      wrapper.className = "inline-fields";
      for (const axis of ["x", "y", "z"]) {
        const input = document.createElement("input");
        input.id = `condition-value-${axis}`;
        input.type = "number";
        input.step = "0.1";
        input.value = "0";
        wrapper.appendChild(input);
      }
      label.appendChild(wrapper);
    }
    this.conditionValue.appendChild(label);
  }

  private renderCentroid(previousChain?: string): void {
    const entries = this.state.centroids[this.conditionSelect.value] ?? [];
    const label = document.createElement("label");
    label.textContent = "Chain";
    const chain = document.createElement("select");
    chain.id = "centroid-chain";
    for (const entry of entries) chain.add(new Option(entry.chain, entry.chain));
    if (entries.some((entry) => entry.chain === previousChain)) chain.value = previousChain!;
    label.append(chain);
    this.conditionValue.append(label);
    const inputs = ["x", "y", "z"].map((axis) => {
      const label = document.createElement("label");
      label.textContent = `${axis} (Å)`;
      const input = document.createElement("input");
      input.id = `condition-value-${axis}`;
      input.type = "number"; input.step = "0.001"; input.value = "0";
      input.min = "-9999"; input.max = "9999";
      label.append(input); this.conditionValue.append(label);
      return input;
    });
    const saved = document.createElement("p");
    const load = () => {
      const target = entries.find((entry) => entry.chain === chain.value)?.target;
      saved.textContent = target ? `Saved target: ${target.map((v) => v.toFixed(3)).join(", ")} Å` : "No saved centroid target.";
      inputs.forEach((input, i) => { input.value = (target?.[i] ?? 0).toFixed(3); });
    };
    chain.addEventListener("change", load); load();
    this.conditionValue.append(saved);
    const fill = document.createElement("button");
    fill.id = "centroid-fill"; fill.textContent = "Fill with current centroid";
    fill.addEventListener("click", () => {
      const current = entries.find((entry) => entry.chain === chain.value)?.current;
      if (!current) { this.setFeedback("This chain has no resolved coordinates."); return; }
      inputs.forEach((input, i) => { input.value = current[i].toFixed(3); });
    });
    this.conditionValue.append(fill);
    const markerLabel = document.createElement("label"); markerLabel.className = "checkbox";
    const markerToggle = document.createElement("input"); markerToggle.type = "checkbox";
    markerToggle.id = "centroid-markers"; markerToggle.checked = this.markersVisible;
    markerToggle.addEventListener("change", () => {
      this.markersVisible = markerToggle.checked;
      this.options.onMarkersChanged();
    });
    markerLabel.append(markerToggle, "Show centroid markers"); this.conditionValue.append(markerLabel);
    for (const enabled of [true, false]) {
      const button = document.createElement("button");
      button.id = enabled ? "centroid-set" : "centroid-clear";
      button.textContent = enabled ? "Set centroid for chain" : "Clear centroid for chain";
      button.disabled = !entries.length;
      button.addEventListener("click", () => {
        if (enabled && inputs.some((input) => !input.value || !input.checkValidity())) {
          this.setFeedback("Enter three finite coordinates."); return;
        }
        void this.options.mutate("/centroids", {
          condition: this.conditionSelect.value, chain: chain.value,
          value: enabled ? inputs.map((input) => Number(input.value)) : null,
          expected_revision: this.options.getRevision(),
        });
      });
      this.conditionValue.append(button);
    }
  }

  private renderPairs(): void {
    const note = document.createElement("p");
    note.id = "pair-draft-status";
    note.textContent = this.pairDirty && this.pairDraftRevision !== this.revision
      ? "The structure changed. This draft is kept for reference; reload saved restraints before editing or applying."
      : "Changes in this table are saved only when you click Apply restraints.";
    const reload = document.createElement("button"); reload.textContent = "Reload saved restraints";
    reload.id = "pair-reload";
    reload.addEventListener("click", () => {
      this.pairDirty = false; this.pairs = [...this.state.restraints]; this.pairDraftRevision = this.revision;
      this.selectedPair = null; this.picked = [null, null]; this.renderValue();
    });
    this.conditionValue.append(note, reload);
    for (const slot of [0, 1]) {
      const label = document.createElement("p"); label.id = `pair-atom-${slot}`;
      label.textContent = `Atom ${slot + 1}: ${this.picked[slot] ?? "—"}`;
      const pick = document.createElement("button"); pick.id = `pair-pick-${slot}`;
      pick.textContent = `Select Atom ${slot + 1}`;
      pick.addEventListener("click", () => {
        this.picking = this.picking === slot ? null : slot;
        this.setFeedback(this.picking === null ? "Picking cancelled." : `Click atom ${slot + 1} in the viewer.`);
      });
      this.conditionValue.append(label, pick);
    }
    const useSelection = document.createElement("button");
    useSelection.id = "pair-use-selection"; useSelection.textContent = "Use two selected atoms";
    useSelection.addEventListener("click", () => {
      if (this.options.selection.size !== 2) { this.setFeedback("Select exactly two atoms."); return; }
      this.picked = [...this.options.selection.values];
      void this.updatePairEndpoints();
    });
    const label = document.createElement("label"); label.textContent = "Target distance (Å)";
    const distance = document.createElement("input");
    distance.id = "pair-distance"; distance.type = "number"; distance.min = "0.01"; distance.step = "0.01"; distance.value = "4";
    label.append(distance);
    const actual = document.createElement("button"); actual.id = "pair-actual"; actual.textContent = "Use actual distance";
    actual.addEventListener("click", () => void this.updatePairEndpoints(true));
    const add = document.createElement("button"); add.id = "pair-add"; add.textContent = "Add Pair";
    add.disabled = this.pairDirty && this.pairDraftRevision !== this.revision;
    add.addEventListener("click", () => {
      const [atom1, atom2] = this.picked;
      if (atom1 === null || atom2 === null || atom1 === atom2 || !distance.value || !distance.checkValidity()) {
        this.setFeedback("Pick two different atoms and enter a positive distance."); return;
      }
      this.pairs.push({ atom1, atom2, distance: Number(distance.value), current_distance: null,
        atom1_label: element(`pair-atom-0`).textContent!.replace(/^Atom 1: /, ""),
        atom2_label: element(`pair-atom-1`).textContent!.replace(/^Atom 2: /, ""),
      });
      this.pairDirty = true;
      this.renderPairTable();
    });
    const table = document.createElement("table"); table.id = "pair-table";
    const remove = document.createElement("button"); remove.id = "pair-delete"; remove.textContent = "Delete Selected";
    remove.addEventListener("click", () => {
      if (this.selectedPair !== null) this.pairs.splice(this.selectedPair, 1);
      this.pairDirty = true;
      this.selectedPair = null; this.renderPairTable();
    });
    const clear = document.createElement("button"); clear.id = "pair-clear"; clear.textContent = "Clear All";
    clear.addEventListener("click", async () => { this.pairs = []; this.pairDirty = true; this.selectedPair = null; this.renderPairTable(); });
    const apply = document.createElement("button"); apply.id = "pair-apply"; apply.textContent = "Apply restraints";
    apply.disabled = this.pairDirty && this.pairDraftRevision !== this.revision;
    apply.addEventListener("click", () => {
      this.pairApplyPending = true;
      for (const control of this.conditionValue.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) {
        control.disabled = true;
      }
      void this.options.mutate("/distance-restraints/replace", {
        pairs: this.pairs.map((pair) => [pair.atom1, pair.atom2]), values: this.pairs.map((pair) => pair.distance),
        expected_revision: this.pairDraftRevision,
      }).finally(() => {
        this.pairApplyPending = false;
        if (this.currentDefinition()?.kind === "pair") this.renderValue();
      });
    });
    this.conditionValue.append(useSelection, label, actual, add, table, remove, clear, apply);
    this.renderPairTable();
    if (this.pairApplyPending) {
      for (const control of this.conditionValue.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) {
        control.disabled = true;
      }
    }
  }

  private renderPairTable(): void {
    const table = element<HTMLTableElement>("pair-table");
    table.replaceChildren();
    const header = table.createTHead().insertRow();
    for (const label of ["Pair", "Target (Å)", "Current (Å)"]) {
      const cell = document.createElement("th"); cell.textContent = label; header.append(cell);
    }
    const body = table.createTBody();
    this.pairs.forEach((pair, index) => {
      const row = body.insertRow();
      const choose = document.createElement("button");
      choose.textContent = `${pair.atom1_label} ↔ ${pair.atom2_label}`;
      choose.setAttribute("aria-pressed", String(this.selectedPair === index));
      choose.disabled = this.pairDirty && this.pairDraftRevision !== this.revision;
      choose.addEventListener("click", () => {
        this.selectedPair = index;
        this.options.selection.replace([pair.atom1, pair.atom2]);
        this.renderPairTable();
      });
      row.insertCell().append(choose);
      row.insertCell().textContent = pair.distance.toFixed(2);
      row.insertCell().textContent = pair.current_distance?.toFixed(2) ?? "—";
    });
    element<HTMLButtonElement>("pair-delete").disabled = this.selectedPair === null;
  }

  private async updatePairEndpoints(useDistance = false): Promise<void> {
    const session = this.options.getSessionId();
    const revision = this.options.getRevision();
    const [atom1, atom2] = this.picked;
    if (!session || (atom1 === null && atom2 === null)) return;
    try {
      const result = await api<{ revision: number; distance: number | null; atom1_label: string; atom2_label: string }>(
        `/api/sessions/${session}/atom-distance?atom1=${atom1 ?? atom2}&atom2=${atom2 ?? atom1}`,
      );
      if (session !== this.options.getSessionId() || revision !== this.options.getRevision() ||
          result.revision !== revision || atom1 !== this.picked[0] || atom2 !== this.picked[1] ||
          this.currentDefinition()?.kind !== "pair") return;
      element("pair-atom-0").textContent = `Atom 1: ${atom1 === null ? "—" : result.atom1_label}`;
      element("pair-atom-1").textContent = `Atom 2: ${atom2 === null ? "—" : result.atom2_label}`;
      if (useDistance && atom1 !== null && atom2 !== null) {
        if (result.distance === null) this.setFeedback("The selected atoms have unresolved coordinates.");
        else element<HTMLInputElement>("pair-distance").value = result.distance.toFixed(2);
      }
    } catch (error) { this.setFeedback(String(error)); }
  }

  private selectedValue(): number | number[] | string | null {
    const definition = this.currentDefinition();
    if (!definition || !this.enabledInput.checked || definition.kind === "mask" || definition.kind === "operation")
      return null;
    if (definition.kind === "vector3") {
      return ["x", "y", "z"].map((axis) =>
        Number(element<HTMLInputElement>(`condition-value-${axis}`).value)
      );
    }
    if (definition.kind === "text") return element<HTMLInputElement>("condition-value-input").value;
    return Number(element<HTMLInputElement | HTMLSelectElement>("condition-value-input").value);
  }

  private currentDefinition() {
    return this.schema?.conditions[this.conditionSelect.value];
  }
}
