/**
 * Move and rotate handles drawn in the Mol* scene, ported from the molstar-editor gizmos.
 *
 * The gizmo reports motion and changes nothing itself: it draws three arrows (move) or three rings
 * (rotate) at a point, turns the camera's drag bindings off while a handle is held, and hands the
 * accumulated motion to `onChange`. What that motion does to a structure is the caller's business —
 * here, a preview frame while dragging and one document edit on Apply.
 *
 * Drag maths follows the original: an arrow moves along the closest point between the pointer ray
 * and that axis, a ring turns by the angle swept around the gizmo's projected centre, signed by
 * which side of the rotation plane the camera is on.
 */
import { Mat4, Quat, Vec2, Vec3, Vec4 } from "molstar/lib/mol-math/linear-algebra";
import { Ray3D } from "molstar/lib/mol-math/geometry/primitives/ray3d";
import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context";
import { Shape } from "molstar/lib/mol-model/shape";
import { ShapeRepresentation } from "molstar/lib/mol-repr/shape/representation";
import { Mesh } from "molstar/lib/mol-geo/geometry/mesh/mesh";
import { MeshBuilder } from "molstar/lib/mol-geo/geometry/mesh/mesh-builder";
import { addCylinder } from "molstar/lib/mol-geo/geometry/mesh/builder/cylinder";
import { Binding } from "molstar/lib/mol-util/binding";
import { Color } from "molstar/lib/mol-util/color";

export type TransformGizmoMode = "move" | "rotate";

/** The motion a drag has accumulated so far, in angstroms and radians. */
export type TransformGizmoMotion = {
  mode: TransformGizmoMode;
  /** Move: the total offset. Rotate: zero. */
  translation: [number, number, number];
  /** Rotate: the axis turned about, already in world space. Move: null. */
  axis: [number, number, number] | null;
  angle: number;
  /** The pivot a rotation turns about (the gizmo's centre). */
  center: [number, number, number];
  /** True while a handle is held, false on release — a caller can commit on release only. */
  dragging: boolean;
};

const AXES = [
  { color: Color(0xff3b30), direction: Vec3.create(1, 0, 0) },
  { color: Color(0x34c759), direction: Vec3.create(0, 1, 0) },
  { color: Color(0x0a84ff), direction: Vec3.create(0, 0, 1) },
] as const;

const ARROW_SHAFT = 15.625;
const ARROW_TIP = 18.75;
const RING_RADIUS = 12;

function arrowMesh(direction: Vec3): Mesh {
  const state = MeshBuilder.createState(512, 256);
  const origin = Vec3.create(0, 0, 0);
  const shaftEnd = Vec3.scale(Vec3(), direction, ARROW_SHAFT);
  addCylinder(state, origin, shaftEnd, 1, { radiusTop: 0.3125, radiusBottom: 0.3125, radialSegments: 16 });
  const tip = Vec3.scale(Vec3(), direction, ARROW_TIP);
  // Cones are built base-to-tip; the +Y cone is wound the other way so its shading matches the rest.
  if (direction[1] > 0.5) addCylinder(state, tip, shaftEnd, 1, { radiusTop: 0, radiusBottom: 0.9375, radialSegments: 16 });
  else addCylinder(state, shaftEnd, tip, 1, { radiusTop: 0.9375, radiusBottom: 0, radialSegments: 16 });
  return MeshBuilder.getMesh(state);
}

