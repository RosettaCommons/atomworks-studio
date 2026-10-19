import type { SelectionScope } from "./types";
import type { MolecularViewer } from "./viewers";

export class SelectionController {
  private atoms = new Set<number>();
  private scope: SelectionScope = "atom";
  private generation = 0;
  private pendingSelection: Promise<unknown> = Promise.resolve();

  private readonly viewer: () => MolecularViewer | undefined;
  private readonly onChange: (atoms: ReadonlySet<number>, scope: SelectionScope) => void;

  constructor(
    viewer: () => MolecularViewer | undefined,
    onChange: (atoms: ReadonlySet<number>, scope: SelectionScope) => void,
  ) {
    this.viewer = viewer;
    this.onChange = onChange;
  }

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
    this.invalidatePending();
    this.scope = scope;
    this.notify(false);
  }

  replace(atomIndices: Iterable<number>, reveal = false): void {
    this.invalidatePending();
    this.atoms = new Set(atomIndices);
    this.notify(true, reveal);
  }

  toggle(atomIndices: Iterable<number>): boolean {
    this.invalidatePending();
    return this.commitToggle(atomIndices);
  }

  /** Resolve commands in order; Clear, replacement, and context changes cancel stale work. */
  applyResolved(action: "toggle" | "replace", resolve: () => Promise<Iterable<number>>): Promise<boolean | null> {
    if (action === "replace") this.invalidatePending();
    const generation = this.generation;
    const operation = this.pendingSelection.then(async () => {
      if (generation !== this.generation) return null;
      const indices = await resolve();
      if (generation !== this.generation) return null;
      if (action === "toggle") return this.commitToggle(indices);
      this.atoms = new Set(indices);
      this.notify(true, true);
      return false;
    });
    this.pendingSelection = operation.catch(() => undefined);
    return operation;
  }

  add(atomIndices: Iterable<number>, reveal = false): void {
    this.invalidatePending();
    for (const index of atomIndices) this.atoms.add(index);
    this.notify(true, reveal);
  }

  clear(): void {
    this.invalidatePending();
    this.atoms.clear();
    this.notify(true);
  }

  restore(): void {
    this.viewer()?.setSelection([...this.atoms]);
    this.notify(false);
  }

  retainValid(atomCount: number): void {
    this.invalidatePending();
    this.atoms = new Set([...this.atoms].filter((index) => index >= 0 && index < atomCount));
    this.notify(true);
  }

  private invalidatePending(): void {
    ++this.generation;
    this.pendingSelection = Promise.resolve();
  }

  private commitToggle(atomIndices: Iterable<number>): boolean {
    const indices = [...atomIndices];
    const remove = indices.length > 0 && indices.every((index) => this.atoms.has(index));
    for (const index of indices) {
      if (remove) this.atoms.delete(index);
      else this.atoms.add(index);
    }
    this.notify(true, true);
    return remove;
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
