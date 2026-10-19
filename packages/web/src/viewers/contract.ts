import annotationPalette from "../../../editing/atomworks_studio_editing/annotation_palette.json" with { type: "json" };

export type ViewerBackend = "patinae" | "molstar";
export type ViewerMode = ViewerBackend;
export type ViewerTarget = "all" | "selection";
export type ViewerRepresentationAction = "show" | "hide" | "replace";
export type ViewerRepresentation =
  | "everything"
  | "cartoon"
  | "ribbon"
  | "lines"
  | "sticks"
  | "spheres"
  | "surface";
export type ViewerColor =
  | "atomic"
  | "chain"
  | "ss"
  | "residue"
  | "rainbow"
  | "yellow"
  | "cyan"
  | "magenta"
  | "orange"
  | "green"
  | "red"
  | "blue";
export type ViewerCameraAction = "reset" | "zoom" | "center" | "orient";

export type ViewerCapabilities = {
  representations: boolean;
  colors: boolean;
  background: boolean;
  commands: boolean;
  picking: boolean;
  softwarePicking: boolean;
  selectionExpressions: boolean;
  selectionList: boolean;
  commandCatalog: boolean;
  measurements: boolean;
  interactionOverlays: boolean;
};

export type ViewerSelection = {
  name: string;
  expression?: string;
  atomIndices?: number[];
};

export type ViewerObject = {
  name: string;
  type?: string;
  atomCount?: number;
  enabled?: boolean;
};

export type ViewerStructure = {
  cif: string;
  name: string;
  color?: ViewerColor;
};

export type ViewerCommand = {
  name: string;
  aliases?: string[];
  description?: string;
  usage?: string;
  help?: string;
  webSafe?: boolean;
  unavailableReason?: string | null;
};

export type ViewerMeasurement = {
  id?: string;
  label?: string;
  kind?: string;
  value?: number;
  unit?: string;
  atomIndices?: number[];
};

export type ViewerMeasurementKind = "distance" | "angle" | "dihedral";

export type ViewerMeasurementAtomIndices = {
  distance: [number, number];
  angle: [number, number, number];
  dihedral: [number, number, number, number];
};

export type ViewerMeasurementRequest<K extends ViewerMeasurementKind = ViewerMeasurementKind> = {
  kind: K;
  atomIndices: number[];
  label?: string;
  color?: number;
};

export type NormalizedViewerMeasurementRequest<
  K extends ViewerMeasurementKind = ViewerMeasurementKind,
> = Omit<ViewerMeasurementRequest<K>, "atomIndices"> & {
  atomIndices: ViewerMeasurementAtomIndices[K];
};

export type ViewerInteraction = {
  id: string;
  type: string;
  atom1: number;
  atom2: number;
  label: string;
  color: number;
};

export type ViewerInteractionOverlay = NormalizedViewerMeasurementRequest<"distance"> & {
  id: string;
};

export type AnnotationGroup = {
  label: string;
  atomIndices: number[];
  color?: AnnotationColor;
  showAtoms?: boolean;
};

export type ViewerMarker = { label: string; position: [number, number, number]; color: number };

export type AnnotationColor = {
  name: string;
  value: number;
};

export type AnnotationRenderResult = {
  atomCount: number;
  groupCount: number;
};

export type AtomPick = {
  atomIndex: number;
  label?: string;
  scope?: "atom" | "residue";
};

export type ViewerAdapterContext = {
  container: HTMLElement;
  onPick: (pick: AtomPick) => void;
};