function ringMesh(normal: Vec3): Mesh {
  const state = MeshBuilder.createState(512, 256);
  const segments = 48;
  let u = Vec3.create(1, 0, 0);
  if (Math.abs(Vec3.dot(normal, u)) > 0.9) u = Vec3.create(0, 1, 0);
  const v = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), normal, u));
  u = Vec3.normalize(Vec3(), Vec3.cross(Vec3(), v, normal));
  const point = (angle: number): Vec3 => Vec3.create(
    RING_RADIUS * (Math.cos(angle) * u[0] + Math.sin(angle) * v[0]),
    RING_RADIUS * (Math.cos(angle) * u[1] + Math.sin(angle) * v[1]),
    RING_RADIUS * (Math.cos(angle) * u[2] + Math.sin(angle) * v[2]),
  );
  const step = (2 * Math.PI) / segments;
  for (let i = 0; i < segments; i += 1) {
    const from = point(i * step);
    const to = point((i + 1) * step);
    // Overlap the segments slightly so the ring reads as one tube rather than a dashed circle.
    const extend = Vec3.scale(Vec3(), Vec3.sub(Vec3(), to, from), 0.15);
    addCylinder(state, Vec3.sub(Vec3(), from, extend), Vec3.add(Vec3(), to, extend), 1,
      { radiusTop: 0.5, radiusBottom: 0.5, radialSegments: 12 });
  }
  return MeshBuilder.getMesh(state);
}

/** The point on the line through `origin` along `direction` closest to `ray`. */
function closestPointOnAxis(ray: Ray3D, origin: Vec3, direction: Vec3): Vec3 {
  const w0 = Vec3.sub(Vec3(), ray.origin, origin);
  const a = Vec3.dot(ray.direction, ray.direction);
  const b = Vec3.dot(ray.direction, direction);
  const c = Vec3.dot(direction, direction);
  const d = Vec3.dot(ray.direction, w0);
  const e = Vec3.dot(direction, w0);
  const denominator = a * c - b * b;
  // Looking straight down the axis there is no unique closest point; fall back to the ray's own foot.
  const t = Math.abs(denominator) < 1e-6 ? e / c : (b * d - a * e) / denominator;
  return Vec3.scaleAndAdd(Vec3(), origin, direction, t);
}

export class TransformGizmo {
  private representation: ShapeRepresentation<{ transform: Mat4 }, Mesh, Mesh.Params> | null = null;
  private objectId: number | null = null;
  private mesh: Mesh | null = null;
  private readonly center: Vec3;
  private transform: Mat4;
  private subscriptions: { unsubscribe: () => void }[] = [];

  private pickedAxis: number | null = null;
  private dragging = false;
  private savedBindings: unknown = null;

  // Move
  private accumulated: Vec3 = Vec3.create(0, 0, 0);
  private dragDelta: Vec3 = Vec3.create(0, 0, 0);
  private dragStartPoint: Vec3 | null = null;
  private dragAxis: Vec3 | null = null;

  // Rotate
  private accumulatedRotation: Quat = Quat.identity();
  private planeNormal: Vec3 | null = null;
  private rotationSign = 1;
  private startAngle = 0;
  private lastAngle = 0;

  constructor(
    private readonly plugin: PluginUIContext,
    private readonly mode: TransformGizmoMode,
    center: readonly [number, number, number],
    private readonly onChange: (motion: TransformGizmoMotion) => void,
  ) {
    this.center = Vec3.create(center[0], center[1], center[2]);
    this.transform = Mat4.fromTranslation(Mat4(), this.center);
  }

  async show(): Promise<void> {
    const state = MeshBuilder.createState(2048, 1024);
    AXES.forEach((axis, index) => {
      state.currentGroup = index;
      MeshBuilder.addMesh(state, Mat4.identity(), this.mode === "move" ? arrowMesh(axis.direction) : ringMesh(axis.direction));
    });
    this.mesh = MeshBuilder.getMesh(state);

    this.representation = ShapeRepresentation(
      (_ctx: unknown, data: { transform: Mat4 }) => Shape.create(
        "studio-transform-gizmo",
        { transform: data.transform },
        this.mesh!,
        (group: number) => AXES[group]?.color ?? Color(0xffffff),
        () => 1,
        (group: number) => `${["X", "Y", "Z"][group] ?? "?"} ${this.mode === "move" ? "axis" : "rotation"}`,
        [data.transform],
      ),
      Mesh.Utils,
    ) as ShapeRepresentation<{ transform: Mat4 }, Mesh, Mesh.Params>;

    await this.representation.createOrUpdate({ alpha: 1, ignoreLight: true }, { transform: this.transform }).run();
    const canvas = this.plugin.canvas3d;
    if (!canvas) throw new Error("Mol* has no 3D canvas for the transform gizmo");
    canvas.add(this.representation);
    canvas.commit();
    this.objectId = this.representation.renderObjects?.[0]?.id ?? null;

    this.subscriptions.push(canvas.input.drag.subscribe(this.onDrag));
    this.subscriptions.push(canvas.input.interactionEnd.subscribe(this.onInteractionEnd));
  }

