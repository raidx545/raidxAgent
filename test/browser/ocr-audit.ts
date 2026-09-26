import { recognizeImages } from "../../src/offscreen/ocr-engine";
import { captureDom } from "../../src/capture/dom";
import { sanitize } from "../../src/sanitize/sanitize";
import { Vault } from "../../src/vault/vault";
import { verhoeffCheckDigit } from "../../src/pii/checksums";
import type { OcrEngine } from "../../src/pii/ocr";
import type { ScreenshotMeta } from "../../src/capture/types";

/**
 * Does any PII survive the screenshot redaction?
 *
 * Every other OCR test asks whether a detector fires. This one asks the only
 * question that matters to the user: after the whole pipeline has run - the
 * real capture, the real Tesseract, the real detectors and the real painter -
 * can the private values still be read out of the image that would be sent?
 *
 * The page is a set of pictures drawn the way real pages draw them: an ID card
 * with its labels above the values, a dark banner, small grey print, a
 * passport's machine-readable lines, an OTP message, a bank slip, a blurred
 * scan. The redacted screenshot is then read again by a *stronger* reader than
 * the pipeline uses - enlarged, and in inverted and high-contrast variants -
 * because the vision model on the other end reads small, faint and light-on-
 * dark text far better than Tesseract at 1x. Anything that reader finds is a
 * leak.
 *
 * Serve dist/ over http and open ocr-audit.html; the result is in
 * `window.__AUDIT__`.
 */

interface Case {
  id: string;
  /** How the picture is put on the page. */
  as: "img" | "canvas" | "bg";
  w: number;
  h: number;
  bg: string;
  fg: string;
  font: string;
  /** Lines, or [text, x] pairs for text placed in columns. */
  lines: (string | [string, number])[];
  lineH: number;
  /** Values that must not be readable afterwards. */
  secrets: string[];
  /** Ordinary words that must still be readable - over-redaction is a failure too. */
  keep?: string[];
  blur?: boolean;
  rotate?: number;
  /** Further rows of column-placed text, below the first. */
  extra?: [string, number][][];
}

const aadhaar = (() => {
  const payload = "23456789012";
  return `${payload}${verhoeffCheckDigit(payload)}`.replace(/(\d{4})(?=\d)/g, "$1 ");
})();

