import {
  PatinaeViewer,
  parseAtomSiteBooleanColumn,
  type AtomIdentity,
  type MeasurementInfo,
  type MeasurementRequest,
} from "@baker-laboratory/patinae-viewer";

import { documentAtomIndices, nativeAtomIndices } from "./atom-identity";
import { unpositionedAtomIndices } from "./unpositioned-atoms";
import {
  ANNOTATION_PALETTE,
  annotationRenderResult,
  normalizedAnnotationGroups,
  type AnnotationGroup,
  type AnnotationRenderResult,
  type ViewerAdapter,
  type ViewerAdapterContext,
  type ViewerCameraAction,
  type ViewerColor,
  type ViewerCommand,
  type ViewerMeasurement,
  type ViewerMeasurementRequest,
  type ViewerInteraction,
  type ViewerObject,
  type ViewerRepresentation,
  type ViewerRepresentationAction,
  type ViewerSelection,
  type ViewerStructure,
  type ViewerTarget,
  type ViewerMarker,
} from "./contract";

function flattenMeasurements(groups: MeasurementInfo[]): ViewerMeasurement[] {
  return groups.flatMap((group) => group.measurements.map((measurement) => ({
    id: group.name,
    label: measurement.label || group.name,
    kind: measurement.kind,
    value: measurement.value,
    unit: measurement.kind === "distance" ? " Å" : "°",
  })));
}

function rgba(color: number): [number, number, number, number] {
  return [
    ((color >> 16) & 0xff) / 255,
    ((color >> 8) & 0xff) / 255,
    (color & 0xff) / 255,
    1,
  ];
}

function compressIndices(indices: number[]): string {
  const ranges: string[] = [];
  for (let start = 0; start < indices.length;) {
    let stop = start;
    while (stop + 1 < indices.length && indices[stop + 1] === indices[stop] + 1) stop += 1;
    ranges.push(stop === start ? String(indices[start]) : `${indices[start]}-${indices[stop]}`);
    start = stop + 1;
  }
  return ranges.join("+");
}

export class PatinaeAdapter implements ViewerAdapter {
  readonly backend = "patinae" as const;
  readonly capabilities = {
    representations: true,
    colors: true,
    background: true,
    commands: true,
    picking: false,
    softwarePicking: false,
    selectionExpressions: false,
    selectionList: false,
    commandCatalog: false,
    measurements: false,
    interactionOverlays: false,
  };
  private viewer: PatinaeViewer | null = null;
  private atomIdentities: AtomIdentity[] = [];
  private cif: string | null = null;
  private markerNames: string[] = [];
  private interactionNames = new Set<string>();
  private name = "structure";
  private readonly displayCommands = [
    "hide everything",
    "show cartoon",
    "show sticks, not polymer",
  ];
  private colorCommands: string[] = [];
  private backgroundCommand = "bg_color black";

  constructor(private readonly context: ViewerAdapterContext) {}

  private async pickingSupported(): Promise<boolean> {
    const gpu = (
      navigator as Navigator & {
        gpu?: {
          requestAdapter(): Promise<{
            isFallbackAdapter?: boolean;
            info?: { isFallbackAdapter?: boolean };
          } | null>;
        };
      }
    ).gpu;
    const adapter = await gpu?.requestAdapter();
    return Boolean(adapter && !(adapter.isFallbackAdapter ?? adapter.info?.isFallbackAdapter));
  }

  async initialize(): Promise<void> {
    const picking = await this.pickingSupported();
    this.capabilities.picking = picking;
    this.capabilities.softwarePicking = !picking;
    this.context.container.dataset.picking = picking ? "enabled" : "software-disabled";
    this.viewer = new PatinaeViewer(this.context.container, {
      picking,
      selectionOverlay: picking,
      memoryProfile: "auto",
    });
    await this.viewer.init();
    this.capabilities.selectionExpressions = typeof this.viewer.evaluateSelection === "function";
    this.capabilities.selectionList = typeof this.viewer.getSelectionList === "function";
    this.capabilities.commandCatalog = typeof this.viewer.getCommandCatalog === "function";
    this.capabilities.measurements =
      typeof this.viewer.getMeasurementList === "function"
      && typeof this.viewer.addMeasurements === "function";
    this.capabilities.interactionOverlays = this.capabilities.measurements;
    if (picking) {
      this.viewer.on("atom-picked", (hit) => {
        if (hit.atom_index === null) return;
        const identity = this.atomIdentities.find(
          (atom) => atom.object_name === hit.object_name && atom.atom_index === hit.atom_index,
        );
        const documentIndex = identity?.document_index ?? hit.atom_index;
        this.context.onPick({
          atomIndex: documentIndex,
          label: `${hit.chain ?? "?"}/${hit.residue ?? "?"}: atom ${documentIndex}`,
        });
      });
    }
  }