  hide(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions = [];
    this.restoreCamera();
    const canvas = this.plugin.canvas3d;
    if (this.representation && canvas) {
      canvas.remove(this.representation);
      canvas.commit();
    }
    this.representation = null;
    this.objectId = null;
    this.mesh = null;
  }

  /** Is a handle being held? A caller uses this to ignore camera drags. */
  get isDragging(): boolean {
    return this.dragging;
  }

  private motion(dragging: boolean): TransformGizmoMotion {
    if (this.mode === "move") {
      const total = Vec3.add(Vec3(), this.accumulated, this.dragDelta);
      return {
        mode: "move",
        translation: [total[0], total[1], total[2]],
        axis: null,
        angle: 0,
        center: [this.center[0], this.center[1], this.center[2]],
        dragging,
      };
    }
    const rotation = this.totalRotation();
    const axis = Vec3.create(0, 0, 0);
    const angle = Quat.getAxisAngle(axis, rotation);
    return {
      mode: "rotate",
      translation: [0, 0, 0],
      axis: [axis[0], axis[1], axis[2]],
      angle,
      center: [this.center[0], this.center[1], this.center[2]],
      dragging,
    };
  }

  private totalRotation(): Quat {
    if (!this.dragging || !this.planeNormal) return Quat.clone(this.accumulatedRotation);
    const step = Quat.setAxisAngle(Quat(), this.planeNormal, this.lastAngle);
    return Quat.multiply(Quat(), step, this.accumulatedRotation);
  }

  /** The gizmo centre in screen pixels, for the angle a ring drag sweeps. */
  private centerOnScreen(): { x: number; y: number } | null {
    const canvas = this.plugin.canvas3d;
    const element = canvas?.webgl?.gl.canvas as HTMLCanvasElement | undefined;
    if (!canvas || !element) return null;
    const projected = Vec4.transformMat4(
      Vec4(), Vec4.create(this.center[0], this.center[1], this.center[2], 1), canvas.camera.projectionView);
    if (projected[3] === 0) return null;
    return {
      x: ((projected[0] / projected[3] + 1) / 2) * element.clientWidth,
      y: ((1 - projected[1] / projected[3]) / 2) * element.clientHeight,
    };
  }

  private disableCameraDrag(): void {
    const canvas = this.plugin.canvas3d;
    const bindings = canvas?.attribs.trackball?.bindings;
    if (!canvas || !bindings) return;
    this.savedBindings = { ...bindings };
    canvas.setAttribs({
      trackball: {
        ...canvas.attribs.trackball,
        bindings: {
          ...bindings,
          dragRotate: Binding.Empty, dragRotateZ: Binding.Empty, dragPan: Binding.Empty,
          dragZoom: Binding.Empty, dragFocus: Binding.Empty, dragFocusZoom: Binding.Empty,
        },
      },
    });
  }

  private restoreCamera(): void {
    const canvas = this.plugin.canvas3d;
    if (!this.savedBindings || !canvas) return;
    canvas.setAttribs({ trackball: { ...canvas.attribs.trackball, bindings: this.savedBindings as never } });
    this.savedBindings = null;
  }