const CASES: Case[] = [
  {
    id: "id-card", keep: ["GOVERNMENT OF INDIA", "Aadhaar No"], as: "canvas", w: 560, h: 250, bg: "#eef4ea", fg: "#1a1a1a",
    font: "20px Arial", lineH: 36,
    lines: ["GOVERNMENT OF INDIA", "Name: RAHUL VERMA", "DOB: 14/08/1991", "S/O Ram Kumar Verma", "Aadhaar No.", aadhaar],
    secrets: ["RAHUL VERMA", "14/08/1991", "Ram Kumar Verma", aadhaar],
  },
  {
    id: "dark-banner", keep: ["WhatsApp us"], as: "img", w: 620, h: 70, bg: "#0f1115", fg: "#f5f5f5",
    font: "bold 26px Arial", lineH: 40,
    lines: ["WhatsApp us: 98765 43210"],
    secrets: ["98765 43210"],
  },
  {
    id: "small-grey", as: "img", w: 420, h: 30, bg: "#ffffff", fg: "#8a8a8a",
    font: "11px Arial", lineH: 16,
    lines: ["Contact priya.sharma@example.in for help"],
    secrets: ["priya.sharma@example.in"],
  },
  {
    id: "bank-slip", keep: ["Account Number", "IFSC"], as: "canvas", w: 520, h: 210, bg: "#ffffff", fg: "#222222",
    font: "19px Arial", lineH: 34,
    lines: ["Account Number", "50100234567891", "IFSC", "HDFC0001234", "Account Holder: Anita Desai"],
    secrets: ["50100234567891", "HDFC0001234", "Anita Desai"],
  },
  {
    id: "otp-sms", keep: ["Do not share it"], as: "img", w: 560, h: 60, bg: "#e7f7e9", fg: "#111111",
    font: "18px Arial", lineH: 30,
    lines: ["Your OTP for login is 482913. Do not share it."],
    secrets: ["482913"],
  },
  {
    id: "passport", keep: ["Passport No"], as: "canvas", w: 700, h: 170, bg: "#f7f3e8", fg: "#111111",
    font: "20px 'Courier New', monospace", lineH: 34,
    lines: ["Passport No.", "J8369854", "P<INDSHARMA<<PRIYA<<<<<<<<<<<<<<<<<<<<<<<<<", "J8369854<4IND9001014F2601012<<<<<<<<<<<<<<04"],
    secrets: ["J8369854", "SHARMA<<PRIYA", "9001014"],
  },
  {
    id: "columns", as: "canvas", w: 640, h: 50, bg: "#ffffff", fg: "#111111",
    font: "19px Arial", lineH: 30,
    lines: [["Account No", 16], ["50100987654321", 420]],
    secrets: ["50100987654321"],
  },
  {
    id: "licence", keep: ["DL No"], as: "img", w: 520, h: 50, bg: "#fdf6e3", fg: "#202020",
    font: "19px Arial", lineH: 30,
    lines: ["DL No: MH12 20110012345"],
    secrets: ["MH12 20110012345"],
  },
  {
    id: "address", as: "canvas", w: 560, h: 130, bg: "#ffffff", fg: "#222222",
    font: "18px Arial", lineH: 32,
    lines: ["Address:", "Flat 4B, 17/2 Brigade Road,", "Bengaluru, Karnataka 560025"],
    secrets: ["17/2 Brigade Road", "560025"],
  },
  {
    id: "secrets", keep: ["API key", "Password"], as: "img", w: 620, h: 80, bg: "#1e1e1e", fg: "#d4d4d4",
    font: "17px 'Courier New', monospace", lineH: 30,
    lines: ["API key: sk-live-4f9a8b7c6d5e4f3a2b1c0d9e", "Password: Tiger@2024!"],
    secrets: ["sk-live-4f9a8b7c6d5e4f3a2b1c0d9e", "Tiger@2024!"],
  },
  {
    id: "blurred-scan", as: "img", w: 460, h: 44, bg: "#ffffff", fg: "#333333",
    font: "15px Georgia", lineH: 26, blur: true,
    lines: ["PAN: BNZPM2501F  Mob 9123456780"],
    secrets: ["BNZPM2501F", "9123456780"],
  },
  {
    id: "faint-upi", as: "img", w: 500, h: 44, bg: "#ffffff", fg: "#c4c4c4",
    font: "17px Arial", lineH: 26,
    lines: ["Pay to priya.sharma@okhdfcbank"],
    secrets: ["priya.sharma@okhdfcbank"],
  },
  {
    id: "tilted", keep: ["Card", "exp"], as: "canvas", w: 520, h: 70, bg: "#ffffff", fg: "#111111",
    font: "20px Arial", lineH: 30, rotate: -3,
    lines: ["Card 4111 1111 1111 1111 exp 09/28"],
    secrets: ["4111 1111 1111 1111"],
  },
  {
    // A name no detector can know except by the page having named it.
    id: "known-name", keep: ["Signed"], as: "img", w: 360, h: 44, bg: "#ffffff", fg: "#111111",
    font: "18px Arial", lineH: 26,
    lines: ["Signed: KAVYA IYER"],
    secrets: ["KAVYA IYER"],
  },
  {
    id: "css-background", keep: ["Helpline", "Mon-Sat"], as: "bg", w: 560, h: 50, bg: "#f0f4ff", fg: "#1b2a4a",
    font: "18px Arial", lineH: 30,
    lines: ["Helpline +91-80-4567-8901 (Mon-Sat)"],
    secrets: ["+91-80-4567-8901"],
  },
  {
    id: "chat-screenshot", keep: ["if the form asks for it"], as: "img", w: 640, h: 110, bg: "#ffffff", fg: "#202124",
    font: "16px Arial", lineH: 26,
    lines: ["Hi Rohan, my new number is 8899776655 and", "my email is rohan.k@gmail.com. My PAN is", "ABCPK1234L if the form asks for it."],
    secrets: ["8899776655", "rohan.k@gmail.com", "ABCPK1234L"],
  },
  {
    id: "noisy-photo", as: "canvas", w: 520, h: 60, bg: "noise", fg: "#101010",
    font: "bold 20px Arial", lineH: 30,
    lines: ["Aadhaar: " + aadhaar],
    secrets: [aadhaar],
  },
  {
    id: "table", keep: ["Name", "Mobile"], as: "img", w: 520, h: 100, bg: "#ffffff", fg: "#111111",
    font: "17px Arial", lineH: 28,
    lines: [["Name", 12], ["Mobile", 300]],
    extra: [[["Arjun Mehta", 12], ["9876012345", 300]], [["Neha Kapoor", 12], ["7011223344", 300]]],
    secrets: ["Arjun Mehta", "9876012345", "Neha Kapoor", "7011223344"],
  },
  {
    id: "tiny-print", as: "img", w: 360, h: 22, bg: "#ffffff", fg: "#555555",
    font: "9px Arial", lineH: 12,
    lines: ["Registered to meera.nair@example.co.in"],
    secrets: ["meera.nair@example.co.in"],
  },
];