  private nativeIndices(documentIndices: number[]): number[] {
    return nativeAtomIndices(this.atomIdentities, documentIndices);
  }

  private nativeSelection(documentIndices: number[]): string {
    return `index ${compressIndices(this.nativeIndices(documentIndices))}`;
  }

  private async renderCif(): Promise<void> {
    if (!this.viewer || this.cif === null) throw new Error("Patinae has no loaded structure");
    for (const objectName of this.viewer.getObjectNames()) this.viewer.execute(`delete ${objectName}`);
    const loaded = this.viewer.loadData(new TextEncoder().encode(this.cif), this.name, "cif");
    if ("Err" in loaded.result) throw new Error(loaded.result.Err);
    this.atomIdentities = this.viewer.getAtomIdentityMap?.() ?? [];
    await this.applyBaseStyle();
    this.viewer.execute("zoom all");
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.viewer.getObjectNames(); // Surface deferred WebGPU/render errors.
  }

  private async applyBaseStyle(): Promise<void> {
    if (!this.viewer || this.cif === null) return;
    for (const command of this.displayCommands) await this.executeCommand(command);
    await this.executeCommand("color atomic");
    for (const command of this.colorCommands) await this.executeCommand(command);
    this.viewer.execute(this.backgroundCommand);
    const coordinateRows = parseAtomSiteBooleanColumn(
      this.cif,
      "_atom_site.mask_coordinate_1_atom",
    );
    if (coordinateRows.length) {
      this.viewer.execute(`show sticks, ${this.nativeSelection(coordinateRows)}`);
    }
    const unpositioned = unpositionedAtomIndices(this.cif);
    if (unpositioned.length) this.viewer.execute(`hide everything, ${this.nativeSelection(unpositioned)}`);
  }

  async loadCif(cif: string, name: string): Promise<void> {
    this.cif = cif;
    this.name = name;
    await this.renderCif();
  }

  trajectoryFrameCount(): number {
    return this.viewer?.getMovieState().frame_count ?? 0;
  }

  async setTrajectoryFrame(index: number): Promise<void> {
    if (!this.viewer) throw new Error("Patinae is not initialized");
    await this.executeCommand(`frame ${index + 1}`);
  }

  async loadCifs(structures: ViewerStructure[]): Promise<void> {
    if (!this.viewer) throw new Error("Patinae is not initialized");
    for (const objectName of this.viewer.getObjectNames()) this.viewer.execute(`delete ${objectName}`);
    const loaded = structures.map((structure, index) => {
      const objectName = `compare_${index + 1}_${structure.name.replace(/[^A-Za-z0-9_]/g, "_")}`;
      const loaded = this.viewer!.loadData(new TextEncoder().encode(structure.cif), objectName, "cif");
      if ("Err" in loaded.result) throw new Error(loaded.result.Err);
      return { ...structure, objectName };
    });
    for (const command of this.displayCommands) await this.executeCommand(command);
    this.viewer.execute(this.backgroundCommand);
    this.atomIdentities = this.viewer.getAtomIdentityMap?.() ?? [];
    for (const [index, structure] of loaded.entries()) {
      const color = structure.color ?? (["cyan", "magenta", "orange", "green"][index % 4] as ViewerColor);
      this.viewer.execute(`color ${color}, ${structure.objectName}`);
      const coordinateRows = parseAtomSiteBooleanColumn(
        structure.cif,
        "_atom_site.mask_coordinate_1_atom",
      );
      const identities = this.atomIdentities.filter((atom) => atom.object_name === structure.objectName);
      const nativeRows = nativeAtomIndices(identities, coordinateRows);
      if (nativeRows.length) {
        this.viewer.execute(
          `show sticks, ${structure.objectName} and index ${compressIndices(nativeRows)}`,
        );
      }
      const unpositioned = nativeAtomIndices(identities, unpositionedAtomIndices(structure.cif));
      if (unpositioned.length) {
        this.viewer.execute(`hide everything, ${structure.objectName} and index ${compressIndices(unpositioned)}`);
      }
    }
    this.viewer.execute("zoom all");
    this.cif = null;
    this.name = "comparison";
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.viewer.getObjectNames();
  }

