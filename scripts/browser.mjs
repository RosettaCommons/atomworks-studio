import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export const chromiumArgs = [
  "--no-sandbox",
  "--disable-gpu-sandbox",
  "--enable-unsafe-webgpu",
  ...(process.platform === "linux" && process.env.CI ? [
    "--enable-features=Vulkan",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--use-vulkan=swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--disable-vulkan-surface",
    "--enable-unsafe-swiftshader",
  ] : []),
];

export function chromiumLaunchOptions() {
  return {
    executablePath: chromiumExecutable(),
    // Linux headless Chrome can render WebGPU while capturing a black canvas.
    // CI supplies Xvfb so visual assertions inspect the presented frame.
    headless: !(process.platform === "linux" && process.env.DISPLAY),
    args: chromiumArgs,
  };
}

export function chromiumExecutable() {
  if (process.env.CI && !process.env.CHROME_PATH) {
    const require = createRequire(new URL("../packages/web/package.json", import.meta.url));
    return require("playwright-core").chromium.executablePath();
  }
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error("Chrome or Chromium was not found; set CHROME_PATH to its executable.");
  }
  return executable;
}
