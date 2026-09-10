import { ocrRegions, ocrScreenshot, type Cropper } from "../src/sanitize/ocr-screenshot";
import { sanitize } from "../src/sanitize/sanitize";
import { Vault } from "../src/vault/vault";
import type { CapturedNode, DomCapture, ScreenshotMeta } from "../src/capture/types";
import type { OcrEngine, OcrImage, OcrResult } from "../src/pii/ocr";
import { verhoeffCheckDigit } from "../src/pii/checksums";

/**
 * What OCR adds, with the engine faked.
 *
 * The recogniser itself is Tesseract in a worker, which Node cannot run; the
 * shipped engine is exercised by dist/ocr-check.html over http. Everything
 * around it - which regions are read, how words become findings, how those
 * findings get tokens that agree with the tree, and what happens when a read
 * fails - is logic, and is pinned here.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 100, 20], visible: true, children: [], ...p,
});

const AADHAAR = "34567890123" + verhoeffCheckDigit("34567890123");

/**
 * A page: a phone in the tree, a product image, a canvas document, a face.
 *
 * Ids are explicit and match the capture's own numbering (root 0, then
 * depth-first) - the fake engine keys its answers on them.
 */
function page(): DomCapture {
  const p = n({ id: 1, tag: "p", role: "paragraph", text: "Helpline 98765 43210", bbox: [20, 20, 300, 20] });
  // A product banner with text baked in; nothing about it says "photo".
  const banner = n({ id: 2, tag: "img", role: "image", attrs: { alt: "summer sale banner" }, bbox: [20, 60, 600, 200] });
  // A canvas-rendered document, currently blacked out on sight.
  const canvas = n({ id: 3, tag: "canvas", role: "canvas", bbox: [20, 300, 800, 400] });
  // A face: burned whole, never read.
  const face = n({ id: 4, tag: "img", role: "image", attrs: { alt: "profile photo" }, bbox: [850, 60, 96, 96] });
  // Too small to hold legible text.
  const icon = n({ id: 5, tag: "img", role: "image", attrs: { alt: "icon" }, bbox: [850, 200, 24, 24] });
  return {
    url: "https://shop.example.in/", origin: "https://shop.example.in", title: "Shop",
    capturedAt: 1,
    viewport: { width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 800 },
    root: n({ id: 0, tag: "body", role: "document", bbox: [0, 0, 1000, 800], children: [p, banner, canvas, face, icon] }),
    stats: { examined: 6, kept: 6, pruned: 0 },
  };
}

const shot: ScreenshotMeta = {
  dataUrl: "data:image/png;base64,",
  kind: "viewport",
  originX: 0,
  originY: 0,
  scale: 1,
  cssWidth: 1000,
  cssHeight: 800,
  tiles: 1,
};

/**
 * Hands back the requested rectangles unread; the fake engine keys on ids.
 * Reports a zoom of 1 whatever was asked, so the fake engine's coordinates are
 * screenshot pixels - a cropper's zoom is a promise about its own output.
 */
const fakeCrop: Cropper = async (_shot, rects) =>
  rects.map((r) => ({ id: r.id, dataUrl: `crop:${r.id}`, x: r.x, y: r.y, zoom: 1 }));

const word = (text: string, x0: number, y0: number, w: number) =>
  ({ text, x0, y0, x1: x0 + w, y1: y0 + 20, confidence: 90 });

/** The engine "reads" the banner, the canvas, and fails on anything else. */
function fakeEngine(behaviour: { canvasFails?: boolean } = {}): OcrEngine {
  return {
    name: "fake",
    async available() { return true; },
    async recognize(images: OcrImage[]): Promise<OcrResult[]> {
      return images.map((img): OcrResult => {
        if (img.id === "ocr-2") {
          // The banner: the same helpline as the tree, plus an email.
          const words = [word("Order", 10, 100, 60), word("on", 80, 100, 25), word("98765", 115, 100, 60),
            word("43210", 185, 100, 60), word("or", 255, 100, 25), word("sales@example.in", 290, 100, 180)];
          return { id: img.id, ms: 5, lines: [{
            text: words.map((w) => w.text).join(" "), words,
            x0: 10, y0: 100, x1: 470, y1: 120, confidence: 90,
          }] };
        }
        if (img.id === "ocr-3") {
          if (behaviour.canvasFails) return { id: img.id, ms: 5, lines: [], error: "timed out" };
          const words = [word("Aadhaar", 40, 60, 80), word(AADHAAR.slice(0, 4), 130, 60, 50),
            word(AADHAAR.slice(4, 8), 190, 60, 50), word(AADHAAR.slice(8), 250, 60, 50)];
          return { id: img.id, ms: 5, lines: [{
            text: words.map((w) => w.text).join(" "), words,
            x0: 40, y0: 60, x1: 300, y1: 80, confidence: 88,
          }] };
        }
        return { id: img.id, ms: 1, lines: [], error: "unexpected region" };
      });
    },
  };
}

// ------------------------------------------------------- which regions are read

