import { createRequire } from "node:module";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function patinaeWasmAsset(): Plugin {
  return {
    name: "patinae-wasm-asset",
    enforce: "pre",
    transform(code) {
      if (!code.includes("patinae_web_bg.wasm")) return null;
      return {
        code: code.replace(
          /new\s+URL\(\s*["']patinae_web_bg\.wasm["']\s*,\s*import\.meta\.url\s*\)/g,
          "new URL('patinae_web_bg.wasm', (value => value)(import.meta.url))",
        ),
        map: null,
      };
    },
    closeBundle() {
      mkdirSync(resolve("dist/assets"), { recursive: true });
      copyFileSync(
        resolve("node_modules/@baker-laboratory/patinae-viewer/dist/patinae_web_bg.wasm"),
        resolve("dist/assets/patinae_web_bg.wasm"),
      );
    },
  };
}

/**
 * Safari before 16.4 cannot parse regex lookbehind. One such literal sits at the top level of a Markdown helper
 * that Mol* pulls in, and a single unparsable literal stops the whole chunk loading — so the renderer never starts
 * and the editor is blank. `findEmail` already checks the preceding character itself (`previous(match, true)`),
 * so dropping the lookbehind keeps the same matches. Throws if the pattern moves, rather than silently shipping a
 * bundle Safari cannot load.
 */
function safariParsableRegex(): Plugin {
  const MODULE = /mdast-util-gfm-autolink-literal[/\\]lib[/\\]index\.js/;
  const LOOKBEHIND = "/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@";
  let patched = false;
  return {
    name: "studio-safari-parsable-regex",
    transform(code, id) {
      if (!MODULE.test(id)) return null;
      if (!code.includes(LOOKBEHIND)) {
        throw new Error("studio-safari-parsable-regex: lookbehind not found; recheck Safari 16.3 support");
      }
      patched = true;
      return code.replace(LOOKBEHIND, "/([-.\\w+]+)@");
    },
    closeBundle() {
      if (!patched) throw new Error("studio-safari-parsable-regex: never ran; the Markdown helper moved");
    },
  };
}

function versionServiceWorker(): Plugin {
  const rawVersion =
    process.env.ANNOTATION_STUDIO_REVISION
    ?? process.env.ANNOTATION_STUDIO_VERSION
    ?? `development-${Date.now()}`;
  const version = rawVersion.replace(/[^A-Za-z0-9_.-]/g, "-");
  return {
    name: "version-service-worker",
    closeBundle() {
      const path = resolve("dist/sw.js");
      const source = readFileSync(existsSync(path) ? path : resolve("public/sw.js"), "utf-8");
      if (!source.includes("__BUILD_VERSION__")) {
        throw new Error("service worker build-version placeholder is missing");
      }
      mkdirSync(resolve("dist"), { recursive: true });
      writeFileSync(path, source.replaceAll("__BUILD_VERSION__", version));
    },
  };
}

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  // The release an embedder is talking to, read back through window.atomworksStudio.version.
  define: {
    __STUDIO_VERSION__: JSON.stringify(process.env.ANNOTATION_STUDIO_VERSION ?? version),
  },
  plugins: [patinaeWasmAsset(), safariParsableRegex(), versionServiceWorker()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    target: "es2022",
  },
});
