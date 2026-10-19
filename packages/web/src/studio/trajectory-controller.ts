import { element } from "../dom";
import type { MolecularViewer } from "../viewers";

/** View-only playback. The editable session always retains the final structure. */
export class TrajectoryController {
  active = false;
  private playing = false;
  private cif: string | null = null;
  private frame = 0;
  private busy = false;
  private pendingFrame: number | null = null;
  private timer: number | undefined;
  private readonly events = new AbortController();
  private readonly toggle = element<HTMLButtonElement>("trajectory-toggle");
  private readonly play = element<HTMLButtonElement>("trajectory-play");
  private readonly slider = element<HTMLInputElement>("trajectory-frame");
  private readonly label = element<HTMLOutputElement>("trajectory-position");
  private readonly controls = element("trajectory-controls");

  constructor(
    private readonly viewer: MolecularViewer,
    private readonly restore: () => Promise<void>,
    private readonly log: (message: string, level?: "info" | "error") => void,
  ) {}

  bind(source: string): void {
    const url = new URL(source, location.href);
    if (url.origin !== location.origin) throw new Error("Trajectory must use the Studio host");
    element("trajectory-bar").hidden = false;
    this.toggle.addEventListener("click", () => void this.togglePlayback(url), { signal: this.events.signal });
    this.play.addEventListener("click", () => {
      if (this.playing) { this.pause(); return; }
      this.playing = true;
      this.play.textContent = "Pause";
      void this.tick();
    }, { signal: this.events.signal });
    this.slider.addEventListener("input", () => {
      this.pause();
      void this.showFrame(Number(this.slider.value));
    }, { signal: this.events.signal });
  }

  dispose(): void {
    this.pause();
    this.events.abort();
    element("trajectory-bar").hidden = true;
  }

  private pause(): void {
    window.clearTimeout(this.timer);
    this.playing = false;
    this.play.textContent = "Play";
  }

  private lockEditor(locked: boolean): void {
    for (const selector of [".header-actions", "#viewer-toolbar", "#sequence-dock", "#atomworks-studio-popover", "#viewer-command-form"]) {
      const node = document.querySelector<HTMLElement>(selector);
      if (node) node.inert = locked;
    }
    document.body.classList.toggle("trajectory-playing", locked);
  }

  private async togglePlayback(url: URL): Promise<void> {
    this.pause();
    this.toggle.disabled = true;
    try {
      if (this.active) {
        await this.restore();
        this.active = false;
        this.controls.hidden = true;
        this.toggle.textContent = "Show trajectory";
        this.toggle.setAttribute("aria-pressed", "false");
        this.lockEditor(false);
        return;
      }
      if (!this.cif) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Cannot load trajectory (${response.status})`);
        this.cif = await response.text();
      }
      this.active = true;
      this.lockEditor(true);
      await this.viewer.clearAllVisuals();
      await this.viewer.loadCif(this.cif, "trajectory");
      if (this.viewer.trajectoryFrameCount < 2) throw new Error("No trajectory frames found");
      this.slider.max = String(this.viewer.trajectoryFrameCount - 1);
      await this.viewer.setTrajectoryFrame(this.viewer.trajectoryFrameCount - 1);
      this.viewer.camera("reset");
      await this.showFrame(0);
      this.controls.hidden = false;
      this.toggle.textContent = "Back to design";
      this.toggle.setAttribute("aria-pressed", "true");
      this.log("Backbone trajectory · predicted clean structures · view only");
    } catch (error) {
      if (this.active) {
        await this.restore();
      }
      this.log(String(error), "error");
      this.active = false;
      this.lockEditor(false);
    } finally {
      this.toggle.disabled = false;
    }
  }

  private async showFrame(index: number): Promise<void> {
    if (this.busy) { this.pendingFrame = index; return; }
    this.busy = true;
    try {
      await this.viewer.setTrajectoryFrame(index);
      this.frame = index;
      this.slider.value = String(index);
      this.label.value = `Frame ${index + 1} / ${this.viewer.trajectoryFrameCount}`;
    } catch (error) {
      this.pause();
      this.log(String(error), "error");
    } finally {
      this.busy = false;
      if (this.pendingFrame !== null) {
        const pending = this.pendingFrame;
        this.pendingFrame = null;
        await this.showFrame(pending);
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.playing || !this.active) return;
    await this.showFrame((this.frame + 1) % this.viewer.trajectoryFrameCount);
    if (this.playing) this.timer = window.setTimeout(() => void this.tick(), 120);
  }
}
