import type { SelectionScope } from "./types";
import type { MolecularViewer } from "./viewers";

export class SelectionController {
  private atoms = new Set<number>();
  private scope: SelectionScope = "atom";

  constructor(
    private readonly viewer: () => MolecularViewer | undefined,
    private readonly onChange: (atoms: ReadonlySet<number>, scope: SelectionScope) => void,
  ) {}

  get values(): ReadonlySet<number> {
    return this.atoms;
  }

  get size(): number {
    return this.atoms.size;
  }

  get pickingScope(): SelectionScope {
    return this.scope;
  }

  setScope(scope: SelectionScope): void {
    this.scope = scope;
    this.notify(false);
  }

  replace(atomIndices: Iterable<number>, reveal = false): void {
    this.atoms = new Set(atomIndices);
    this.notify(true, reveal);
  }

  toggle(atomIndices: Iterable<number>): boolean {
    const indices = [...atomIndices];
    const remove = indices.length > 0 && indices.every((index) => this.atoms.has(index));
    for (const index of indices) {
      if (remove) this.atoms.delete(index);
      else this.atoms.add(index);
    }
    this.notify(true, true);
    return remove;
  }

  add(atomIndices: Iterable<number>, reveal = false): void {
    for (const index of atomIndices) this.atoms.add(index);
    this.notify(true, reveal);
  }

  clear(): void {
    this.atoms.clear();
    this.notify(true);
  }

  restore(): void {
    this.viewer()?.setSelection([...this.atoms]);
    this.notify(false);
  }

  retainValid(atomCount: number): void {
    this.atoms = new Set([...this.atoms].filter((index) => index >= 0 && index < atomCount));
    this.notify(true);
  }

  private notify(syncViewer: boolean, reveal = false): void {
    if (syncViewer) this.viewer()?.setSelection([...this.atoms]);
    this.onChange(this.atoms, this.scope);
    if (reveal) {
      document.querySelector(".sequence-token.selected")?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
  }
}
