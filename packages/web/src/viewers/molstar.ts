import { StateTransforms } from "molstar/lib/mol-plugin-state/transforms";
import { Viewer as MolstarViewer } from "molstar/lib/apps/viewer/app";
import { OrderedSet } from "molstar/lib/mol-data/int";
import {
  StructureElement,
  StructureProperties,
} from "molstar/lib/mol-model/structure/structure";
import {
  clearStructureOverpaint,
  setStructureOverpaint,
} from "molstar/lib/mol-plugin-state/helpers/structure-overpaint";
import type { StructureRepresentationProps } from "molstar/lib/mol-plugin-state/helpers/structure-representation-params";
import { Color } from "molstar/lib/mol-util/color";
import { Shape } from "molstar/lib/mol-model/shape";
import { ShapeRepresentation } from "molstar/lib/mol-repr/shape/representation";
import { Mesh } from "molstar/lib/mol-geo/geometry/mesh/mesh";
import { MeshBuilder } from "molstar/lib/mol-geo/geometry/mesh/mesh-builder";
import { addSphere } from "molstar/lib/mol-geo/geometry/mesh/builder/sphere";
import { Vec3 } from "molstar/lib/mol-math/linear-algebra";
import "molstar/lib/mol-plugin-ui/skin/dark.scss";

import {
  ANNOTATION_PALETTE,
  annotationRenderResult,
  interactionsToViewerOverlays,
  normalizedAnnotationGroups,
  normalizeViewerMeasurementRequest,
  type AnnotationGroup,
  type AnnotationRenderResult,
  type ViewerAdapter,
  type ViewerAdapterContext,
  type ViewerCameraAction,
  type ViewerInteraction,
  type ViewerMeasurement,
  type ViewerMeasurementRequest,
  type ViewerStructure,
  type ViewerMarker,
  type ViewerRepresentation,
  type ViewerRepresentationAction,
  type ViewerTarget,
} from "./contract";

const COMPARISON_COLORS = {
  cyan: 0x00ffff,
  magenta: 0xff00ff,
  orange: 0xffa500,
  green: 0x00cc66,
  yellow: 0xffff00,
  red: 0xff3333,
  blue: 0x3388ff,
} as const;

export class MolstarAdapter implements ViewerAdapter {
  readonly backend = "molstar" as const;
  readonly capabilities = {
    representations: true,
    colors: false,
    background: true,
    commands: false,
    picking: true,
    softwarePicking: false,
    selectionExpressions: false,
    selectionList: false,
    commandCatalog: false,
    measurements: true,
    interactionOverlays: true,
  } as const;
  private viewer: MolstarViewer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private selectedAtomIndices: number[] = [];
  private annotationGroups: AnnotationGroup[] = [];
  private displayComponents = new Map<string, Map<string, {
    loci: StructureElement.Loci; ref?: string; props?: StructureRepresentationProps;
  }>>();
  private comparisonColors = new Map<string, number>();
  private measurements: ViewerMeasurement[] = [];
  private markerRepresentation: ShapeRepresentation<ViewerMarker[], Mesh, typeof Mesh.Params> | null = null;

  constructor(private readonly context: ViewerAdapterContext) {}

  async initialize(): Promise<void> {
    this.viewer = await MolstarViewer.create(this.context.container, {
      extensions: [],
      layoutIsExpanded: false,
      layoutShowControls: false,
      layoutShowSequence: false,
      layoutShowLog: false,
      layoutShowLeftPanel: false,
      viewportShowControls: true,
      viewportShowSelectionMode: false,
      viewportBackgroundColor: "#02080d",
      preferWebgl1: false,
    });
    // Mol* can resolve create() even when its canvas failed to initialize.
    if (!this.viewer.plugin.canvas3d) {
      throw new Error("Mol* could not create a WebGL rendering context.");
    }
    // Docking the inspector and toggling sequence change the canvas without
    // resizing the browser window. Keep Mol*'s drawing buffer in step.
    this.resizeObserver = new ResizeObserver(() => this.viewer?.plugin.handleResize());
    this.resizeObserver.observe(this.context.container);
    for (const anchor of this.context.container.querySelectorAll("a")) {
      if (!anchor.textContent?.trim() && !anchor.getAttribute("aria-label")) {
        anchor.setAttribute("aria-label", anchor.title || "Mol* viewer link");
      }
    }
    this.viewer.plugin.managers.interactivity.setProps({ granularity: "element" });
    this.viewer.subscribe(this.viewer.plugin.behaviors.interaction.click, ({ current }) => {
      if (!StructureElement.Loci.is(current.loci) || current.loci.elements.length === 0) return;
      const group = current.loci.elements[0];
      if (OrderedSet.size(group.indices) === 0) return;
      const elementIndex = group.unit.elements[OrderedSet.getAt(group.indices, 0)];
      const location = StructureElement.Location.create(current.loci.structure, group.unit, elementIndex);
      const atomIndex = StructureProperties.atom.sourceIndex(location);
      this.context.onPick({
        atomIndex,
        label: [
          StructureProperties.chain.auth_asym_id(location),
          StructureProperties.residue.auth_seq_id(location),
          StructureProperties.atom.label_atom_id(location),
        ].join("/"),
      });
    });
  }

