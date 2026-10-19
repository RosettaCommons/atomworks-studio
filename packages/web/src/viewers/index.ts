import type {
  AnnotationGroup,
  AtomPick,
  AnnotationRenderResult,
  ViewerAdapter,
  ViewerAdapterContext,
  ViewerBackend,
  ViewerCameraAction,
  ViewerColor,
  ViewerMode,
  ViewerObject,
  ViewerRepresentation,
  ViewerRepresentationAction,
  ViewerCommand,
  ViewerMeasurement,
  ViewerMeasurementRequest,
  ViewerInteraction,
  ViewerSelection,
  ViewerStructure,
  ViewerTarget,
  ViewerMarker,
} from "./contract";
import {
  normalizeViewerMeasurementRequest,
  replayViewerTransientVisuals,
} from "./contract";

export type {
  AnnotationGroup,
  AtomPick,
  ViewerBackend,
  ViewerCameraAction,
  ViewerColor,
  ViewerMode,
  ViewerObject,
  ViewerRepresentation,
  ViewerRepresentationAction,
  ViewerCommand,
  ViewerMeasurement,
  ViewerMeasurementRequest,
  ViewerInteraction,
  ViewerSelection,
  ViewerStructure,
  ViewerTarget,
} from "./contract";

const BACKEND_LABELS: Record<ViewerBackend, string> = {
  molstar: "Mol* · WebGL",
  patinae: "Patinae · WebGPU",
};

async function createAdapter(
  backend: ViewerBackend,
  context: ViewerAdapterContext,
): Promise<ViewerAdapter> {
  if (backend === "molstar") {
    const { createMolstarAdapter } = await import("./molstar");
    return createMolstarAdapter(context);
  }
  const { createPatinaeAdapter } = await import("./patinae");
  return createPatinaeAdapter(context);
}

export class MolecularViewer {
  private adapter: ViewerAdapter | null = null;
  private structures: ViewerStructure[] = [];
  private selectedAtomIndices: number[] = [];
  private annotationGroups: AnnotationGroup[] = [];
  private interactionOverlays: ViewerInteraction[] = [];
  private measurementRequests: ViewerMeasurementRequest[] = [];
  private markers: ViewerMarker[] = [];
  // Capture atom indices when a style is applied, not the later contents of "sele".
  private representations: {
    representation: ViewerRepresentation;
    target: ViewerTarget;
    action: ViewerRepresentationAction;
    atomIndices: number[];
  }[] = [];

  private async replayRepresentations(): Promise<void> {
    if (!this.representations.length) return;
    for (const operation of this.representations) {
      this.adapter?.setSelection(operation.atomIndices);
      await this.adapter?.setRepresentation?.(operation.representation, operation.target, operation.action);
    }
    this.adapter?.setSelection(this.selectedAtomIndices);
  }

  constructor(
    private readonly container: HTMLElement,
    private readonly backendLabel: HTMLElement,
    private mode: ViewerMode,
    private readonly onPick: (pick: AtomPick) => void,
    private readonly onRenderError: (error: unknown) => void = (error) => { throw error; },
  ) {}

  get backend(): ViewerBackend {
    if (!this.adapter) throw new Error("Molecular viewer is not initialized");
    return this.adapter.backend;
  }

  get initialized(): boolean {
    return this.adapter !== null;
  }

  get capabilities() {
    if (!this.adapter) throw new Error("Molecular viewer is not initialized");
    return this.adapter.capabilities;
  }

  private updateAnnotationDiagnostics(result?: AnnotationRenderResult): void {
    this.container.dataset.annotationAtoms = String(result?.atomCount ?? 0);
    this.container.dataset.annotationGroups = String(result?.groupCount ?? 0);
  }