export interface ViewerAdapter {
  readonly backend: ViewerBackend;
  readonly capabilities: ViewerCapabilities;
  initialize(): Promise<void>;
  loadCif(cif: string, name: string): Promise<void>;
  loadCifs(structures: ViewerStructure[]): Promise<void>;
  trajectoryFrameCount?(): number;
  setTrajectoryFrame?(index: number): Promise<void>;
  showAnnotation(groups: AnnotationGroup[]): Promise<AnnotationRenderResult>;
  clearAnnotation(): Promise<void>;
  setSelection(atomIndices: number[]): void;
  clearSelection(): void;
  setRepresentation?(representation: ViewerRepresentation, target: ViewerTarget, action: ViewerRepresentationAction): void | Promise<void>;
  setColor?(color: ViewerColor, target: ViewerTarget): void;
  setBackground?(color: "black" | "white"): void;
  camera?(action: ViewerCameraAction): void;
  executeCommand?(command: string): unknown;
  evaluateSelection?(expression: string): number[];
  getObjectList?(): ViewerObject[];
  setObjectEnabled?(name: string, enabled: boolean): void;
  getSelectionList?(): ViewerSelection[];
  getCommandCatalog?(): ViewerCommand[];
  listMeasurements?(): ViewerMeasurement[];
  addMeasurement?(request: ViewerMeasurementRequest): Promise<ViewerMeasurement[]>;
  showInteractions?(interactions: ViewerInteraction[]): Promise<void>;
  clearMeasurements?(): Promise<void>;
  showMarkers?(markers: ViewerMarker[]): Promise<void>;
  destroy(): void;
}

export const VIEWER_MEASUREMENT_CARDINALITY = {
  distance: 2,
  angle: 3,
  dihedral: 4,
} as const satisfies Record<ViewerMeasurementKind, number>;

export function viewerMeasurementCardinality<K extends ViewerMeasurementKind>(
  kind: K,
): (typeof VIEWER_MEASUREMENT_CARDINALITY)[K] {
  return VIEWER_MEASUREMENT_CARDINALITY[kind];
}

export function validateViewerMeasurementRequest<K extends ViewerMeasurementKind>(
  request: ViewerMeasurementRequest<K>,
): void {
  if (request.atomIndices.some((atomIndex) => !Number.isSafeInteger(atomIndex) || atomIndex < 0)) {
    throw new Error(`${request.kind} measurement atom indices must be non-negative integers.`);
  }

  const required = viewerMeasurementCardinality(request.kind);
  if (request.atomIndices.length !== required) {
    throw new Error(`Select exactly ${required} atoms for a ${request.kind} measurement.`);
  }
}

export function normalizeViewerMeasurementRequest<K extends ViewerMeasurementKind>(
  request: ViewerMeasurementRequest<K>,
): NormalizedViewerMeasurementRequest<K> {
  const normalized = {
    ...request,
    atomIndices: [...new Set(request.atomIndices)],
  };
  validateViewerMeasurementRequest(normalized);
  return normalized as NormalizedViewerMeasurementRequest<K>;
}

export function interactionToViewerOverlay(
  interaction: ViewerInteraction,
): ViewerInteractionOverlay {
  const request = normalizeViewerMeasurementRequest({
    kind: "distance",
    atomIndices: [interaction.atom1, interaction.atom2],
    label: interaction.label,
    color: interaction.color,
  });
  return { id: interaction.id, ...request };
}

export function interactionsToViewerOverlays(
  interactions: readonly ViewerInteraction[],
): ViewerInteractionOverlay[] {
  return interactions.map(interactionToViewerOverlay);
}

export type ViewerTransientVisualState = {
  interactionOverlays: readonly ViewerInteraction[];
  measurementRequests: readonly ViewerMeasurementRequest[];
};

export async function replayViewerTransientVisuals(
  adapter: Pick<ViewerAdapter, "clearMeasurements" | "showInteractions" | "addMeasurement">,
  state: ViewerTransientVisualState,
): Promise<void> {
  await adapter.clearMeasurements?.();
  await adapter.showInteractions?.([...state.interactionOverlays]);
  for (const request of state.measurementRequests) {
    await adapter.addMeasurement?.(request);
  }
}

export const ANNOTATION_PALETTE: readonly AnnotationColor[] = annotationPalette;

export function normalizedAnnotationGroups(groups: AnnotationGroup[]): AnnotationGroup[] {
  return groups.flatMap((group) => {
    const atomIndices = [...new Set(group.atomIndices)].sort((left, right) => left - right);
    return atomIndices.length ? [{ ...group, atomIndices }] : [];
  });
}

export function annotationRenderResult(groups: AnnotationGroup[]): AnnotationRenderResult {
  return {
    atomCount: new Set(groups.flatMap((group) => group.atomIndices)).size,
    groupCount: groups.length,
  };
}