// Thirteen harmless pictures, bigger than the last case, to see what happens
// past the region cap: the last one is the smallest and carries a phone.
const DECOYS = 13;
CASES.push({
  id: "past-the-cap", as: "img", w: 300, h: 40, bg: "#ffffff", fg: "#111111",
  font: "18px Arial", lineH: 26,
  lines: ["Call 9988776655 now"],
  secrets: ["9988776655"],
});

function drawCase(c: Case): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = c.w;
  canvas.height = c.h;
  const ctx = canvas.getContext("2d")!;
  if (c.bg === "noise") {
    // A photo behind the text: every pixel a different mid-tone.
    const image = ctx.createImageData(c.w, c.h);
    for (let i = 0; i < image.data.length; i += 4) {
      const v = 150 + Math.floor(Math.random() * 90);
      image.data[i] = v; image.data[i + 1] = v - 20; image.data[i + 2] = v - 40; image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  } else {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, c.w, c.h);
  }
  if (c.rotate) {
    ctx.translate(c.w / 2, c.h / 2);
    ctx.rotate((c.rotate * Math.PI) / 180);
    ctx.translate(-c.w / 2, -c.h / 2);
  }
  ctx.fillStyle = c.fg;
  ctx.font = c.font;
  ctx.textBaseline = "top";
  const pad = 12;
  let row = 0;
  for (const line of c.lines) {
    if (Array.isArray(line)) ctx.fillText(line[0], line[1], pad);
    else ctx.fillText(line, pad, pad + row++ * c.lineH);
  }
  (c.extra ?? []).forEach((cells, i) => {
    for (const [text, x] of cells) ctx.fillText(text, x, pad + (i + 1) * c.lineH);
  });
  if (!c.blur) return canvas;
  // A scan: downsampled and blown back up, the way a phone photo of a card is.
  const small = document.createElement("canvas");
  small.width = Math.round(c.w * 0.55);
  small.height = Math.round(c.h * 0.55);
  small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
  const out = document.createElement("canvas");
  out.width = c.w;
  out.height = c.h;
  const octx = out.getContext("2d")!;
  octx.imageSmoothingEnabled = true;
  octx.drawImage(small, 0, 0, c.w, c.h);
  return out;
}

async function toDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

/** Places every case on the page and returns what paints each one. */
async function layout(): Promise<Map<Element, CanvasImageSource>> {
  const sources = new Map<Element, CanvasImageSource>();
  document.body.innerHTML = "";
  document.body.style.cssText = "margin:0;padding:16px;font:14px Arial;background:#fff";
  // The page names Kavya Iyer in its own markup, as a mail client names a sender.
  const who = document.createElement("p");
  who.innerHTML = `From <span data-email="kavya.iyer@example.in">Kavya Iyer</span>`;
  document.body.appendChild(who);

  const add = (c: Case, id: string): void => {
    const picture = drawCase(c);
    let el: HTMLElement;
    if (c.as === "canvas") {
      el = picture;
    } else if (c.as === "img") {
      const img = document.createElement("img");
      img.src = picture.toDataURL("image/png");
      img.width = c.w;
      img.height = c.h;
      img.alt = "";
      el = img;
    } else {
      el = document.createElement("div");
      el.style.cssText = `width:${c.w}px;height:${c.h}px;background-image:url(${picture.toDataURL()})`;
    }
    el.id = id;
    el.style.display = "block";
    el.style.margin = "6px 0";
    document.body.appendChild(el);
    sources.set(el, picture);
  };

  for (const c of CASES.slice(0, -1)) add(c, `pic-${CASES.indexOf(c)}`);
  for (let i = 0; i < DECOYS; i++) {
    add({ id: `decoy-${i}`, as: "img", w: 320, h: 60, bg: `hsl(${i * 27} 40% 85%)`, fg: "#000",
      font: "16px Arial", lineH: 20, lines: [], secrets: [] }, `filler-${i}`);
  }
  const last = CASES[CASES.length - 1];
  add(last, `pic-${CASES.length - 1}`);
  // Not img.decode(): it never settles in a hidden document.
  await Promise.all([...document.images].map((img) => img.complete ? undefined : new Promise((resolve) => {
    img.onload = img.onerror = resolve;
    setTimeout(resolve, 3000);
  })));
  return sources;
}