{
  const dom = page();
  const { detect } = await import("../src/pii/detect");
  const { findings } = await detect(dom);
  const regions = ocrRegions(dom, findings);
  const tags = regions.map((r) => `${r.node.tag}#${r.node.id}`);

  want(tags.includes("img#2"), `the banner image is not read: ${tags.join(", ")}`);
  want(tags.includes("canvas#3"), `the canvas is not read: ${tags.join(", ")}`);
  want(!tags.includes("img#4"), "the face is read - it should be burned, not read");
  want(!tags.includes("img#5"), "a 24px icon is read");
  want(regions.find((r) => r.node.tag === "canvas")?.releasable === true,
    "the canvas is not marked releasable");
  want(regions[0].node.tag === "canvas", "the largest region is not read first");
}

// ----------------------------------------------------- what a read turns into

{
  const dom = page();
  const { detect } = await import("../src/pii/detect");
  const { findings } = await detect(dom);
  const out = await ocrScreenshot({
    dom, shot, viewport: dom.viewport, findings, mode: "images", engine: fakeEngine(), crop: fakeCrop,
  });

  const kinds = out.findings.map((f) => `${f.kind}:${f.value}`);
  want(kinds.includes("phone:98765 43210"), `the phone in the banner was not found: ${kinds.join(" | ")}`);
  want(kinds.includes("email:sales@example.in"), "the email in the banner was not found");
  want(kinds.some((k) => k.startsWith("aadhaar:")), "the Aadhaar on the canvas was not found");
  want(out.findings.every((f) => f.shape === "pixel" && f.action === "burn-region" && f.origin === "ocr"),
    "an OCR finding is not a burnable pixel region marked as OCR");

  // Boxes come back in viewport CSS pixels, inside the region they were read from.
  const phone = out.findings.find((f) => f.kind === "phone")!;
  want(phone.bbox[0] >= 20 && phone.bbox[0] + phone.bbox[2] <= 620 && phone.bbox[1] >= 60 && phone.bbox[1] <= 260,
    `the phone's box ${JSON.stringify(phone.bbox)} is outside the banner [20,60,600,200]`);
  // The two words "98765" and "43210" were unioned into one box.
  want(phone.bbox[2] >= 120, `the phone box is only ${phone.bbox[2]}px wide - the two words were not joined`);

  want(out.release.has(3), "the canvas was read but not released from its wholesale burn");
  want(out.report.regionsScanned === 2 && out.report.regionsFailed === 0,
    `scanned ${out.report.regionsScanned}, failed ${out.report.regionsFailed}`);
  want(out.report.spansDetected >= 3, `only ${out.report.spansDetected} spans detected`);
}

// --------------------------------------------- a failed read releases nothing

{
  const dom = page();
  const { detect } = await import("../src/pii/detect");
  const { findings } = await detect(dom);
  const out = await ocrScreenshot({
    dom, shot, viewport: dom.viewport, findings, mode: "images",
    engine: fakeEngine({ canvasFails: true }), crop: fakeCrop,
  });
  want(!out.release.has(3), "a canvas whose read failed was released - it would ship unredacted");
  want(out.report.regionsFailed === 1, "the failed region was not counted");
  want(out.findings.some((f) => f.kind === "phone"), "one failing region stopped the others being used");
}

// ------------------------------- no engine, or mode off: nothing changes hands

{
  const dom = page();
  const { detect } = await import("../src/pii/detect");
  const { findings } = await detect(dom);
  const none = await ocrScreenshot({ dom, shot, viewport: dom.viewport, findings, mode: "images", crop: fakeCrop });
  want(none.findings.length === 0 && none.release.size === 0, "without an engine something was still produced");
  const off = await ocrScreenshot({ dom, shot, viewport: dom.viewport, findings, mode: "off", engine: fakeEngine(), crop: fakeCrop });
  want(off.findings.length === 0 && off.report.regionsScanned === 0, "mode off still read regions");
}

// ------------------------------- through the whole pipeline: tokens agree

{
  const vault = new Vault();
  const dom = page();
  const result = await sanitize(
    { dom, screenshot: shot },
    vault,
    { burnUnverifiedRegions: true, aggressiveNames: false, ocr: "images" },
    undefined,
    fakeEngine(),
    fakeCrop,
  );

  // The tree's helpline and the banner's helpline must share a token.
  const treePhone = result.findings.find((f) => f.shape === "text" && f.kind === "phone");
  const imagePhone = result.findings.find((f) => f.origin === "ocr" && f.kind === "phone");
  want(!!treePhone && !!imagePhone, "the phone was not found in both the tree and the picture");

  const entries = vault.view();
  const phoneTokens = entries.filter((e) => e.kind === "phone").map((e) => e.token);
  want(phoneTokens.length === 1,
    `the same phone in tree and picture minted ${phoneTokens.length} tokens - they must be one join key`);

  // The canvas burn was lifted, and the OCR findings are in the sanitized set.
  const canvasBurn = result.findings.find((f) => f.nodeId === 3 && f.shape === "pixel" && !f.origin);
  want(canvasBurn?.action === "none", `the canvas is still ${canvasBurn?.action ?? "missing"} after a successful read`);
  want(result.report.ocr?.regionsReleased === 1, "the report does not show the canvas released");

  // Node has no canvas, so the picture itself cannot be painted here - but the
  // collect/replay sequences must have agreed, or sanitize would have thrown.
  want(typeof result.report.screenshotError === "string" || result.screenshot !== undefined,
    "no screenshot and no explanation");
}

console.log(JSON.stringify({ failures: fails, pass: fails.length === 0 }, null, 2));
