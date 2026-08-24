import * as esbuild from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";

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

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.log("watching…");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  await buildSelfTest();
  console.log("\n  dist/selftest.html  — open in Chrome to test canvas redaction");
}
