import type { MolecularViewer } from "../viewers";
import type { AtomCharge } from "../viewers/contract";
import { api } from "../api";
import { element } from "../dom";
import type { SelectionController } from "../selection-controller";
import type { StructureSummary } from "../types";

export interface StructureEditControllerOptions {
  selection: SelectionController;
  viewer: () => MolecularViewer;
  runViewerUpdate: (operation: () => Promise<void>) => Promise<void>;
  getSessionId: () => string | null;
  mutate: (path: string, body?: unknown) => Promise<void>;
  log: (message: string, level?: "info" | "error") => void;
}

export class StructureEditController {
  private readonly feedback = element<HTMLParagraphElement>("structure-edit-feedback");

  private charges: AtomCharge[] = [];
  private chargesVisible = false;
  private chargeSession: string | null = null;

  constructor(private readonly options: StructureEditControllerOptions) {}

  initializeBondTypes(bondTypes: string[]): void {
    const select = element<HTMLSelectElement>("bond-type");
    for (const name of bondTypes) select.add(new Option(name, name));
  }

  bind(): void {
    element("show-charges").addEventListener("click", () => {
      void this.options.runViewerUpdate(async () => {
        this.chargesVisible = !this.chargesVisible;
        try {
          await this.renderCharges();
        } catch (error) {
          this.chargesVisible = false;
          this.updateChargeToggle();
          throw error;
        }
      }).catch(error => this.options.log(`Charge labels failed: ${String(error)}`, "error"));
    });
    const phInput = element<HTMLInputElement>("protonation-ph");
    phInput.addEventListener("input", () => this.updateSelectionUi(this.options.getSessionId() !== null));
    element("protonate").addEventListener("click", async () => {
      if (!phInput.reportValidity() || phInput.value === "") return;
      element<HTMLButtonElement>("protonate").disabled = true;
      try {
        await this.options.mutate("/protonate", { ph: Number(phInput.value) });
      } finally {
        this.updateSelectionUi(this.options.getSessionId() !== null);
      }
    });
    const chargeInput = element<HTMLInputElement>("charge");
    const chargeAction = element<HTMLSelectElement>("charge-action");
    const updateChargeLabel = (): void => {
      element<HTMLButtonElement>("apply-charge").textContent =
        chargeAction.value === "delta" ? "Add charge delta" : "Set charge";
    };
    chargeAction.addEventListener("change", updateChargeLabel);
    updateChargeLabel();
    element("apply-charge").addEventListener("click", () => {
      const action = chargeAction.value;
      const charge = Number(chargeInput.value);
      this.feedback.textContent =
        `${action === "delta" ? "Adding" : "Setting"} charge ${charge} on `
        + `${this.options.selection.size} atom${this.options.selection.size === 1 ? "" : "s"}…`;
      void this.options.mutate("/charges", {
        atom_indices: [...this.options.selection.values],
        value: action === "value" ? charge : null,
        delta: action === "delta" ? charge : null,
      });
    });
    chargeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !element<HTMLButtonElement>("apply-charge").disabled) {
        element<HTMLButtonElement>("apply-charge").click();
      }
    });
    for (const action of ["add", "remove"] as const) {
      element(`${action}-bond`).addEventListener("click", () => {
        const [atom1, atom2] = [...this.options.selection.values];
        this.feedback.textContent =
          `${action === "add" ? "Adding" : "Removing"} bond ${atom1}–${atom2}…`;
        void this.options.mutate("/bonds", {
          atom1,
          atom2,
          action,
          bond_type: element<HTMLSelectElement>("bond-type").value,
        });
      });
    }
    element("delete-atoms").addEventListener("click", () => {
      void this.options.mutate("/delete", {
        atom_indices: [...this.options.selection.values],
        close_residue_gaps: element<HTMLInputElement>("close-residue-gaps").checked,
      });
    });
    element("reset-residues").addEventListener("click", () => {
      void this.options.mutate("/reset-residue-ids");
    });
    element("undo").addEventListener("click", () => void this.options.mutate("/undo"));
    element("segment-new-chain").addEventListener("change", () => {
      const checked = element<HTMLInputElement>("segment-new-chain").checked;
      element("segment-chain-options").hidden = !checked;
      element<HTMLInputElement>("segment-before").disabled = checked;
      this.updateSelectionUi(this.options.getSessionId() !== null);
    });
    element("insert-segment").addEventListener("click", () => {
      const newChain = element<HTMLInputElement>("segment-new-chain").checked;
      const chainId = element<HTMLInputElement>("segment-chain-id").value.trim();
      const before = element<HTMLInputElement>("segment-before").checked;
      // Match the native dialog: use the selection's boundary in structure order.
      const atoms = [...this.options.selection.values].sort((a, b) => a - b);
      if (!newChain && !atoms.length) return;
      void this.options.mutate("/segments", {
        minimum: Number(element<HTMLInputElement>("segment-min").value),
        maximum: Number(element<HTMLInputElement>("segment-max").value),
        atom_index: newChain ? null : before ? atoms[0] : atoms.at(-1),
        before,
        new_chain: newChain,
        chain_id: newChain && chainId ? chainId : null,
        chain_type: newChain ? element<HTMLSelectElement>("segment-chain-type").value : null,
      });
    });
    element("validate").addEventListener("click", () => void this.validate());
  }

  updateSelectionUi(hasSession: boolean): void {
    const count = this.options.selection.size;
    element<HTMLButtonElement>("show-charges").disabled = !hasSession;
    if (!hasSession) {
      this.chargesVisible = false;
      this.chargeSession = null;
      this.charges = [];
      this.updateChargeToggle();
    }
    const ph = element<HTMLInputElement>("protonation-ph");
    element<HTMLButtonElement>("protonate").disabled = !hasSession || ph.value === "" || !ph.validity.valid;
    element<HTMLButtonElement>("apply-charge").disabled = !hasSession || count === 0;
    element<HTMLButtonElement>("delete-atoms").disabled = !hasSession || count === 0;
    const newSegmentChain = element<HTMLInputElement>("segment-new-chain").checked;
    element<HTMLButtonElement>("insert-segment").disabled =
      !hasSession || (!newSegmentChain && count === 0);
    element<HTMLButtonElement>("add-bond").disabled = !hasSession || count !== 2;
    element<HTMLButtonElement>("remove-bond").disabled = !hasSession || count !== 2;
    this.feedback.textContent = !hasSession
      ? "Open a structure to begin."
      : `${count} atom${count === 1 ? "" : "s"} selected`;
  }

  async updateStructure(summary: StructureSummary | null): Promise<void> {
    const session = this.options.getSessionId();
    if (session !== this.chargeSession) this.chargesVisible = false;
    this.chargeSession = session;
    this.charges = (summary?.charged_atoms ?? []).map(atom => ({ atomIndex: atom.atom_index, charge: atom.charge }));
    await this.renderCharges();
  }

  private updateChargeToggle(): void {
    const button = element("show-charges");
    button.textContent = this.chargesVisible ? "Hide charges" : "Show charges";
    button.setAttribute("aria-pressed", String(this.chargesVisible));
  }

  private async renderCharges(): Promise<void> {
    await this.options.viewer().setCharges(this.chargesVisible ? this.charges : []);
    this.updateChargeToggle();
  }

  updateNextChainId(nextChainId: string): void {
    const input = element<HTMLInputElement>("segment-chain-id");
    if (!input.value || input.value === input.dataset.suggested) input.value = nextChainId;
    input.dataset.suggested = nextChainId;
  }

  private async validate(): Promise<void> {
    const sessionId = this.options.getSessionId();
    if (!sessionId) return;
    try {
      const result = await api<{ issues: StructureSummary["validation"] }>(
        `/api/sessions/${sessionId}/validate?full=true`,
        { method: "POST", timeoutMs: 150_000 },
      );
      this.options.log(
        result.issues.length
          ? result.issues.map((issue) => `${issue.check}: ${issue.message}`).join("\n")
          : "Validation passed.",
      );
    } catch (error) {
      this.options.log(`Validation failed: ${String(error)}`, "error");
    }
  }
}