  async showAnnotation(groups: AnnotationGroup[]): Promise<AnnotationRenderResult> {
    if (!this.viewer) throw new Error("Patinae is not initialized");
    const unpositioned = unpositionedAtomIndices(this.cif ?? "");
    const excluded = new Set(unpositioned);
    const normalized = normalizedAnnotationGroups(groups.map(group => ({
      ...group, atomIndices: group.atomIndices.filter(index => !excluded.has(index)),
    })));
    await this.applyBaseStyle();
    for (const [index, group] of normalized.entries()) {
      const selection = this.nativeSelection(group.atomIndices);
      const selectedCount = this.viewer!.countAtoms(selection);
      if (selectedCount !== group.atomIndices.length) {
        throw new Error(
          `Patinae selected ${selectedCount} atoms for ${group.label}; ` +
            `AtomWorks reported ${group.atomIndices.length}.`,
        );
      }
      const color = group.color ?? ANNOTATION_PALETTE[index % ANNOTATION_PALETTE.length];
      await this.executeCommand(`color 0x${color.value.toString(16).padStart(6, "0")}, ${selection}`);
      if (group.showAtoms) await this.executeCommand(`show sticks, byres (${selection})`);
    }
    if (unpositioned.length) await this.executeCommand(`hide everything, ${this.nativeSelection(unpositioned)}`);
    return annotationRenderResult(normalized);
  }

  async clearAnnotation(): Promise<void> {
    if (this.cif !== null) await this.applyBaseStyle();
    else this.clearSelection();
  }

  async showMarkers(markers: ViewerMarker[]): Promise<void> {
    if (!this.viewer) return;
    this.viewer.removeMeasurements(this.markerNames);
    this.markerNames = [];
    const requests: MeasurementRequest[] = [];
    markers.forEach((marker, index) => {
      for (const axis of [0, 1, 2]) {
        const start: [number, number, number] = [...marker.position];
        const end: [number, number, number] = [...marker.position];
        start[axis] -= 0.6; end[axis] += 0.6;
        const name = `studio_centroid_${index}_${axis}`;
        this.markerNames.push(name);
        requests.push({ kind: "distance", name, points: [start, end],
          label: axis === 0 ? marker.label : "", color: rgba(marker.color) });
      }
    });
    if (requests.length) this.viewer.addMeasurements(requests);
  }