  private async activate(backend: ViewerBackend): Promise<void> {
    try {
      this.adapter?.destroy();
    } catch {
      // A failed GPU context can reject cleanup.
    }
    this.adapter = null;
    this.container.replaceChildren();
    this.updateAnnotationDiagnostics();
    const adapter = await createAdapter(backend, {
      container: this.container,
      onPick: (pick) => this.onPick(pick),
    });
    try {
      await adapter.initialize();
    } catch (error) {
      try {
        adapter.destroy();
      } catch {
        // Preserve the initialization error.
      }
      throw error;
    }
    this.adapter = adapter;
    this.container.dataset.backend = backend;
    const softwarePicking =
      backend === "patinae" && this.container.dataset.picking === "software-disabled";
    this.backendLabel.textContent =
      BACKEND_LABELS[backend] + (softwarePicking ? " · software WebGPU (canvas picking off)" : "");
  }

  private async replayTransientVisuals(): Promise<void> {
    if (!this.adapter) return;
    await replayViewerTransientVisuals(this.adapter, {
      interactionOverlays: this.interactionOverlays,
      measurementRequests: this.measurementRequests,
    });
    await this.adapter.showMarkers?.(this.markers);
  }

  async initialize(): Promise<void> {
    await this.activate(this.mode);
  }

  async switchBackend(mode: ViewerMode): Promise<void> {
    if (this.adapter?.backend === mode) return;
    this.mode = mode;
    await this.activate(mode);
    if (this.structures.length) {
      if (this.structures.length === 1) {
        const [structure] = this.structures;
        await this.adapter?.loadCif(structure.cif, structure.name);
      } else {
        await this.adapter?.loadCifs(this.structures);
      }
      if (this.structures.length === 1 && this.annotationGroups.length) {
        this.updateAnnotationDiagnostics(await this.adapter?.showAnnotation(this.annotationGroups));
      }
      await this.replayRepresentations();
      await this.replayTransientVisuals();
      this.adapter?.setSelection(this.selectedAtomIndices);
    }
  }

  async loadCif(cif: string, name: string): Promise<void> {
    this.structures = [{ cif, name }];
    this.container.dataset.comparisonStructures = "0";
    this.updateAnnotationDiagnostics();
    await this.adapter?.loadCif(cif, name);
    await this.replayRepresentations();
    await this.replayTransientVisuals();
  }

  get trajectoryFrameCount(): number {
    return this.adapter?.trajectoryFrameCount?.() ?? 0;
  }

