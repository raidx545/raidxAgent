import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

// Static assets are copied verbatim; only the TS entrypoints get bundled.
await cp("src/manifest.json", "dist/manifest.json");
await cp("src/sidepanel/index.html", "dist/sidepanel.html");
await cp("src/sidepanel/styles.css", "dist/styles.css");
await cp("src/options/index.html", "dist/options.html");
await cp("src/inspector/index.html", "dist/inspector.html");
await cp("src/offscreen/vault-host.html", "dist/vault-host.html");
await cp("src/wirelog/index.html", "dist/wirelog.html");
await cp("src/inspector/inspector.css", "dist/inspector.css");
await cp("icons", "dist/icons", { recursive: true });

/**
 * Tesseract ships as three pieces that must all be inside the extension:
 * Manifest V3 forbids loading any of them from a CDN. The worker script, the
 * wasm cores (Tesseract picks SIMD, relaxed-SIMD or plain at runtime, so all
 * three LSTM builds go in), and the English language data.
 */
await mkdir("dist/tesseract/lang", { recursive: true });
await cp("node_modules/tesseract.js/dist/worker.min.js", "dist/tesseract/worker.min.js");
for (const core of [
  "tesseract-core-simd-lstm",
  "tesseract-core-relaxedsimd-lstm",
  "tesseract-core-lstm",
]) {
  await cp(`node_modules/tesseract.js-core/${core}.wasm.js`, `dist/tesseract/${core}.wasm.js`);
  await cp(`node_modules/tesseract.js-core/${core}.wasm`, `dist/tesseract/${core}.wasm`);
}
await cp("assets/tessdata/eng.traineddata.gz", "dist/tesseract/lang/eng.traineddata.gz");

/**
 * The Anthropic SDK statically imports node:fs / node:path for its file-based
 * credential chain (profiles, identity-token files). None of that can run in a
 * browser and none of it executes when the client is constructed with an
 * explicit apiKey, so we resolve those specifiers to an empty module rather
 * than shipping a Node polyfill.
 */
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

const shared = {
  outdir: "dist",
  bundle: true,
  platform: "browser",
  plugins: [stubNodeBuiltins],
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

const builds = [
  // Service worker and the two extension pages load as ES modules.
  {
    ...shared,
    format: "esm",
    entryPoints: {
      "service-worker": "src/background/service-worker.ts",
      sidepanel: "src/sidepanel/sidepanel.ts",
      options: "src/options/options.ts",
      inspector: "src/inspector/inspector.ts",
      "vault-host": "src/offscreen/vault-host.ts",
      wirelog: "src/wirelog/wirelog.ts",
    },
  },
  // Content scripts are not modules in MV3 — must be a self-contained IIFE.
  {
    ...shared,
    format: "iife",
    entryPoints: { content: "src/content/content.ts" },
  },
];

/**
 * A self-contained page that runs the canvas-redaction half of the layer in a
 * real browser, since Node has no OffscreenCanvas. Everything is inlined so it
 * can be opened straight from disk with no extension and no server.
 */
async function buildSelfTest() {
  const bundle = await esbuild.build({
    entryPoints: ["test/browser/selftest.ts"],
    bundle: true,
    write: false,
    format: "iife",
    target: "chrome120",
    logLevel: "silent",
  });
  const js = bundle.outputFiles[0].text;
  await writeFile(
    "dist/selftest.html",
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>RAIDX sanitization self-test</title></head>
<body><p>Running…</p><script>${js}</script></body>
</html>`,
  );
}

/**
 * A page that runs the real Tesseract engine against text it draws itself.
 *
 * The extension cannot be loaded by a test harness, but the engine module
 * resolves its assets relative to the page when there is no chrome.runtime -
 * so serving dist/ over http and opening this page exercises the exact bundle,
 * worker, wasm core and language data the extension ships.
 */
async function buildOcrCheck() {
  const bundle = await esbuild.build({
    entryPoints: ["test/browser/ocr-check.ts"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    logLevel: "silent",
  });
  await writeFile(
    "dist/ocr-check.html",
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>RAIDX OCR check</title></head>
<body><p>Running OCR…</p><script>${bundle.outputFiles[0].text}</script></body>
</html>`,
  );
}

/**
 * The side panel, rendered outside the extension.
 *
 * Chrome will only open the real panel as part of a loaded extension, which
 * makes every visual change to it awkward to check. This page loads the real
 * stylesheet and the real transcript view and plays a scripted task through
 * them.
 */
async function buildPanelPreview() {
  const bundle = await esbuild.build({
    entryPoints: ["test/browser/panel-preview.ts"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    logLevel: "silent",
  });

  const shell = (await readFile("src/sidepanel/index.html", "utf8"))
    // The real panel loads a module that talks to the extension; this one does
    // not, so its script is swapped for the scripted run.
    .replace(
      '<script type="module" src="sidepanel.js"></script>',
      `<script>${bundle.outputFiles[0].text}</script>`,
    )
    .replace("<title>RAIDX Agent</title>", "<title>RAIDX panel preview</title>");

  await writeFile("dist/panel-preview.html", shell);
}

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log("watching…");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  await buildSelfTest();
  await buildOcrCheck();
  await buildPanelPreview();
  console.log("\n  dist/selftest.html      — open in Chrome to test canvas redaction");
  console.log("  dist/ocr-check.html     — serve dist/ over http to test the OCR engine");
  console.log("  dist/panel-preview.html — the side panel, with a scripted run");
}
