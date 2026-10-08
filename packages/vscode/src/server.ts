import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export async function serviceIsHealthy(baseUrl: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL("api/health", baseUrl), {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const health = (await response.json()) as { status?: string; session_store?: string };
    return health.status === "ok" && ["memory", "persistent"].includes(health.session_store ?? "");
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  const socket = createServer();
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      const port = typeof address === "object" && address ? address.port : 0;
      socket.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/** Own one local backend for this extension host, including concurrent Open commands. */
export class StudioServer {
  private child?: ChildProcess;
  private starting?: Promise<URL>;
  private disposed = false;

  constructor(
    private readonly log: (message: string) => void,
    private readonly onExit: () => void = () => {},
    private readonly startupTimeout = 120_000,
  ) {}

  start(command: string, args: string[] = []): Promise<URL> {
    if (this.disposed) return Promise.reject(new Error("Studio is shutting down"));
    if (!this.starting) {
      this.starting = this.launch(command, args).catch(async (error) => {
        await this.stopChild();
        this.starting = undefined;
        throw error;
      });
    }
    return this.starting;
  }

  private async launch(command: string, args: string[]): Promise<URL> {
    const port = await availablePort();
    if (this.disposed) throw new Error("Studio is shutting down");
    const url = new URL(`http://127.0.0.1:${port}/`);
    const argv = [...args, "--vscode", "--host", "127.0.0.1", "--port", String(port)];
    this.log(`Starting ${command} ${argv.join(" ")}\n`);
    const child = spawn(command, argv, {
      cwd: tmpdir(), shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    let failure: Error | undefined;
    let ready = false;
    child.stdout?.on("data", (data: Buffer) => this.log(data.toString()));
    child.stderr?.on("data", (data: Buffer) => this.log(data.toString()));
    child.on("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      failure ??= new Error(`Studio exited (${signal ?? code}). Check the AtomWorks Studio output for details.`);
      this.log(`${failure.message}\n`);
      if (this.child === child) {
        this.child = undefined;
        if (ready) {
          this.starting = undefined;
          if (!this.disposed) this.onExit();
        }
      }
    });
    const deadline = Date.now() + this.startupTimeout;
    while (Date.now() < deadline && !this.disposed) {
      if (failure) throw failure;
      if (await serviceIsHealthy(url)) {
        if (failure) throw failure;
        if (this.disposed) throw new Error("Studio is shutting down");
        ready = true;
        return url;
      }
      await delay(200);
    }
    throw new Error(this.disposed ? "Studio is shutting down" : "Studio did not become ready within two minutes.");
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try { await stopped; } finally { clearTimeout(timeout); }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopChild();
  }
}