  async setTrajectoryFrame(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index >= this.trajectoryFrameCount) {
      throw new Error("Trajectory frame is out of range");
    }
    await this.adapter?.setTrajectoryFrame?.(index);
    this.container.dataset.trajectoryFrame = String(index);
  }

  async loadCifs(structures: ViewerStructure[]): Promise<void> {
    this.representations = [];
    this.structures = structures.map((structure) => ({ ...structure }));
    this.annotationGroups = [];
    this.selectedAtomIndices = [];
    this.interactionOverlays = [];
    this.measurementRequests = [];
    this.updateAnnotationDiagnostics();
    await this.setMarkers([]);
    await this.adapter?.loadCifs(this.structures);
    this.container.dataset.comparisonStructures = String(this.structures.length);
  }

  clearSelection(): void {
    this.selectedAtomIndices = [];
    this.adapter?.clearSelection();
  }

  setSelection(atomIndices: number[]): void {
    this.selectedAtomIndices = [...new Set(atomIndices)];
    try {
      this.adapter?.setSelection(this.selectedAtomIndices);
    } catch (error) {
      this.onRenderError(error);
    }
  }

  async setRepresentation(
    representation: ViewerRepresentation,
    target: ViewerTarget,
    action: ViewerRepresentationAction = "show",
  ): Promise<void> {
    if (!this.adapter?.setRepresentation) throw new Error("Representation controls are unavailable.");
    if (!this.structures.length) throw new Error("Open a structure first.");
    if (target === "selection" && !this.selectedAtomIndices.length) throw new Error("Select atoms first.");
    if (representation === "everything" && action !== "hide") throw new Error("Choose a representation to show.");
    await this.adapter.setRepresentation(representation, target, action);
    if (target === "all" && (action === "replace" || representation === "everything")) this.representations = [];
    this.representations.push({ representation, target, action, atomIndices: [...this.selectedAtomIndices] });
  }

  setColor(color: ViewerColor, target: ViewerTarget): void {
    if (!this.adapter?.setColor) throw new Error("Color controls are unavailable.");
    this.adapter.setColor(color, target);
  }

  setBackground(color: "black" | "white"): void {
    if (!this.adapter?.setBackground) throw new Error("Background controls are unavailable.");
    this.adapter.setBackground(color);
  }

  camera(action: ViewerCameraAction): void {
    if (!this.adapter?.camera) throw new Error("Camera controls are unavailable.");
    this.adapter.camera(action);
  }

  executeCommand(command: string): unknown {
    if (!this.adapter?.executeCommand) {
      throw new Error("Viewer commands are available only with the Patinae renderer.");
    }
    return this.adapter.executeCommand(command);
  }

  evaluateSelection(expression: string): number[] {
    if (!this.adapter?.evaluateSelection) throw new Error("Renderer selection evaluation is unavailable.");
    return this.adapter.evaluateSelection(expression);
  }

  getObjectList(): ViewerObject[] {
    return this.adapter?.getObjectList?.() ?? [];
  }

  setObjectEnabled(name: string, enabled: boolean): void {
    if (!this.adapter?.setObjectEnabled) throw new Error("Object visibility is unavailable.");
    this.adapter.setObjectEnabled(name, enabled);
  }

  getSelectionList(): ViewerSelection[] {
    return this.adapter?.getSelectionList?.() ?? [];
  }

  getCommandCatalog(): ViewerCommand[] {
    return this.adapter?.getCommandCatalog?.() ?? [];
  }

  listMeasurements(): ViewerMeasurement[] {
    return this.adapter?.listMeasurements?.() ?? [];
  }

  async addMeasurement(request: ViewerMeasurementRequest): Promise<ViewerMeasurement[]> {
    if (!this.adapter?.addMeasurement) throw new Error("Renderer measurements are unavailable.");
    const normalized = normalizeViewerMeasurementRequest(request);
    const measurements = await this.adapter.addMeasurement(normalized);
    this.measurementRequests.push(normalized);
    return measurements;
  }

  async showInteractions(interactions: ViewerInteraction[]): Promise<void> {
    if (!this.adapter?.showInteractions) throw new Error("Renderer interaction overlays are unavailable.");
    this.interactionOverlays = interactions;
    await this.replayTransientVisuals();
  }

  async clearMeasurements(): Promise<void> {
    this.measurementRequests = [];
    await this.replayTransientVisuals();
  }

  async clearInteractions(): Promise<void> {
    this.interactionOverlays = [];
    await this.replayTransientVisuals();
  }

  async resetView(): Promise<void> {
    await this.clearAllVisuals();
    this.selectedAtomIndices = [];
    await this.activate(this.mode);
  }

  async clearAllVisuals(): Promise<void> {
    this.representations = [];
    this.annotationGroups = [];
    this.interactionOverlays = [];
    this.measurementRequests = [];
    await this.setMarkers([]);
    await this.adapter?.clearMeasurements?.();
  }

  async setMarkers(markers: ViewerMarker[]): Promise<void> {
    this.markers = markers;
    await this.adapter?.showMarkers?.(markers);
    this.container.dataset.centroidMarkers = String(markers.length);
  }

  async showAnnotation(groups: AnnotationGroup[]): Promise<void> {
    if (!this.adapter) throw new Error("Molecular viewer is not initialized");
    this.annotationGroups = groups;
    this.updateAnnotationDiagnostics(this.structures.length ? await this.adapter.showAnnotation(groups) : undefined);
    await this.replayRepresentations();
    await this.replayTransientVisuals();
  }

  async clearAnnotation(): Promise<void> {
    this.annotationGroups = [];
    await this.adapter?.clearAnnotation();
    await this.replayRepresentations();
    await this.replayTransientVisuals();
    this.updateAnnotationDiagnostics();
  }

  destroy(): void {
    this.adapter?.destroy();
    this.adapter = null;
    this.container.replaceChildren();
    delete this.container.dataset.backend;
    delete this.container.dataset.picking;
    delete this.container.dataset.comparisonStructures;
    this.structures = [];
    this.selectedAtomIndices = [];
    this.annotationGroups = [];
    this.interactionOverlays = [];
    this.measurementRequests = [];
  }
}
