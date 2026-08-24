import * as esbuild from "esbuild";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Bundles each test with esbuild and runs it in Node.
 *
 * Each test prints one JSON object with a `pass` boolean and a `failures`
 * array; anything else is treated as a crash. Tests that need a browser
 * (canvas redaction) are not here - see the note at the bottom of the README.
 */

const dir = new URL(".", import.meta.url).pathname;
const out = await mkdtemp(join(tmpdir(), "raidx-test-"));

const files = (await readdir(dir)).filter((f) => f.endsWith(".test.ts")).sort();

let failed = 0;

for (const file of files) {
  const name = file.replace(".test.ts", "");
  const bundle = join(out, `${name}.mjs`);

  try {
    await esbuild.build({
      entryPoints: [join(dir, file)],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
  } catch (error) {
    console.log(`FAIL  ${name} — did not compile`);
    console.log(String(error).split("\n").slice(0, 6).join("\n"));
    failed++;
    continue;
  }

  try {
    const { stdout } = await run(process.execPath, [bundle], { maxBuffer: 32 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    if (result.pass) {
      console.log(`ok    ${name}`);
    } else {
      failed++;
      console.log(`FAIL  ${name}`);
      for (const problem of result.failures ?? []) console.log(`        ${problem}`);
    }
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name} — threw`);
    console.log(String(error.stdout ?? error.message).split("\n").slice(0, 8).join("\n"));
  }
}

await rm(out, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n${files.length} suites passed.` : `\n${failed} of ${files.length} suites failed.`,
);
process.exit(failed === 0 ? 0 : 1);