/** The whole page as a screenshot, at device pixel ratio, from real element boxes. */
async function screenshot(sources: Map<Element, CanvasImageSource>): Promise<ScreenshotMeta> {
  const dpr = devicePixelRatio || 1;
  const width = document.documentElement.scrollWidth;
  const height = document.documentElement.scrollHeight;
  const canvas = new OffscreenCanvas(Math.round(width * dpr), Math.round(height * dpr));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [el, source] of sources) {
    const r = el.getBoundingClientRect();
    ctx.drawImage(source, (r.left + scrollX) * dpr, (r.top + scrollY) * dpr, r.width * dpr, r.height * dpr);
  }
  return {
    dataUrl: await toDataUrl(canvas),
    kind: "page",
    scale: dpr,
    originX: 0,
    originY: 0,
    cssWidth: width,
    cssHeight: height,
    tiles: 1,
  };
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9<]/g, "");

/**
 * Reads an image the way a capable vision model would: enlarged, and again
 * inverted and thresholded, so faint and light-on-dark text is read too.
 */
async function strongRead(dataUrl: string, crops: { x: number; y: number; w: number; h: number }[]): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const images: { id: string; dataUrl: string }[] = [];
  let n = 0;
  for (const r of crops) {
    for (const variant of ["plain", "invert", "contrast"] as const) {
      const zoom = 3;
      const c = new OffscreenCanvas(Math.max(1, Math.round(r.w * zoom)), Math.max(1, Math.round(r.h * zoom)));
      const cx = c.getContext("2d")!;
      cx.imageSmoothingQuality = "high";
      cx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      if (variant !== "plain") {
        const data = cx.getImageData(0, 0, c.width, c.height);
        const d = data.data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const mean = sum / (d.length / 4);
        for (let i = 0; i < d.length; i += 4) {
          let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          if (variant === "invert") g = 255 - g;
          else g = g < mean - 8 ? 0 : 255;
          d[i] = d[i + 1] = d[i + 2] = g;
        }
        cx.putImageData(data, 0, 0);
      }
      images.push({ id: `a${n++}`, dataUrl: await toDataUrl(c) });
    }
  }
  bitmap.close();
  const results = await recognizeImages(images);
  return results.flatMap((r) => r.lines.map((l) => l.text)).join("\n");
}

(window as unknown as { __recognize: unknown }).__recognize = recognizeImages;
const stage = (name: string) => { (window as unknown as { __STAGE__: string }).__STAGE__ = name; };

