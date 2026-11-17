import {
  PatinaeViewer,
  parseAtomSiteBooleanColumn,
  type AtomIdentity,
  type MeasurementInfo,
  type MeasurementRequest,
} from "@baker-laboratory/patinae-viewer";

import { documentAtomIndices, nativeAtomIndices } from "./atom-identity";
import { carbonIndicesByChain, unpositionedAtomIndices } from "./unpositioned-atoms";
import { chainColor } from "../chain-colors";
import {
  ANNOTATION_CONTEXT_COLOR,
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
  type ViewerLoadOptions,
  type ViewerObject,
  type ViewerRepresentation,
  type ViewerRepresentationAction,
  type ViewerSelection,
  type ViewerStructure,
  type ViewerTarget,
  type ViewerMarker,
  type AtomCharge,
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

/**
 * The base style Patinae needs after a load, as plain commands. Frames of one design differ only in coordinates,
 * so the same plan serves every frame of a stream and the CIF is parsed once instead of once per frame.
 */
type StylePlan = {
  signature: string;
  /** Commands whose tasks the normal path waits for, in order. */
  awaited: string[];
  /** Commands the normal path issues without waiting, because the next rendered frame applies them anyway. */
  immediate: string[];
};

/** Where a live frame parks the camera across the reload. Named so it cannot collide with a user's own view. */
const LIVE_VIEW_KEY = "_studio_live";

/** The next animation frame, or a short timeout where frames are not running at all (a hidden tab). */
function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(done, 100);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      done();
    });
  });
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
  private pickingEnabled = false;
  private selectionOverlayEnabled = false;
  private liveMode = false;
  /** What picking and the overlay were set to when the stream began, so `setLiveMode(false)` puts them back. */
  private savedLiveLook: { picking: boolean; selectionOverlay: boolean } | null = null;
  private stylePlan: StylePlan | null = null;
  /** A command failure a live frame did not wait for, held until a call into the viewer can throw it. */
  private pendingRenderError: string | null = null;
  /** Tasks from frames that were issued without waiting, drained once the stream ends. */
  private pendingTaskIds: string[] = [];

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
    this.pickingEnabled = picking;
    this.selectionOverlayEnabled = picking;
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

  /** Replace the object with the current CIF and report what it loaded. Shared by the normal and the live path. */
  private reloadObject(): void {
    if (!this.viewer || this.cif === null) throw new Error("Patinae has no loaded structure");
    for (const objectName of this.viewer.getObjectNames()) this.viewer.execute(`delete ${objectName}`);
    const loaded = this.viewer.loadData(new TextEncoder().encode(this.cif), this.name, "cif");
    if ("Err" in loaded.result) throw new Error(loaded.result.Err);
    this.atomIdentities = this.viewer.getAtomIdentityMap?.() ?? [];
  }

  private async renderCif(options?: ViewerLoadOptions): Promise<void> {
    if (!this.viewer) throw new Error("Patinae is not initialized");
    this.reloadObject();
    await this.applyBaseStyle();
    if (!options?.keepCamera) this.viewer.execute("zoom all");
    await this.surfaceRenderErrors();
  }

  /**
   * Patinae records a renderer failure inside its own animation loop, where nothing is waiting for it; the next
   * `getObjectNames` then rethrows it. So a failed frame has to have run before the check means anything, which is
   * what the fixed 250 ms sleep here used to guess at. Waiting for the frames themselves is both quicker and exact.
   * `tasks.wait` cannot stand in: `loadData` parses synchronously and creates no task, and the failure belongs to
   * the render rather than to any command.
   */
  private async surfaceRenderErrors(): Promise<void> {
    if (!this.viewer) return;
    // One tick to let the pending frame run, a second so a failure in it has been recorded.
    await nextAnimationFrame();
    await nextAnimationFrame();
    this.viewer.getObjectNames();
    this.throwPendingRenderError();
  }

  /** Report a renderer failure the animation loop picked up while nothing was waiting for it. */
  private throwPendingRenderError(): void {
    const error = this.pendingRenderError;
    if (error === null) return;
    this.pendingRenderError = null;
    throw new Error(error);
  }

  /**
   * What the base style is computed from: the atoms and chains in play, and the styling the user has chosen. Frames
   * of one design carry the same atoms in the same order and differ only in their coordinates, so this holds still
   * across a stream and changes the moment anything the commands depend on does.
   */
  private structureSignature(): string {
    const atoms = this.atomIdentities
      .map((atom) => `${atom.object_name}/${atom.atom_index}/${atom.chain_id}/${atom.element}`)
      .join("|");
    return [atoms, this.displayCommands.join(";"), this.colorCommands.join(";"), this.backgroundCommand].join("\n");
  }

  /**
   * The base-style commands for the loaded structure. Pure: it issues nothing, so the CIF scans behind it happen
   * once per structure rather than once per frame.
   *
   * Carbons are coloured by chain from the shared palette, so chains read the same here, in the sequence bar and in
   * Mol*. Mol* does this with a colour theme; Patinae takes commands, so the same palette is applied per chain.
   */
  private buildStylePlan(): StylePlan {
    const awaited = [...this.displayCommands, "color atomic"];
    const immediate: string[] = [];
    if (this.cif !== null) {
      for (const [chain, indices] of carbonIndicesByChain(this.cif)) {
        const hex = chainColor(chain).toString(16).padStart(6, "0");
        awaited.push(`color 0x${hex}, ${this.nativeSelection(indices)}`);
      }
      awaited.push(...this.colorCommands);
      immediate.push(this.backgroundCommand);
      const coordinateRows = parseAtomSiteBooleanColumn(
        this.cif,
        "_atom_site.mask_coordinate_1_atom",
      );
      if (coordinateRows.length) immediate.push(`show sticks, ${this.nativeSelection(coordinateRows)}`);
      const unpositioned = unpositionedAtomIndices(this.cif);
      if (unpositioned.length) immediate.push(`hide everything, ${this.nativeSelection(unpositioned)}`);
    }
    return { signature: this.structureSignature(), awaited, immediate };
  }

  private async applyBaseStyle(): Promise<void> {
    if (!this.viewer || this.cif === null) return;
    const plan = this.buildStylePlan();
    this.stylePlan = plan;
    await this.runStylePlan(plan);
  }

  private async runStylePlan(plan: StylePlan): Promise<void> {
    if (!this.viewer) return;
    for (const command of plan.awaited) await this.executeCommand(command);
    for (const command of plan.immediate) this.viewer.execute(command);
  }

  /**
   * Re-issue a known-good plan without waiting on it command by command. Each round trip into the viewer costs a
   * frame of its own, and during a stream the next frame is along shortly. A failure still reaches us: the
   * command's own result is checked as it arrives, its task is waited on when the stream ends, and a renderer
   * failure sets the flag that the next `getObjectNames` rethrows.
   */
  private replayStylePlan(plan: StylePlan): void {
    if (!this.viewer) return;
    for (const command of [...plan.awaited, ...plan.immediate]) {
      void this.viewer.execute(command).then(
        (reply) => {
          this.pendingTaskIds.push(...reply.task_ids);
          if ("Err" in reply.result) this.pendingRenderError ??= reply.result.Err;
        },
        (error: unknown) => {
          this.pendingRenderError ??= error instanceof Error ? error.message : String(error);
        },
      );
    }
  }

  /**
   * Wait on the work the stream issued but never waited for, so a failure it ran past still becomes an error the
   * next viewer call reports rather than one that is lost with the stream.
   */
  private async drainPendingTasks(): Promise<void> {
    const viewer = this.viewer;
    const ids = this.pendingTaskIds;
    this.pendingTaskIds = [];
    if (!viewer) return;
    for (const id of ids) {
      try {
        const task = await viewer.tasks.wait(id, 30_000);
        if (task.state !== "succeeded") this.pendingRenderError ??= `Patinae task ${id}: ${task.state}`;
      } catch (error) {
        this.pendingRenderError ??= error instanceof Error ? error.message : String(error);
      }
    }
  }

  async loadCif(cif: string, name: string, options?: ViewerLoadOptions): Promise<void> {
    this.throwPendingRenderError();
    this.cif = cif;
    this.name = name;
    await this.renderCif(options);
  }

  /**
   * See `ViewerAdapter.updateLiveCif`. Patinae has no in-place data update — its facade can only load a structure —
   * so this is a rebuild, not the swap Mol* does. It is made cheap instead: the camera stays where the viewer put
   * it, the base style is replayed from the plan computed for the first frame while the structure's shape holds,
   * and nothing waits on a fixed settle.
   */
  async updateLiveCif(cif: string, name: string, options?: ViewerLoadOptions): Promise<void> {
    if (!this.viewer) throw new Error("Patinae is not initialized");
    this.throwPendingRenderError();
    this.cif = cif;
    this.name = name;
    const keepCamera = options?.keepCamera ?? false;
    // Patinae has no in-place update, and loading re-centres the view on whatever came in — so without this a
    // stream drags the camera along with the structure's centre even though nothing asked it to move. `view`
    // stores the whole camera state, origin and clipping and FOV included, under a name. Both halves are awaited:
    // `loadData` parses synchronously and would otherwise overtake a command still sitting in the queue.
    if (keepCamera) await this.executeCommand(`view ${LIVE_VIEW_KEY}, store`);
    this.reloadObject();
    if (keepCamera) await this.executeCommand(`view ${LIVE_VIEW_KEY}, recall`);
    const plan = this.stylePlan;
    const reused = plan !== null && plan.signature === this.structureSignature();
    if (!reused) await this.applyBaseStyle();
    else if (this.liveMode) this.replayStylePlan(plan);
    else await this.runStylePlan(plan);
    if (!keepCamera) this.viewer.execute("zoom all");
    const dataset = this.context.container.dataset;
    // Frames served by the live path. For Patinae these are cheap rebuilds, not in-place updates.
    dataset.liveUpdates = String(Number(dataset.liveUpdates ?? 0) + 1);
    dataset.liveStyleReplays = String(Number(dataset.liveStyleReplays ?? 0) + (reused ? 1 : 0));
    // Cheap and synchronous: it rethrows a failure the animation loop recorded while the stream ran past it.
    // `reloadObject` makes the same check at the top of the next frame, and `setLiveMode(false)` makes the full
    // one, so a renderer error in the last frame of a stream is not lost either.
    this.viewer.getObjectNames();
    this.throwPendingRenderError();
  }

  /**
   * See `ViewerAdapter.setLiveMode`. Patinae rebuilds its object for every frame, so the levers are the work around
   * that rebuild: picking and the selection overlay each cost a pass per frame and nothing can usefully be clicked
   * while frames are replacing each other, and style commands need not be waited on one at a time. Both go back
   * exactly as they were, and the work the stream skipped waiting for is drained once it ends.
   */
  setLiveMode(on: boolean): void {
    if (!this.viewer) return;
    if (on) {
      this.liveMode = true;
      if (this.savedLiveLook) return;
      this.savedLiveLook = {
        picking: this.pickingEnabled,
        selectionOverlay: this.selectionOverlayEnabled,
      };
      this.viewer.setPicking(false);
      this.viewer.setSelectionOverlay(false);
      return;
    }
    this.liveMode = false;
    if (this.savedLiveLook) {
      this.viewer.setPicking(this.savedLiveLook.picking);
      this.viewer.setSelectionOverlay(this.savedLiveLook.selectionOverlay);
      this.savedLiveLook = null;
    }
    this.viewer.execute(`view ${LIVE_VIEW_KEY}, clear`);
    // The stream waited for none of this; surface now what it ran past.
    void this.drainPendingTasks().then(() => this.surfaceRenderErrors()).catch((error: unknown) => {
      this.pendingRenderError ??= error instanceof Error ? error.message : String(error);
    });
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
    this.stylePlan = null;
    await this.surfaceRenderErrors();
  }

  async showAnnotation(groups: AnnotationGroup[]): Promise<AnnotationRenderResult> {
    if (!this.viewer) throw new Error("Patinae is not initialized");
    const unpositioned = unpositionedAtomIndices(this.cif ?? "");
    const excluded = new Set(unpositioned);
    const normalized = normalizedAnnotationGroups(groups.map(group => ({
      ...group, atomIndices: group.atomIndices.filter(index => !excluded.has(index)),
    })));
    await this.applyBaseStyle();
    if (normalized.some(group => group.dimUnhighlighted)) {
      await this.executeCommand(`color 0x${ANNOTATION_CONTEXT_COLOR.toString(16)}, all`);
    }
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

  async showCharges(charges: AtomCharge[]): Promise<void> {
    if (!this.viewer) return;
    const name = "_studio_formal_charges";
    if (this.viewer.getObjectNames().includes(name)) await this.executeCommand(`delete ${name}`);
    this.context.container.dataset.chargeLabels = "0";
    if (this.cif === null) return;
    const hidden = new Set(unpositionedAtomIndices(this.cif));
    const available = new Set(this.atomIdentities.map(atom => atom.document_index));
    const groups = new Map<number, number[]>();
    for (const atom of charges) {
      if (!atom.charge || hidden.has(atom.atomIndex) || !available.has(atom.atomIndex)) continue;
      const indices = groups.get(atom.charge) ?? [];
      indices.push(atom.atomIndex);
      groups.set(atom.charge, indices);
    }
    for (const [charge, indices] of groups) {
      const text = charge > 0 ? `+${charge}` : String(charge);
      await this.executeCommand(`label ${this.nativeSelection(indices)}, "${text}", object=${name}`);
    }
    this.context.container.dataset.chargeLabels = String([...groups.values()].reduce((sum, indices) => sum + indices.length, 0));
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
    this.stylePlan = null;
    this.savedLiveLook = null;
    this.liveMode = false;
    this.pendingRenderError = null;
    this.pendingTaskIds = [];
  }
}

export function createPatinaeAdapter(context: ViewerAdapterContext): ViewerAdapter {
  return new PatinaeAdapter(context);
}
