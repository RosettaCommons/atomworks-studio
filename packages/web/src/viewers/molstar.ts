import { StateTransforms } from "molstar/lib/mol-plugin-state/transforms";
import { Viewer as MolstarViewer } from "molstar/lib/apps/viewer/app";
import { FocusLoci } from "molstar/lib/mol-plugin/behavior/dynamic/representation";
import { FocusLoci as FocusCamera } from "molstar/lib/mol-plugin/behavior/dynamic/camera";
import { ButtonsType } from "molstar/lib/mol-util/input/input-observer";
import { Binding } from "molstar/lib/mol-util/binding";
import { Bond, Structure } from "molstar/lib/mol-model/structure";
import { PluginStateObject, PluginStateTransform } from "molstar/lib/mol-plugin-state/objects";
import { StateObject } from "molstar/lib/mol-state";
import { ParamDefinition } from "molstar/lib/mol-util/param-definition";
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
import { Lines } from "molstar/lib/mol-geo/geometry/lines/lines";
import { LinesBuilder } from "molstar/lib/mol-geo/geometry/lines/lines-builder";
import { Mesh } from "molstar/lib/mol-geo/geometry/mesh/mesh";
import { MeshBuilder } from "molstar/lib/mol-geo/geometry/mesh/mesh-builder";
import { addSphere } from "molstar/lib/mol-geo/geometry/mesh/builder/sphere";
import { Vec3 } from "molstar/lib/mol-math/linear-algebra";
import "molstar/lib/mol-plugin-ui/skin/dark.scss";
import { unpositionedAtomIndices } from "./unpositioned-atoms";