async function run(): Promise<void> {
  stage("layout");
  const sources = await layout();
  stage("capture");
  await new Promise((r) => setTimeout(r, 100));
  const dom = captureDom();
  const shot = await screenshot(sources);
  const engine: OcrEngine = {
    name: "tesseract (audit)",
    available: async () => true,
    recognize: (images) => recognizeImages(images),
  };

  const mode = (new URLSearchParams(location.search).get("mode") ?? "images") as "images" | "full";
  const started = performance.now();
  stage("sanitize");
  const result = await sanitize({ dom, screenshot: shot }, new Vault(),
    // Full size: the audit judges the redaction, not what shrinking hides.
    { burnUnverifiedRegions: true, aggressiveNames: false, ocr: mode, deliverMaxEdge: Infinity }, undefined, engine);
  const pipelineMs = Math.round(performance.now() - started);

  const redacted = result.screenshot?.dataUrl;
  if (!redacted) {
    (window as unknown as { __AUDIT__: unknown }).__AUDIT__ = { error: result.report.screenshotError ?? "no screenshot" };
    return;
  }

  const dpr = shot.scale;
  // Which cases were blacked out whole rather than read - safe, but a
  // canvas-rendered document shown to the model as a black box is useless.
  const burnedWhole = new Set<string>();
  const idOfNode = new Map<number, string>();
  (function walk(x: typeof dom.root) { if (x.attrs.id) idOfNode.set(x.id, x.attrs.id); x.children.forEach(walk); })(dom.root);
  for (const f of result.findings) {
    if (f.shape === "pixel" && f.action === "burn-region" && f.origin !== "ocr") {
      const id = idOfNode.get(f.nodeId);
      if (id?.startsWith("pic-")) burnedWhole.add(CASES[Number(id.slice(4))].id);
    }
  }
  const perCase: Record<string, { leaked: string[]; kept: string[]; burnedWhole?: boolean; unreadableBefore?: string[] }> = {};
  const leakedAll: string[] = [];
  const overRedacted: string[] = [];
  for (const c of CASES) {
    const el = document.getElementById(`pic-${CASES.indexOf(c)}`)!;
    const r = el.getBoundingClientRect();
    const box = { x: (r.left + scrollX) * dpr, y: (r.top + scrollY) * dpr, w: r.width * dpr, h: r.height * dpr };
    const text = norm(await strongRead(redacted, [box]));
    const leaked = c.secrets.filter((s) => text.includes(norm(s)));
    const lost = (c.keep ?? []).filter((k) => !text.includes(norm(k)));
    overRedacted.push(...lost.map((k) => `${c.id}: ${k}`));
    perCase[c.id] = { leaked, kept: c.secrets.filter((s) => !leaked.includes(s)) };
    leakedAll.push(...leaked.map((s) => `${c.id}: ${s}`));
  }

  // The unredacted picture, read the same way: a secret the strong reader
  // cannot see even before redaction says nothing about the pipeline.
  stage("audit-before");
  const readable: string[] = [];
  for (const c of CASES) {
    const el = document.getElementById(`pic-${CASES.indexOf(c)}`)!;
    const r = el.getBoundingClientRect();
    const text = norm(await strongRead(shot.dataUrl, [{ x: (r.left + scrollX) * dpr, y: (r.top + scrollY) * dpr, w: r.width * dpr, h: r.height * dpr }]));
    for (const s of c.secrets) if (text.includes(norm(s))) readable.push(`${c.id}: ${s}`);
    const unreadable = c.secrets.filter((s) => !text.includes(norm(s)));
    if (unreadable.length) perCase[c.id].unreadableBefore = unreadable;
    if (burnedWhole.has(c.id)) perCase[c.id].burnedWhole = true;
  }

  const redactedImg = document.createElement("img");
  redactedImg.src = redacted;
  redactedImg.style.cssText = "width:100%;border:2px solid red";
  document.body.prepend(redactedImg);

  (window as unknown as { __AUDIT__: unknown }).__AUDIT__ = {
    mode,
    pipelineMs,
    ocr: { ...result.report.ocr, linesText: undefined },
    secretsTotal: CASES.reduce((n, c) => n + c.secrets.length, 0),
    readableBeforeRedaction: readable.length,
    leaked: leakedAll,
    leakedOfReadable: `${leakedAll.length} / ${readable.length}`,
    burnedWhole: [...burnedWhole],
    keptWordsLost: overRedacted,
    ocrFindings: result.findings.filter((f) => f.origin === "ocr").map((f) => ({
      node: idOfNode.get(f.nodeId) ?? f.nodeId, kind: f.kind, value: f.value, why: f.why, bbox: f.bbox.map(Math.round),
    })),
    keptWordsTotal: CASES.reduce((n, c) => n + (c.keep?.length ?? 0), 0),
    perCase,
    linesRead: result.report.ocr?.linesText,
  };
}

run().catch((error) => {
  (window as unknown as { __AUDIT__: unknown }).__AUDIT__ = { error: String(error?.stack ?? error) };
});