  async loadCif(cif: string, name: string): Promise<void> {
    if (!this.viewer) throw new Error("Mol* is not initialized");
    this.displayComponents.clear();
    this.comparisonColors.clear();
    this.annotationGroups = [];
    await this.viewer.plugin.clear();
    await this.viewer.loadStructureFromData(cif, "mmcif", { dataLabel: name });
  }

  trajectoryFrameCount(): number {
    return this.viewer?.plugin.managers.structure.hierarchy.current.trajectories[0]?.cell.obj?.data.frameCount ?? 0;
  }

  async setTrajectoryFrame(index: number): Promise<void> {
    if (!this.viewer) throw new Error("Mol* is not initialized");
    const state = this.viewer.plugin.state.data;
    const update = state.build();
    for (const model of state.selectQ(q => q.ofTransformer(StateTransforms.Model.ModelFromTrajectory))) {
      update.to(model).update({ modelIndex: index });
    }
    await update.commit();
  }

  async loadCifs(structures: ViewerStructure[]): Promise<void> {
    if (!this.viewer) throw new Error("Mol* is not initialized");
    this.displayComponents.clear();
    this.comparisonColors.clear();
    this.annotationGroups = [];
    await this.viewer.plugin.clear();
    for (const [index, structure] of structures.entries()) {
      await this.viewer.loadStructureFromData(structure.cif, "mmcif", { dataLabel: structure.name });
      const reference = this.viewer.plugin.managers.structure.hierarchy.current.structures.at(-1);
      if (!reference) continue;
      const fallback = ["cyan", "magenta", "orange", "green"][index % 4] as keyof typeof COMPARISON_COLORS;
      const colorName = structure.color && structure.color in COMPARISON_COLORS
        ? structure.color as keyof typeof COMPARISON_COLORS
        : fallback;
      this.comparisonColors.set(reference.cell.transform.ref, COMPARISON_COLORS[colorName]);
      await setStructureOverpaint(
        this.viewer.plugin,
        reference.components,
        Color(COMPARISON_COLORS[colorName]),
        async (loadedStructure) => StructureElement.Loci.all(loadedStructure),
      );
    }
    this.viewer.plugin.managers.camera.reset();
  }

  private currentStructure() {
    if (!this.viewer) throw new Error("Mol* is not initialized");
    const reference = this.viewer.plugin.managers.structure.hierarchy.current.structures[0];
    const structure = reference?.cell.obj?.data;
    if (!reference || !structure) throw new Error("Mol* has no loaded structure");
    return { reference, structure };
  }

  private lociFor(atomIndices: number[]) {
    const { structure } = this.currentStructure();
    return StructureElement.Schema.toLoci(structure, { items: { atom_index: atomIndices } });
  }

  async showAnnotation(groups: AnnotationGroup[]): Promise<AnnotationRenderResult> {
    if (!this.viewer) throw new Error("Mol* is not initialized");
    const normalized = normalizedAnnotationGroups(groups);
    this.annotationGroups = normalized;
    const { reference } = this.currentStructure();
    await clearStructureOverpaint(this.viewer.plugin, reference.components);
    if (normalized.length === 0) {
      this.clearSelection();
      return annotationRenderResult(normalized);
    }

    try {
      for (const [index, group] of normalized.entries()) {
        const loci = this.lociFor(group.atomIndices);
        const selectedCount = StructureElement.Loci.size(loci);
        if (selectedCount !== group.atomIndices.length) {
          throw new Error(
            `Mol* selected ${selectedCount} atoms for ${group.label}; ` +
              `AtomWorks reported ${group.atomIndices.length}.`,
          );
        }
        const color = group.color ?? ANNOTATION_PALETTE[index % ANNOTATION_PALETTE.length];
        await setStructureOverpaint(
          this.viewer.plugin,
          reference.components,
          Color(color.value),
          async (structure) =>
            StructureElement.Schema.toLoci(structure, {
              items: { atom_index: group.atomIndices },
            }),
        );
      }
    } catch (error) {
      await clearStructureOverpaint(this.viewer.plugin, reference.components);
      throw error;
    }

    const result = annotationRenderResult(normalized);
    const loci = this.lociFor([...new Set(normalized.flatMap((group) => group.atomIndices))]);
    if (StructureElement.Loci.size(loci) !== result.atomCount) {
      throw new Error("Mol* annotation union does not match AtomWorks atom indices");
    }
    this.viewer.plugin.managers.interactivity.lociSelects.select({ loci });
    this.viewer.plugin.managers.camera.focusLoci(loci);
    return result;
  }

