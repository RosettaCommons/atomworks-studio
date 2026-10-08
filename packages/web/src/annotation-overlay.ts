import type { AnnotationGroup, MolecularViewer } from "./viewers";

export class AnnotationOverlayState {
  private groups: AnnotationGroup[] = [];

  get active(): readonly AnnotationGroup[] {
    return this.groups;
  }

  async show(viewer: MolecularViewer, groups: AnnotationGroup[], selection: Iterable<number>): Promise<void> {
    this.groups = groups;
    await viewer.showAnnotation(groups);
    viewer.setSelection([...selection]);
  }

  async clear(viewer: MolecularViewer, selection: Iterable<number>): Promise<void> {
    this.groups = [];
    await viewer.clearAnnotation();
    viewer.setSelection([...selection]);
  }

  async restore(viewer: MolecularViewer, selection: Iterable<number>): Promise<void> {
    if (this.groups.length) await viewer.showAnnotation(this.groups);
    viewer.setSelection([...selection]);
  }

  reset(): void {
    this.groups = [];
  }
}
