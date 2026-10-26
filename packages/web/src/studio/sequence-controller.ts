import { element } from "../dom";
import type { SelectionController } from "../selection-controller";
import type { SequenceChain } from "../types";
import { chainColorCss } from "../chain-colors";
import { sequenceRangeSelection } from "./sequence-selection";

export interface SequenceControllerOptions {
  selection: SelectionController;
  inspectAtom: (atomIndex: number) => Promise<void>;
}

export class SequenceController {
  private readonly dock = element<HTMLDivElement>("sequence-dock");
  private readonly view = element<HTMLDivElement>("sequence-view");
  private readonly toggle = element<HTMLButtonElement>("sequence-toggle");
  private anchorOrder: number | null = null;
  private residues: { token: HTMLElement; atoms: number[] }[] = [];
  private drag: {
    pointerId: number;
    start: number;
    end: number;
    baseline: ReadonlySet<number>;
    remove: boolean;
  } | null = null;

  constructor(private readonly options: SequenceControllerOptions) {}

  bind(): void {
    this.toggle.addEventListener("click", () => {
      const hidden = !this.view.hidden;
      this.view.hidden = hidden;
      this.dock.classList.toggle("collapsed", hidden);
      this.toggle.textContent = hidden ? "Show sequence" : "Hide sequence";
      this.toggle.setAttribute("aria-expanded", String(!hidden));
    });
    this.view.addEventListener("pointermove", (event) => {
      if (event.pointerId !== this.drag?.pointerId) return;
      if (!(event.buttons & 1)) {
        this.endDrag();
        return;
      }
      this.extendDrag(event);
    });
    this.view.addEventListener("pointerup", (event) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this.extendDrag(event);
      this.endDrag();
      const atom = this.residues[drag.end].atoms[0];
      if (atom !== undefined) void this.options.inspectAtom(atom);
    });
    this.view.addEventListener("pointercancel", () => this.endDrag());
    this.view.addEventListener("lostpointercapture", () => this.endDrag());
    window.addEventListener("blur", () => this.endDrag());
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.view.hasPointerCapture(drag.pointerId)) {
      this.view.releasePointerCapture(drag.pointerId);
    }
  }

  private extendDrag(event: PointerEvent): void {
    const token = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".sequence-token[data-order]");
    if (!this.drag || !token || !this.view.contains(token)) return;
    const end = Number(token.dataset.order);
    if (end === this.drag.end) return;
    this.drag.end = end;
    this.applyRange(this.drag.start, end, this.drag.baseline, this.drag.remove);
  }

  private applyRange(start: number, end: number, baseline: ReadonlySet<number>, remove: boolean): void {
    this.options.selection.replace(sequenceRangeSelection(this.residues, start, end, baseline, remove));
  }

  syncSelection(scroll = false): void {
    let firstActive: HTMLElement | null = null;
    for (const { token, atoms } of this.residues) {
      const selected = atoms.filter((index) => this.options.selection.values.has(index)).length;
      const active = atoms.length > 0 && selected === atoms.length;
      const partial = selected > 0 && !active;
      token.classList.toggle("selected", active);
      token.classList.toggle("partially-selected", partial);
      token.setAttribute("aria-pressed", partial ? "mixed" : String(active));
      if (active && firstActive === null) firstActive = token;
    }
    if (scroll) firstActive?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  render(chains: SequenceChain[]): void {
    this.endDrag();
    this.anchorOrder = null;
    this.residues = [];
    this.view.replaceChildren();
    for (const chain of chains) {
      const row = document.createElement("div");
      row.className = "sequence-chain";
      const label = document.createElement("span");
      label.className = "sequence-chain-label";
      label.textContent = chain.chain_id;
      // The chain's colour, as in the viewer.
      row.style.setProperty("--chain-color", chainColorCss(chain.chain_id));
      const track = document.createElement("div");
      track.className = "sequence-track";
      for (const item of chain.items) {
        const token: HTMLElement = document.createElement(item.kind === "segment" ? "span" : "button");
        token.className = "sequence-token";
        if (item.kind === "segment") {
          token.classList.add("sequence-segment");
          token.classList.toggle("realized", item.realized);
          token.textContent = item.realized
            ? `${item.realized_length ?? 0}×X`
            : `[${item.minimum}–${item.maximum}]`;
          token.title = item.realized
            ? `Realized expandable segment (${item.realized_length} residues)`
            : `Expandable segment (${item.minimum}-${item.maximum} residues)`;
        } else {
          token.textContent = item.code.length === 1 ? item.code : "X";
          token.dataset.atoms = item.atom_indices.join(",");
          const order = this.residues.length;
          this.residues.push({ token, atoms: item.atom_indices });
          token.dataset.order = String(order);
          token.title = `${chain.chain_id}/${item.residue_name} ${item.residue_id}`
            + (item.conditions.length ? ` · ${item.conditions.join(", ")}` : "")
            + " · click to toggle, drag, Shift-click range";
          token.setAttribute(
            "aria-label",
            `${item.residue_name} ${item.residue_id} in chain ${chain.chain_id}`,
          );
          for (const condition of item.conditions) token.classList.add(`condition-${condition}`);
          token.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || !event.isPrimary || !item.atom_indices.length) return;
            event.preventDefault();
            token.focus({ preventScroll: true });
            const range = event.shiftKey && this.anchorOrder !== null;
            const start = range ? this.anchorOrder ?? order : order;
            this.anchorOrder = start;
            this.drag = {
              pointerId: event.pointerId, start, end: order,
              baseline: range ? new Set() : new Set(this.options.selection.values),
              remove: !range && item.atom_indices.every((index) => this.options.selection.values.has(index)),
            };
            this.view.setPointerCapture(event.pointerId);
            this.applyRange(start, order, this.drag.baseline, this.drag.remove);
          });
          token.addEventListener("click", (event) => {
            // Pointer gestures are handled above; native keyboard activation still toggles.
            if (event.detail !== 0 || !item.atom_indices.length) return;
            if (event.shiftKey && this.anchorOrder !== null) {
              this.applyRange(this.anchorOrder, order, new Set(), false);
            } else {
              this.options.selection.toggle(item.atom_indices);
              this.anchorOrder = order;
            }
            void this.options.inspectAtom(item.atom_indices[0]);
          });
        }
        track.appendChild(token);
      }
      row.append(label, track);
      this.view.appendChild(row);
    }
    this.view.className = chains.length ? "sequence-view" : "sequence-view muted";
    if (!chains.length) this.view.textContent = "No polymer sequence is available.";
    this.syncSelection();
  }
}