  async clearAnnotation(): Promise<void> {
    this.annotationGroups = [];
    if (!this.viewer) return;
    const reference = this.viewer.plugin.managers.structure.hierarchy.current.structures[0];
    if (reference) await clearStructureOverpaint(this.viewer.plugin, reference.components);
  }

  setSelection(atomIndices: number[]): void {
    if (!this.viewer) return;
    this.clearSelection();
    if (!atomIndices.length) return;
    this.selectedAtomIndices = [...new Set(atomIndices)];
    const loci = this.lociFor(this.selectedAtomIndices);
    this.viewer.plugin.managers.interactivity.lociSelects.select({ loci });
  }

  clearSelection(): void {
    if (!this.viewer) return;
    this.viewer.plugin.managers.interactivity.lociSelects.deselectAll();
    this.viewer.plugin.managers.interactivity.lociHighlights.clearHighlights();
    this.viewer.plugin.managers.structure.focus.clear();
    this.selectedAtomIndices = [];
  }

  async setRepresentation(
    representation: ViewerRepresentation,
    target: ViewerTarget,
    action: ViewerRepresentationAction,
  ): Promise<void> {
    if (!this.viewer) throw new Error("Mol* is not initialized");
    const plugin = this.viewer.plugin;
    const types: Record<Exclude<ViewerRepresentation, "everything">, string> = {
      cartoon: "cartoon", ribbon: "backbone", lines: "line", sticks: "ball-and-stick",
      spheres: "spacefill", surface: "molecular-surface",
    };
    const requested = representation === "everything" ? null : types[representation];
    for (const [index, reference] of plugin.managers.structure.hierarchy.current.structures.entries()) {
      // Studio selections index the editable input, not comparison structures.
      if (target === "selection" && index > 0) continue;
      const structure = reference.cell.obj?.data;
      if (!structure) continue;
      const selected = target === "all" ? StructureElement.Loci.all(structure) :
        StructureElement.Schema.toLoci(structure, { items: { atom_index: this.selectedAtomIndices } });
      const root = reference.cell.transform.ref;
      let components = this.displayComponents.get(root);
      if (!components) {
        components = new Map();
        // Preserve the preset's visible atoms, then use one component per representation.
        // Native bundle components remove hidden geometry, including picking.
        for (const component of reference.components) {
          const data = component.cell.obj?.data;
          if (!data) continue;
          const loci = StructureElement.Loci.remap(StructureElement.Loci.all(data), structure);
          for (const repr of component.representations) {
            const values = repr.cell.params?.values;
            if (!values) continue;
            const type = values.type.name;
            const previous = components.get(type);
            components.set(type, {
              loci: previous ? StructureElement.Loci.union(previous.loci, loci) : loci,
              props: previous?.props ?? {
                type: plugin.representation.structure.registry.get(type), typeParams: values.type.params,
                color: plugin.representation.structure.themes.colorThemeRegistry.get(values.colorTheme.name),
                colorParams: values.colorTheme.params,
                size: plugin.representation.structure.themes.sizeThemeRegistry.get(values.sizeTheme.name),
                sizeParams: values.sizeTheme.params,
              },
            });
          }
        }
        const update = plugin.state.data.build();
        for (const component of reference.components) update.delete(component.cell.transform.ref);
        await update.commit();
        this.displayComponents.set(root, components);
      }
      if (requested && !components.has(requested)) components.set(requested, { loci: StructureElement.Loci.none(structure) });
      for (const [type, component] of components) {
        let visible = component.loci;
        if (action === "replace" || (action === "hide" && (!requested || requested === type))) {
          visible = StructureElement.Loci.subtract(visible, selected);
        }
        if (action !== "hide" && requested === type) visible = StructureElement.Loci.union(visible, selected);
        if ((component.ref || StructureElement.Loci.isEmpty(visible)) && StructureElement.Loci.areEqual(visible, component.loci)) continue;
        const result = await plugin.builders.structure.tryCreateComponent(root, {
          type: { name: "bundle", params: StructureElement.Bundle.fromLoci(visible) },
          nullIfEmpty: true, label: type,
        }, `studio-${type}`);
        if (result && !component.ref) {
          await plugin.builders.structure.representation.addRepresentation(result, component.props ?? {
            type: plugin.representation.structure.registry.get(type),
            color: plugin.representation.structure.themes.colorThemeRegistry.get(
              type === "cartoon" || type === "backbone" ? "chain-id" : "element-symbol"),
            ...(type === "ball-and-stick" ? { typeParams: { sizeAspectRatio: 1 } } : {}),
          });
        }
        component.loci = visible;
        component.ref = result?.ref;
      }
    }
    for (const reference of plugin.managers.structure.hierarchy.current.structures) {
      const color = this.comparisonColors.get(reference.cell.transform.ref);
      if (color !== undefined) await setStructureOverpaint(plugin, reference.components, Color(color),
        async structure => StructureElement.Loci.all(structure));
    }
    // New components receive annotation colours without changing selection or camera.
    const { reference } = this.currentStructure();
    for (const [index, group] of this.annotationGroups.entries()) {
      await setStructureOverpaint(plugin, reference.components,
        Color((group.color ?? ANNOTATION_PALETTE[index % ANNOTATION_PALETTE.length]).value),
        async () => this.lociFor(group.atomIndices));
    }
  }