  setSelection(atomIndices: number[]): void {
    if (!this.viewer) return;
    const indices = [...new Set(atomIndices)].sort((left, right) => left - right);
    this.viewer.execute(indices.length
      ? `select sele, ${this.nativeSelection(indices)}`
      : "select sele, none");
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  async setRepresentation(
    representation: ViewerRepresentation,
    target: ViewerTarget,
    action: ViewerRepresentationAction,
  ): Promise<void> {
    if (!this.viewer) throw new Error("Patinae is not initialized");
    let selection = target === "selection" ? "sele" : "all";
    const unpositioned = this.cif ? unpositionedAtomIndices(this.cif) : [];
    if (unpositioned.length) selection = `(${selection}) and not (${this.nativeSelection(unpositioned)})`;
    await this.executeCommand(`${action === "replace" ? "as" : action} ${representation}, ${selection}`);
  }

  setColor(color: ViewerColor, target: ViewerTarget): void {
    if (!this.viewer) return;
    const command = `color ${color}, ${target === "selection" ? "sele" : "all"}`;
    this.colorCommands.push(command);
    this.viewer.execute(command);
  }

  setBackground(color: "black" | "white"): void {
    if (!this.viewer) return;
    this.backgroundCommand = `bg_color ${color}`;
    this.viewer.execute(this.backgroundCommand);
  }

  camera(action: ViewerCameraAction): void {
    if (!this.viewer) return;
    const command = action === "zoom" ? "zoom all" : action;
    this.viewer.execute(command);
  }

  async executeCommand(command: string): Promise<unknown> {
    if (!this.viewer) throw new Error("Patinae is not initialized");
    const reply = await this.viewer.execute(command);
    for (const id of reply.task_ids) {
      const task = await this.viewer.tasks.wait(id, 30_000);
      if (task.state !== "succeeded") throw new Error(`Patinae task ${id}: ${task.state}`);
    }
    if ("Err" in reply.result) throw new Error(reply.result.Err);
    return { messages: reply.messages.map(message => ({
      level: message.kind.toLowerCase(), text: message.text,
    })) };
  }

  evaluateSelection(expression: string): number[] {
    if (!this.viewer?.evaluateSelection) throw new Error("This Patinae build cannot evaluate selections.");
    const result = this.viewer.evaluateSelection(expression);
    return documentAtomIndices(this.atomIdentities, result);
  }

  getObjectList(): ViewerObject[] {
    return this.viewer?.getObjectInfos().filter(object => !object.name.startsWith("_studio_")).map((object) => ({
      name: object.name,
      type: object.object_type,
      atomCount: object.atom_count,
      enabled: object.enabled,
    })) ?? [];
  }

  setObjectEnabled(name: string, enabled: boolean): void {
    if (!this.viewer) return;
    this.viewer.execute(`${enabled ? "enable" : "disable"} ${name}`);
  }

  getSelectionList(): ViewerSelection[] {
    return this.viewer?.getSelectionList?.() ?? [];
  }

  getCommandCatalog(): ViewerCommand[] {
    return this.viewer?.getCommandCatalog?.().map((command) => ({
      name: command.name,
      aliases: command.aliases,
      description: command.description,
      usage: command.usage,
      help: command.help,
      webSafe: command.web_safe,
      unavailableReason: command.unavailable_reason,
    })) ?? [];
  }

  listMeasurements(): ViewerMeasurement[] {
    return flattenMeasurements((this.viewer?.getMeasurementList?.() ?? [])
      .filter((measurement) => !this.markerNames.includes(measurement.name) && !this.interactionNames.has(measurement.name)));
  }

  async addMeasurement(request: ViewerMeasurementRequest): Promise<ViewerMeasurement[]> {
    if (!this.viewer?.addMeasurements) {
      throw new Error("This Patinae build does not support measurements.");
    }
    const required = request.kind === "distance" ? 2 : request.kind === "angle" ? 3 : 4;
    if (request.atomIndices.length !== required) {
      throw new Error(`Select exactly ${required} atoms for a ${request.kind} measurement.`);
    }
    const name = request.label?.replace(/[^A-Za-z0-9_-]/g, "_") || `${request.kind}_${Date.now()}`;
    const selections = request.atomIndices.map((index) => this.nativeSelection([index]));
    const base = {
      name,
      color: rgba(request.color ?? 0xffd54f),
      label: request.label,
    };
    const measurement: MeasurementRequest = request.kind === "distance"
      ? { ...base, kind: "distance", selections: [selections[0], selections[1]] }
      : request.kind === "angle"
        ? { ...base, kind: "angle", selections: [selections[0], selections[1], selections[2]] }
        : {
            ...base,
            kind: "dihedral",
            selections: [selections[0], selections[1], selections[2], selections[3]],
          };
    return flattenMeasurements(this.viewer.addMeasurements([measurement]));
  }

  async clearMeasurements(): Promise<void> {
    const names = (this.viewer?.getMeasurementList?.() ?? [])
      .filter(measurement => !this.interactionNames.has(measurement.name) && !this.markerNames.includes(measurement.name))
      .map(measurement => measurement.name);
    if (names.length) this.viewer?.removeMeasurements?.(names);
  }

  async showInteractions(interactions: ViewerInteraction[]): Promise<void> {
    if (!this.viewer?.addMeasurements) {
      if (!interactions.length) return;
      throw new Error("This Patinae build does not support interaction overlays.");
    }
    if (this.interactionNames.size) this.viewer.removeMeasurements?.([...this.interactionNames]);
    this.interactionNames = new Set(interactions.map(interaction => interaction.id));
    if (interactions.length) {
      this.viewer.addMeasurements(interactions.map((interaction) => ({
        kind: "distance",
        name: interaction.id,
        selections: [
          this.nativeSelection([interaction.atom1]),
          this.nativeSelection([interaction.atom2]),
        ],
        color: rgba(interaction.color),
        label: interaction.label,
      })));
    }
  }

  destroy(): void {
    this.viewer?.destroy();
    this.viewer = null;
    this.interactionNames.clear();
    this.atomIdentities = [];
    this.cif = null;
  }
}

export function createPatinaeAdapter(context: ViewerAdapterContext): ViewerAdapter {
  return new PatinaeAdapter(context);
}