  private onInteractionEnd = (): void => {
    if (this.dragging) {
      if (this.mode === "move") {
        Vec3.add(this.accumulated, this.accumulated, this.dragDelta);
        Vec3.set(this.dragDelta, 0, 0, 0);
      } else if (this.planeNormal) {
        Quat.copy(this.accumulatedRotation, this.totalRotation());
      }
      this.dragging = false;
      this.dragStartPoint = null;
      this.dragAxis = null;
      this.planeNormal = null;
      this.startAngle = 0;
      this.lastAngle = 0;
      this.restoreCamera();
      // The release is what a caller commits on, so report once more with dragging false.
      this.onChange(this.motion(false));
    }
    this.pickedAxis = null;
  };

  private onDrag = (event: { x: number; y: number; buttons: number }): void => {
    const canvas = this.plugin.canvas3d;
    if (!canvas) return;

    if (!this.dragging) {
      // Decide once per press whether the drag started on a handle; otherwise leave the camera alone.
      if (this.pickedAxis === null && event.buttons) {
        const picked = canvas.identify(Vec2.create(event.x, event.y));
        this.pickedAxis = picked && this.objectId !== null && picked.id.objectId === this.objectId
          ? picked.id.groupId
          : -1;
      }
      if (this.pickedAxis === null || this.pickedAxis < 0) return;
      const axis = AXES[this.pickedAxis];
      if (!axis) return;

      this.dragging = true;
      if (this.mode === "move") {
        this.dragAxis = Vec3.clone(axis.direction);
        Vec3.set(this.dragDelta, 0, 0, 0);
        // The original negates x: Mol*'s drag x and its camera ray disagree in sign.
        const ray = canvas.camera.getRay(Ray3D(), -event.x, event.y);
        this.dragStartPoint = closestPointOnAxis(ray, this.center, this.dragAxis);
      } else {
        // Turning about an axis already turned carries the earlier rotation with it.
        this.planeNormal = Vec3.transformQuat(Vec3(), axis.direction, this.accumulatedRotation);
        const screen = this.centerOnScreen();
        if (!screen) { this.dragging = false; return; }
        this.startAngle = Math.atan2(event.y - screen.y, event.x - screen.x);
        this.lastAngle = 0;
        const toTarget = Vec3.normalize(Vec3(),
          Vec3.sub(Vec3(), canvas.camera.state.target, canvas.camera.state.position));
        this.rotationSign = Vec3.dot(toTarget, this.planeNormal) > 0 ? 1 : -1;
      }
      this.disableCameraDrag();
      return;
    }

    if (this.mode === "move") {
      if (!this.dragAxis || !this.dragStartPoint) return;
      const ray = canvas.camera.getRay(Ray3D(), -event.x, event.y);
      const now = closestPointOnAxis(ray, this.center, this.dragAxis);
      const along = Vec3.dot(Vec3.sub(Vec3(), now, this.dragStartPoint), this.dragAxis);
      Vec3.scale(this.dragDelta, this.dragAxis, along);
      const total = Vec3.add(Vec3(), this.accumulated, this.dragDelta);
      this.transform = Mat4.fromTranslation(Mat4(), Vec3.add(Vec3(), this.center, total));
    } else {
      if (!this.planeNormal) return;
      const screen = this.centerOnScreen();
      if (!screen) return;
      const angle = Math.atan2(event.y - screen.y, event.x - screen.x);
      this.lastAngle = this.rotationSign * (angle - this.startAngle);
      const rotation = Mat4.fromQuat(Mat4(), this.totalRotation());
      this.transform = Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), this.center), rotation);
    }

    void this.redraw();
    this.onChange(this.motion(true));
  };

  private async redraw(): Promise<void> {
    if (!this.representation) return;
    await this.representation.createOrUpdate({ alpha: 1, ignoreLight: true }, { transform: this.transform }).run();
    this.plugin.canvas3d?.commit();
  }
}