  setBackground(color: "black" | "white"): void {
    this.viewer?.plugin.canvas3d?.setProps({
      renderer: { backgroundColor: Color(color === "black" ? 0x000000 : 0xffffff) },
    });
  }

  camera(action: ViewerCameraAction): void {
    if (!this.viewer) return;
    if (action === "center" && this.selectedAtomIndices.length) {
      this.viewer.plugin.managers.camera.focusLoci(this.lociFor(this.selectedAtomIndices));
      return;
    }
    this.viewer.plugin.managers.camera.reset();
  }

  listMeasurements(): ViewerMeasurement[] {
    return this.measurements;
  }

  async addMeasurement(request: ViewerMeasurementRequest): Promise<ViewerMeasurement[]> {
    if (!this.viewer) throw new Error("Mol* is not initialized");
    const normalized = normalizeViewerMeasurementRequest(request);
    const loci = normalized.atomIndices.map((atomIndex) => this.lociFor([atomIndex]));
    const color = Color(normalized.color ?? 0xffd54f);
    const options = {
      customText: normalized.label,
      visualParams: { linesColor: color, textColor: color },
    };
    const manager = this.viewer.plugin.managers.structure.measurement;
    if (normalized.kind === "distance") await manager.addDistance(loci[0], loci[1], options);
    else if (normalized.kind === "angle") await manager.addAngle(loci[0], loci[1], loci[2], options);
    else await manager.addDihedral(loci[0], loci[1], loci[2], loci[3], options);
    const measurement: ViewerMeasurement = {
      id: `${normalized.kind}_${Date.now()}`,
      label: normalized.label ?? normalized.kind,
      kind: normalized.kind,
      atomIndices: normalized.atomIndices,
    };
    this.measurements.push(measurement);
    return [measurement];
  }

  async clearMeasurements(): Promise<void> {
    if (!this.viewer) return;
    const state = this.viewer.plugin.managers.structure.measurement.state;
    const cells = [
      ...state.labels,
      ...state.distances,
      ...state.angles,
      ...state.dihedrals,
      ...state.orientations,
      ...state.planes,
    ];
    if (cells.length) {
      const update = this.viewer.plugin.state.data.build();
      for (const cell of cells) update.delete(cell.transform.ref);
      await update.commit();
    }
    this.measurements = [];
  }

  async showInteractions(interactions: ViewerInteraction[]): Promise<void> {
    await this.clearMeasurements();
    for (const overlay of interactionsToViewerOverlays(interactions)) {
      await this.addMeasurement(overlay);
    }
  }

  async showMarkers(markers: ViewerMarker[]): Promise<void> {
    if (!this.viewer) return;
    if (this.markerRepresentation) {
      this.viewer.plugin.canvas3d?.remove(this.markerRepresentation);
      this.markerRepresentation.destroy();
      this.markerRepresentation = null;
    }
    if (!markers.length) return;
    const representation = ShapeRepresentation<ViewerMarker[], Mesh, typeof Mesh.Params>((_ctx, data) => {
      const builder = MeshBuilder.createState();
      data.forEach((marker, index) => {
        builder.currentGroup = index;
        addSphere(builder, Vec3.create(...marker.position), 0.6, 2);
      });
      return Shape.create("Chain centroid targets", data, MeshBuilder.getMesh(builder),
        (group) => Color(data[group].color), () => 1, (group) => data[group].label);
    }, Mesh.Utils);
    await this.viewer.plugin.runTask(representation.createOrUpdate({}, markers));
    this.viewer.plugin.canvas3d?.add(representation);
    this.markerRepresentation = representation;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.markerRepresentation?.destroy();
    this.markerRepresentation = null;
    this.viewer?.dispose();
    this.viewer = null;
    this.measurements = [];
  }
}

export function createMolstarAdapter(context: ViewerAdapterContext): ViewerAdapter {
  return new MolstarAdapter(context);
}
