import { element } from "../dom";
import type { SelectionController } from "../selection-controller";
import type { SequenceChain } from "../types";

export interface SequenceControllerOptions {
  selection: SelectionController;
  mutate: (path: string, body?: unknown) => Promise<void>;
  inspectAtom: (atomIndex: number) => Promise<void>;
}

export class SequenceController {
  private readonly dock = element<HTMLDivElement>("sequence-dock");
  private readonly view = element<HTMLDivElement>("sequence-view");
  private readonly toggle = element<HTMLButtonElement>("sequence-toggle");
  private anchor: number[] | null = null;
  private anchorOrder: number | null = null;
  private dragging = false;

  constructor(private readonly options: SequenceControllerOptions) {}

  bind(): void {
    this.toggle.addEventListener("click", () => {
      const hidden = !this.view.hidden;
      this.view.hidden = hidden;
      this.dock.classList.toggle("collapsed", hidden);
      this.toggle.textContent = hidden ? "Show sequence" : "Hide sequence";
      this.toggle.setAttribute("aria-expanded", String(!hidden));
    });
    element("sequence-realize").addEventListener("click", () => {
      void this.options.mutate("/segments/realize", {});
    });
    element("sequence-collapse").addEventListener("click", () => {
      void this.options.mutate("/segments/collapse");
    });
    document.addEventListener("pointerup", () => {
      this.dragging = false;
    });
  }

  syncSelection(scroll = false): void {
    let firstActive: HTMLElement | null = null;
    for (const token of this.view.querySelectorAll<HTMLButtonElement>(".sequence-token[data-atoms]")) {
      const atoms = (token.dataset.atoms ?? "").split(",").filter(Boolean).map(Number);
      const active = atoms.length > 0
        && atoms.every((index) => this.options.selection.values.has(index));
      token.classList.toggle("selected", active);
      if (active && firstActive === null) firstActive = token;
    }
    if (scroll) firstActive?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  render(chains: SequenceChain[]): void {
    this.view.replaceChildren();
    let hasCollapsed = false;
    let hasRealized = false;
    let sequenceOrder = 0;
    const selectResidue = (token: HTMLButtonElement, atoms: number[], toggle: boolean): void => {
      if (toggle) this.options.selection.toggle(atoms);
      else this.options.selection.replace(atoms);
      this.anchor = atoms;
      this.anchorOrder = Number(token.dataset.order);
      void this.options.inspectAtom(atoms[0]);
    };
    for (const chain of chains) {
      const row = document.createElement("div");
      row.className = "sequence-chain";
      const label = document.createElement("span");
      label.className = "sequence-chain-label";
      label.textContent = chain.chain_id;
      const track = document.createElement("div");
      track.className = "sequence-track";
      for (const item of chain.items) {
        const token = document.createElement("button");
        token.className = "sequence-token";
        if (item.kind === "segment") {
          hasCollapsed ||= !item.realized;
          hasRealized ||= item.realized;
          token.classList.add("sequence-segment");
          token.classList.toggle("realized", item.realized);
          token.textContent = item.realized
            ? `${item.realized_length ?? 0}×X`
            : `[${item.minimum}–${item.maximum}]`;
          token.title = item.realized
            ? `Realized expandable segment (${item.realized_length} residues); click to collapse all segments`
            : `Expandable segment (${item.minimum}-${item.maximum} residues); click to realize all segments`;
          token.addEventListener("click", () => {
            void this.options.mutate(
              item.realized ? "/segments/collapse" : "/segments/realize",
              item.realized ? undefined : {},
            );
          });
        } else {
          token.textContent = item.code.length === 1 ? item.code : "X";
          token.dataset.atoms = item.atom_indices.join(",");
          token.dataset.order = String(sequenceOrder++);
          token.title = `${chain.chain_id}/${item.residue_name} ${item.residue_id}`
            + (item.conditions.length ? ` · ${item.conditions.join(", ")}` : "")
            + " · drag, Shift-click range, Ctrl/⌘-click toggle";
          token.setAttribute(
            "aria-label",
            `${item.residue_name} ${item.residue_id} in chain ${chain.chain_id}`,
          );
          for (const condition of item.conditions) token.classList.add(`condition-${condition}`);
          token.addEventListener("pointerdown", (event) => {
            if (event.shiftKey) return;
            this.dragging = true;
            selectResidue(token, item.atom_indices, event.ctrlKey || event.metaKey);
          });
          token.addEventListener("pointerenter", (event) => {
            if (this.dragging && event.buttons === 1) selectResidue(token, item.atom_indices, true);
          });
          token.addEventListener("click", (event) => {
            if (event.shiftKey && this.anchorOrder !== null) {
              const current = Number(token.dataset.order);
              const low = Math.min(this.anchorOrder, current);
              const high = Math.max(this.anchorOrder, current);
              const rangeAtoms = [...track.querySelectorAll<HTMLButtonElement>("[data-order]")]
                .filter((candidate) => {
                  const order = Number(candidate.dataset.order);
                  return order >= low && order <= high;
                })
                .flatMap((candidate) =>
                  (candidate.dataset.atoms ?? "").split(",").filter(Boolean).map(Number)
                );
              this.options.selection.replace(rangeAtoms);
            } else if (!this.anchor?.every((index) => item.atom_indices.includes(index))) {
              selectResidue(token, item.atom_indices, event.ctrlKey || event.metaKey);
            }
          });
        }
        track.appendChild(token);
      }
      row.append(label, track);
      this.view.appendChild(row);
    }
    this.view.className = chains.length ? "sequence-view" : "sequence-view muted";
    if (!chains.length) this.view.textContent = "No polymer sequence is available.";
    element<HTMLButtonElement>("sequence-realize").disabled = !hasCollapsed;
    element<HTMLButtonElement>("sequence-collapse").disabled = !hasRealized;
    this.syncSelection();
  }
}
