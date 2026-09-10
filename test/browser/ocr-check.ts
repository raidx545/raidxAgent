import { recognizeImages } from "../../src/offscreen/ocr-engine";
import { correctIdentifiers } from "../../src/pii/ocr-correct";
import { scanText } from "../../src/pii/detect";

/**
 * Does the shipped OCR engine actually read text?
 *
 * Draws a phone number, an email address and an Aadhaar-shaped number onto a
 * canvas at the sizes a real page would show them, hands the picture to the
 * same `recognizeImages` the offscreen document calls, and checks the words
 * came back with sensible boxes. Serve dist/ over http and open this page;
 * the result is in `window.__OCR__`.
 */

const SAMPLES = [
  { label: "phone", text: "Call +91 98765 43210 today" },
  { label: "email", text: "priya.sharma@example.in" },
  { label: "aadhaar", text: "Aadhaar 3456 7890 1238" },
  { label: "prose", text: "Invoice for Sharma Traders Pvt Ltd" },
  // Structured identifiers: the shapes OCR confuses letters and digits in.
  { label: "pan", text: "PAN AAACR5055K" },
  { label: "pan-spaced", text: "PAN: BNZPM 2501 F" },
  { label: "ifsc", text: "IFSC SBIN0001234" },
  { label: "gstin", text: "GSTIN 27AAACR5055K1Z7" },
  { label: "vehicle", text: "Reg MH 12 AB 1234" },
];

/**
 * Two renders. "clean" is the best case: 22px Arial, black on white. "hard"
 * is what a real page looks like - 14px, grey on a tinted background, in a
 * serif - and is where OCR starts confusing letters and digits.
 */
function paint(hard: boolean): { dataUrl: string; width: number; height: number } {
  const width = 640;
  const rowH = hard ? 30 : 44;
  const height = 40 + SAMPLES.length * rowH;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = hard ? "#f3efe6" : "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = hard ? "#5a5a5a" : "#111111";
  ctx.font = hard ? "14px Georgia, 'Times New Roman', serif" : "22px Arial, Helvetica, sans-serif";
  ctx.textBaseline = "top";
  SAMPLES.forEach((s, i) => ctx.fillText(s.text, 24, 20 + i * rowH));
  document.body.appendChild(canvas);
  return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

/** Which identifiers the pipeline recovers from what OCR read. */
async function recovered(lines: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    for (const f of await scanText(line)) if (f.value) out[f.kind] ??= f.value;
    for (const c of correctIdentifiers(line)) out[c.kind] ??= c.value + (c.corrections ? ` (corrected from ${c.read})` : "");
  }
  return out;
}

async function run(): Promise<void> {
  const picture = paint(false);
  const hardPicture = paint(true);
  const started = performance.now();
  const [result, hardResult] = await recognizeImages([
    { id: "check", dataUrl: picture.dataUrl },
    { id: "hard", dataUrl: hardPicture.dataUrl },
  ]);
  const elapsed = Math.round(performance.now() - started);

  const lines = result.lines.map((l) => l.text);
  const hardLines = hardResult.lines.map((l) => l.text);

  // The real question: on the hard render, does the pipeline end up with the
  // right identifiers, whatever OCR read along the way?
  const hardRecovered = await recovered(hardLines);
  const EXPECT: Record<string, string> = {
    pan: "AAACR5055K", ifsc: "SBIN0001234", gstin: "27AAACR5055K1Z7", aadhaar: "3456 7890 1238",
  };
  const hardChecks = Object.entries(EXPECT).map(([kind, value]) => ({
    kind, expected: value, got: hardRecovered[kind] ?? null,
    found: (hardRecovered[kind] ?? "").replace(/\s+/g, "").startsWith(value.replace(/\s+/g, "")),
  }));
  const joined = lines.join("\n");
  const norm = (t: string): string => t.replace(/\s+/g, "");

  const checks = SAMPLES.map((s) => {
    // Digits and addresses must come back exactly; prose may lose a glyph.
    const exact = norm(joined).includes(norm(s.text));
    const loose = s.label === "prose"
      ? lines.some((l) => l.toLowerCase().includes("sharma"))
      : exact;
    return { label: s.label, expected: s.text, found: exact || loose, exact };
  });

  const boxesSane = result.lines.every((l) =>
    l.words.every((w) => w.x1 > w.x0 && w.y1 > w.y0 && w.x1 <= picture.width && w.y1 <= picture.height),
  );

  (window as unknown as { __OCR__: unknown }).__OCR__ = {
    pass: !result.error && checks.every((c) => c.found) && boxesSane && hardChecks.every((c) => c.found),
    error: result.error ?? hardResult.error,
    elapsedMs: elapsed,
    lines,
    checks,
    hard: { lines: hardLines, checks: hardChecks, words: hardResult.lines.flatMap((l) => l.words.map((w) => `${w.text} (${Math.round(w.confidence)})`)) },
    boxesSane,
    words: result.lines.flatMap((l) => l.words.map((w) => `${w.text} (${Math.round(w.confidence)})`)),
  };

  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre>${JSON.stringify((window as unknown as { __OCR__: unknown }).__OCR__, null, 2)}</pre>`,
  );
}

void run().catch((error) => {
  (window as unknown as { __OCR__: unknown }).__OCR__ = { pass: false, crashed: String(error) };
  document.body.textContent = `OCR check crashed: ${String(error)}`;
});