import {
  ANNOTATION_PALETTE,
  annotationRenderResult,
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

// The render root contains only positioned atoms. Focus, camera, representations,
// and picking therefore share the same geometry, while source indices stay intact.
const PositionedStructure = PluginStateTransform.BuiltIn({
  name: "studio-positioned-structure",
  display: { name: "Positioned atoms" },
  from: PluginStateObject.Molecule.Model,
  to: PluginStateObject.Molecule.Structure,
  params: { excluded: ParamDefinition.Value<number[]>([]) },
})({
  apply({ a, params }) {
    const full = Structure.ofModel(a.data);
    const excluded = StructureElement.Schema.toLoci(full, { items: { atom_index: params.excluded } });
    const visible = StructureElement.Loci.toStructure(
      StructureElement.Loci.subtract(StructureElement.Loci.all(full), excluded),
    );
    if (!visible.elementCount) return StateObject.Null;
    return new PluginStateObject.Molecule.Structure(Structure.create(visible.units), { label: a.label });
  },
  dispose({ b }) { b?.data.customPropertyDescriptors.dispose(); },
});

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
  private annotationComponent: string | undefined;
  private displayComponents = new Map<string, Map<string, {
    loci: StructureElement.Loci; ref?: string; props?: StructureRepresentationProps;
  }>>();
  private comparisonColors = new Map<string, number>();
  private measurements: ViewerMeasurement[] = [];
  private interactionRepresentation: ShapeRepresentation<ViewerInteraction[], Lines, typeof Lines.Params> | null = null;
  private unpositionedAtoms = new Set<number>();
  private markerRepresentation: ShapeRepresentation<ViewerMarker[], Mesh, typeof Mesh.Params> | null = null;

  constructor(private readonly context: ViewerAdapterContext) {}

  async initialize(): Promise<void> {
    this.context.container.dataset.renderedAtoms = "0";
    this.context.container.dataset.renderedStructures = "0";
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
    // Camera changes belong to loading, explicit View actions, and user navigation.
    this.viewer.plugin.canvas3d.setProps({ camera: { manualReset: true } });
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
    await this.viewer.plugin.state.updateBehavior(FocusLoci, (params) => {
      params.bindings.clickFocus = Binding.Empty;
      params.bindings.clickFocusAdd = Binding.Empty;
      params.bindings.clickFocusExtend = Binding.Empty;
    });
    await this.viewer.plugin.state.updateBehavior(FocusCamera, (params) => {
      for (const name of ["clickCenterFocus", "clickCenterFocusSelectMode"] as const) {
        const binding: Binding = params.bindings[name];
        params.bindings[name] = {
          ...binding, triggers: binding.triggers.filter((trigger) => trigger.buttons !== ButtonsType.Flag.Primary),
        };
      }
    });
    this.viewer.subscribe(this.viewer.plugin.behaviors.interaction.click, ({ current, button }) => {
      if (button !== ButtonsType.Flag.Primary) return;
      const loci = Bond.isLoci(current.loci) ? Bond.toFirstStructureElementLoci(current.loci) : current.loci;
      if (!StructureElement.Loci.is(loci) || loci.elements.length === 0) return;
      const scope = StructureElement.Loci.size(loci) > 1 ? "residue" : "atom";
      if (scope === "residue") {
        this.viewer!.plugin.managers.structure.focus.setFromLoci(loci);
        this.viewer!.plugin.managers.camera.focusLoci(loci);
      }
      const group = loci.elements[0];
      if (OrderedSet.size(group.indices) === 0) return;
      const elementIndex = group.unit.elements[OrderedSet.getAt(group.indices, 0)];
      const location = StructureElement.Location.create(loci.structure, group.unit, elementIndex);
      const atomIndex = StructureProperties.atom.sourceIndex(location);
      this.context.onPick({
        atomIndex,
        scope,
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
    this.annotationComponent = undefined;
    this.clearSelection();
    this.viewer.plugin.managers.structure.focus.clear();
    await this.showInteractions([]);
    await this.viewer.plugin.clear();
    this.context.container.dataset.renderedAtoms = "0";
    this.context.container.dataset.renderedStructures = "0";
    this.unpositionedAtoms = new Set(unpositionedAtomIndices(cif));
    await this.loadPositionedStructure(cif, name);
    this.viewer.plugin.managers.camera.reset();
  }

  private async loadPositionedStructure(cif: string, name: string): Promise<string> {
    const plugin = this.viewer!.plugin;
    const data = await plugin.builders.data.rawData({ data: cif, label: name });
    const trajectory = await plugin.builders.structure.parseTrajectory(data, "mmcif");
    const model = await plugin.builders.structure.createModel(trajectory);
    const structure = await plugin.state.data.build().to(model).apply(PositionedStructure, {
      excluded: unpositionedAtomIndices(cif),
    }).commit();
    if (structure.obj?.data.elementCount) {
      await plugin.builders.structure.representation.applyPreset(structure, "auto");
    }
    this.context.container.dataset.renderedAtoms = String(
      plugin.managers.structure.hierarchy.current.structures.reduce((count, ref) => count + (ref.cell.obj?.data.elementCount ?? 0), 0),
    );
    this.context.container.dataset.renderedStructures = String(plugin.managers.structure.hierarchy.current.structures.length);
    return structure.ref;
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
    this.unpositionedAtoms.clear();
    this.displayComponents.clear();
    this.comparisonColors.clear();
    this.annotationGroups = [];
    this.annotationComponent = undefined;
    this.clearSelection();
    this.viewer.plugin.managers.structure.focus.clear();
    await this.showInteractions([]);
    await this.viewer.plugin.clear();
    this.context.container.dataset.renderedAtoms = "0";
    this.context.container.dataset.renderedStructures = "0";
    for (const [index, structure] of structures.entries()) {
      const ref = await this.loadPositionedStructure(structure.cif, structure.name);
      const reference = this.viewer.plugin.managers.structure.hierarchy.current.structures.find(
        entry => entry.cell.transform.ref === ref,
      );
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
    if (!this.viewer.plugin.managers.structure.hierarchy.current.structures.length) return annotationRenderResult([]);
    const normalized = normalizedAnnotationGroups(groups.map(group => ({
      ...group, atomIndices: group.atomIndices.filter(index => !this.unpositionedAtoms.has(index)),
    })));
    await this.clearAnnotation();
    this.annotationGroups = normalized;
    const { reference } = this.currentStructure();
    const atomSites = normalized.filter(group => group.showAtoms).flatMap(group => group.atomIndices);
    if (atomSites.length) {
      const context = StructureElement.Loci.extendToWholeResidues(this.lociFor([...new Set(atomSites)]));
      const component = await this.viewer.plugin.builders.structure.tryCreateComponent(reference.cell.transform.ref, {
        type: { name: "bundle", params: StructureElement.Bundle.fromLoci(context) },
        nullIfEmpty: true, label: "Condition sites",
      }, "studio-condition-sites");
      if (component) {
        this.annotationComponent = component.ref;
        await this.viewer.plugin.builders.structure.representation.addRepresentation(component, {
          type: "ball-and-stick", color: "element-symbol", typeParams: { sizeAspectRatio: 1 },
        });
      }
    }
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
          this.currentStructure().reference.components,
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
    return result;
  }

  async clearAnnotation(): Promise<void> {
    this.annotationGroups = [];
    if (!this.viewer) return;
    if (this.annotationComponent) {
      await this.viewer.plugin.state.data.build().delete(this.annotationComponent).commit();
      this.annotationComponent = undefined;
    }
    const reference = this.viewer.plugin.managers.structure.hierarchy.current.structures[0];
    if (reference) await clearStructureOverpaint(this.viewer.plugin, reference.components);
  }

  setSelection(atomIndices: number[]): void {
    if (!this.viewer) return;
    this.clearSelection();
    if (!atomIndices.length) return;
    this.selectedAtomIndices = [...new Set(atomIndices)];
    if (!this.viewer.plugin.managers.structure.hierarchy.current.structures.length) return;
    const loci = this.lociFor(this.selectedAtomIndices);
    this.viewer.plugin.managers.interactivity.lociSelects.select({ loci });
  }

  clearSelection(): void {
    if (!this.viewer) return;
    this.viewer.plugin.managers.interactivity.lociSelects.deselectAll();
    this.viewer.plugin.managers.interactivity.lociHighlights.clearHighlights();
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
          if (component.cell.transform.ref === this.annotationComponent) continue;
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
        for (const component of reference.components) {
          if (component.cell.transform.ref !== this.annotationComponent) update.delete(component.cell.transform.ref);
        }
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
    if (!this.viewer) return;
    if (this.interactionRepresentation) {
      this.viewer.plugin.canvas3d?.remove(this.interactionRepresentation);
      this.interactionRepresentation.destroy();
      this.interactionRepresentation = null;
    }
    this.context.container.dataset.interactionContacts = "0";
    this.context.container.dataset.interactionRenderObjects = "0";
    if (!interactions.length || !this.viewer.plugin.managers.structure.hierarchy.current.structures.length) return;
    const visible = interactions.filter(contact =>
      !this.unpositionedAtoms.has(contact.atom1) && !this.unpositionedAtoms.has(contact.atom2));
    if (!visible.length) return;
    const representation = ShapeRepresentation<ViewerInteraction[], Lines, typeof Lines.Params>((_ctx, data) => {
      const builder = LinesBuilder.create();
      data.forEach((contact, index) => {
        const start = StructureElement.Loci.getBoundingSphere(this.lociFor([contact.atom1])).center;
        const end = StructureElement.Loci.getBoundingSphere(this.lociFor([contact.atom2])).center;
        builder.addFixedLengthDashes(start, end, 0.25, index);
      });
      return Shape.create("Interaction contacts", data, builder.getLines(),
        group => Color(data[group].color), () => 0.075,
        group => `${data[group].type}: ${data[group].label}`);
    }, Lines.Utils);
    await this.viewer.plugin.runTask(representation.createOrUpdate({ lineSizeAttenuation: true }, visible));
    this.viewer.plugin.canvas3d?.add(representation);
    this.interactionRepresentation = representation;
    this.context.container.dataset.interactionContacts = String(visible.length);
    this.context.container.dataset.interactionRenderObjects = String(representation.renderObjects.length);
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
    this.interactionRepresentation?.destroy();
    this.interactionRepresentation = null;
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
