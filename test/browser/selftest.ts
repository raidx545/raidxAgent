import { sanitize } from "../../src/sanitize/sanitize";
import { Vault } from "../../src/vault/vault";
import { captureDom } from "../../src/capture/dom";
import { spanRects } from "../../src/capture/spans";
import { act } from "../../src/content/act";
import { detect } from "../../src/pii/detect";
import { verhoeffCheckDigit } from "../../src/pii/checksums";
import type { Capture, ScreenshotMeta } from "../../src/capture/types";

/**
 * The half of the layer Node cannot test.
 *
 * Canvas redaction needs a real `OffscreenCanvas`, so `npm test` can only reach
 * the text side. This page runs the full pipeline in a browser against a page
 * it builds itself, then reads the output pixels back to confirm the regions
 * were actually destroyed - not merely reported as destroyed.
 *
 * Open `dist/selftest.html` in any Chrome tab. No extension required.
 */

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  /** Show the detail even when the check passes - for measurements. */
  showDetailOnPass?: boolean;
}

const checks: Check[] = [];
const check = (name: string, pass: boolean, detail = "", showDetailOnPass = false) =>
  checks.push({ name, pass, detail, showDetailOnPass });

/**
 * The test controls its own canvas dimensions rather than reading the window.
 *
 * Headless and background contexts report `innerWidth: 0`, which would size a
 * canvas at zero and crash before a single check ran. Element geometry from
 * getBoundingClientRect is still exact in those contexts, so only the frame
 * needs a floor.
 */
const VIEW_W = () => Math.max(innerWidth, 900);
const VIEW_H = () => Math.max(innerHeight, 700);

/** Colours we can count afterwards to prove pixels are gone. */
const FACE = "#ff00ff";
const SIGNATURE = "#00ff00";
const CONTROL = "#0000ff";

/** Builds a page with real PII and real coloured regions, then captures it. */
function buildPage(): HTMLElement {
  const payload = "34567890123";
  const aadhaar = payload + verhoeffCheckDigit(payload);

  const host = document.createElement("div");
  host.id = "fixture";
  host.innerHTML = `
    <form>
      <label for="st-pw">Password</label>
      <input id="st-pw" type="password" autocomplete="current-password" value="hunter2-not-real">

      <label for="st-name">Full Name</label>
      <input id="st-name" autocomplete="name" value="Priya Sharma">

      <label for="st-mail">Email</label>
      <input id="st-mail" type="email" value="priya.sharma@example.in">
    </form>
    <p id="st-prose">Invoice for Sharma Traders Pvt Ltd. PAN AAACR5055K, Aadhaar ${aadhaar}.</p>
    <p id="st-more">Reach Priya Sharma on +91 98765 43210 at 17/B Nehru Nagar, Pune 411014.</p>
    <img id="st-face" alt="Profile photo of the applicant" width="120" height="120">
    <canvas id="st-sig" aria-label="Signature pad" width="200" height="80"></canvas>
    <div id="st-control"></div>
  `;
  document.body.appendChild(host);

  // A solid-colour image stands in for a face, so its destruction is countable.
  const face = host.querySelector<HTMLImageElement>("#st-face")!;
  face.src =
    "data:image/svg+xml;base64," +
    btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
      <rect width="120" height="120" fill="${FACE}"/></svg>`);

  const sig = host.querySelector<HTMLCanvasElement>("#st-sig")!.getContext("2d")!;
  sig.fillStyle = SIGNATURE;
  sig.fillRect(0, 0, 200, 80);

  const control = host.querySelector<HTMLElement>("#st-control")!;
  control.style.cssText = `width:100px;height:60px;background:${CONTROL}`;

  return host;
}

/**
 * Stands in for `captureVisibleTab`: paints the coloured regions onto a canvas
 * at their real on-page coordinates and at the real device pixel ratio.
 *
 * The point is that the geometry comes from `getBoundingClientRect`, exactly as
 * the extension's would - so if the scale or offset maths is wrong, this fails.
 */
async function fakeScreenshot(): Promise<ScreenshotMeta> {
  const dpr = devicePixelRatio || 1;
  const canvas = new OffscreenCanvas(
    Math.round(VIEW_W() * dpr),
    Math.round(VIEW_H() * dpr),
  );
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const paint = (selector: string, colour: string): void => {
    const el = document.querySelector(selector);
    if (!el) return;
    const r = el.getBoundingClientRect();
    ctx.fillStyle = colour;
    ctx.fillRect(r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr);
  };

  paint("#st-face", FACE);
  paint("#st-sig", SIGNATURE);
  paint("#st-control", CONTROL);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });

  return {
    dataUrl,
    kind: "viewport",
    scale: dpr,
    originX: Math.round(scrollX),
    originY: Math.round(scrollY),
    cssWidth: VIEW_W(),
    cssHeight: VIEW_H(),
    tiles: 1,
  };
}

/** Counts pixels of each marker colour left in an image. */
async function countColours(
  dataUrl: string,
): Promise<{ face: number; signature: number; control: number }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  let face = 0;
  let signature = 0;
  let control = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 200 && g < 60 && b > 200) face++;
    if (r < 60 && g > 200 && b < 60) signature++;
    if (r < 60 && g < 60 && b > 200) control++;
  }
  return { face, signature, control };
}

async function run(): Promise<void> {
  const host = buildPage();
  // Let layout settle and the image decode before measuring anything.
  await new Promise((r) => setTimeout(r, 250));

  const screenshot = await fakeScreenshot();
  const before = await countColours(screenshot.dataUrl);

  check("viewport is real (0x0 means a headless context)",
    innerWidth > 0 && innerHeight > 0,
    `${innerWidth}x${innerHeight} @${devicePixelRatio}x`, true);

  check("marker regions are present before redaction",
    before.face > 1000 && before.signature > 1000 && before.control > 1000,
    JSON.stringify(before), true);

  const capture: Capture = { dom: captureDom(), screenshot };
  const vault = new Vault();
  const result = await sanitize(capture, vault);

  host.remove();

  if (!result.screenshot) {
    check("redaction produced a screenshot", false, result.report.screenshotError ?? "no reason given");
    render(result, before, undefined);
    return;
  }

  const after = await countColours(result.screenshot.dataUrl);

  check("the face region was destroyed", after.face === 0,
    `${before.face} -> ${after.face} pixels`, true);
  check("the signature region was destroyed", after.signature === 0,
    `${before.signature} -> ${after.signature} pixels`, true);
  check("the control region survived untouched",
    Math.abs(after.control - before.control) < before.control * 0.05,
    `${before.control} -> ${after.control} pixels`, true);
  check("regions were reported as burned",
    result.report.redact.regionsBurned >= 2,
    `${result.report.redact.regionsBurned} burned, ` +
      `${result.report.redact.regionsOutsideViewport} below the fold`, true);
  check("pixels burned is plausible",
    result.report.redact.pixelsBurned > 10000,
    `${result.report.redact.pixelsBurned.toLocaleString()} pixels`, true);

  // The text half, on a real DOM rather than a hand-built tree.
  const wire = JSON.stringify(result.dom);
  for (const secret of [
    "hunter2-not-real",
    "priya.sharma@example.in",
    "AAACR5055K",
    "98765 43210",
  ]) {
    check(`"${secret.slice(0, 18)}" does not survive`, !wire.includes(secret));
  }
  check("no residual PII in the sanitized tree",
    result.report.residual.length === 0,
    result.report.residual.map((f) => f.kind).join(", "));
  check("a filled password became a sealed token",
    /<SECRET_\d+>/.test(wire),
    `${result.report.tokenize.fieldsSealed} field(s) sealed`, true);
  check("burned regions minted tokens",
    vault.view().some((e) => e.token.startsWith("<PHOTO") || e.token.startsWith("<SIGNATURE")),
    vault.view().map((e) => e.token).join(" "), true);

  await fullPageScenario();
  await textPixelScenario();
  await actionScenario();
  const demo = await visualDemo();
  render(result, before, after, demo);
}

/**
 * The same pipeline against a *stitched whole-page* image.
 *
 * This is the case the viewport test cannot reach: the image starts at the
 * document origin rather than at the scroll offset, and the regions sit far
 * below the fold. If the document-coordinate projection is wrong by even a
 * scroll offset, the burn lands somewhere else and the marker colours survive -
 * which is exactly what this counts.
 */
async function fullPageScenario(): Promise<void> {
  const dpr = devicePixelRatio || 1;

  const host = document.createElement("div");
  host.innerHTML = `
    <div style="height:1400px"></div>
    <img id="fp-face" alt="Profile photo of the applicant" width="120" height="120">
    <div style="height:600px"></div>
    <canvas id="fp-sig" aria-label="Signature pad" width="200" height="80"></canvas>
    <div style="height:400px"></div>
  `;
  document.body.appendChild(host);

  const face = host.querySelector<HTMLImageElement>("#fp-face")!;
  face.src =
    "data:image/svg+xml;base64," +
    btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
      <rect width="120" height="120" fill="${FACE}"/></svg>`);
  const sigCtx = host.querySelector<HTMLCanvasElement>("#fp-sig")!.getContext("2d")!;
  sigCtx.fillStyle = SIGNATURE;
  sigCtx.fillRect(0, 0, 200, 80);

  await new Promise((r) => setTimeout(r, 250));

  // Scroll somewhere non-zero, so a projection that forgets scrollY is caught.
  window.scrollTo(0, 700);
  await new Promise((r) => setTimeout(r, 120));

  const pageHeight = Math.max(document.documentElement.scrollHeight, VIEW_H());
  const canvas = new OffscreenCanvas(
    Math.round(VIEW_W() * dpr),
    Math.round(pageHeight * dpr),
  );
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Paint at DOCUMENT coordinates, as a stitched capture would.
  const paint = (selector: string, colour: string): void => {
    const el = document.querySelector(selector)!;
    const r = el.getBoundingClientRect();
    ctx.fillStyle = colour;
    ctx.fillRect((r.left + scrollX) * dpr, (r.top + scrollY) * dpr, r.width * dpr, r.height * dpr);
  };
  paint("#fp-face", FACE);
  paint("#fp-sig", SIGNATURE);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });

  const shot: ScreenshotMeta = {
    dataUrl,
    kind: "page",
    scale: dpr,
    originX: 0,
    originY: 0,
    cssWidth: VIEW_W(),
    cssHeight: pageHeight,
    tiles: Math.ceil(pageHeight / VIEW_H()),
  };

  const before = await countColours(dataUrl);
  const dom = captureDom();
  const result = await sanitize({ dom, screenshot: shot }, new Vault());

  host.remove();
  window.scrollTo(0, 0);

  if (!result.screenshot) {
    check("full page: redaction produced an image", false,
      result.report.screenshotError ?? "no reason given");
    return;
  }

  const after = await countColours(result.screenshot.dataUrl);

  check("full page: the below-the-fold face was destroyed", after.face === 0,
    `${before.face} -> ${after.face} pixels at document y~1400`, true);
  check("full page: the below-the-fold signature was destroyed", after.signature === 0,
    `${before.signature} -> ${after.signature} pixels at document y~2100`, true);
  check("full page: nothing was reported as outside the image",
    result.report.redact.regionsOutsideViewport === 0,
    `${result.report.redact.regionsBurned} burned, ` +
      `${result.report.redact.regionsOutsideViewport} outside`, true);
  check("full page: the capture was taken while scrolled away from the top",
    dom.viewport.scrollY > 0,
    `scrollY was ${dom.viewport.scrollY} — proves the projection is not ignoring it`, true);

  await offImageScenario(dom, shot);
}

/**
 * The case that matters most, and the one that was missing entirely.
 *
 * Tokenizing an email in the DOM tree while leaving it legible in the
 * screenshot achieves nothing: both go to the model, and the picture hands the
 * value straight back. This paints a marker colour over exactly the pixels
 * where the detected PII is rendered - measured with the same Range code the
 * redactor relies on - and then counts how many of those pixels survive.
 *
 * Zero is the only acceptable answer.
 */
async function textPixelScenario(): Promise<void> {
  const dpr = devicePixelRatio || 1;
  const MARKER = "#ff00ff";

  const host = document.createElement("div");
  host.style.cssText = "font:16px/1.8 monospace; padding:20px";
  host.innerHTML = `
    <p id="tp-1">Contact priya.sharma@example.in about the invoice.</p>
    <p id="tp-2">Call +91 98765 43210 or write to Sharma Traders Pvt Ltd.</p>
    <p id="tp-3">PAN AAACR5055K is on file.</p>
  `;
  document.body.appendChild(host);
  await new Promise((r) => setTimeout(r, 200));

  const dom = captureDom();

  // Ask the detector what it found, then ask the page where those spans are.
  const found = await detect(dom);
  const textFindings = found.findings.filter(
    (f) => f.shape === "text" && f.action !== "none" && f.action !== "burn-region" && f.span,
  );
  const rects = spanRects(
    textFindings.map((f) => ({
      findingId: f.id,
      nodeId: f.nodeId,
      field: f.field ?? "text",
      start: f.span?.[0],
      end: f.span?.[1],
    })),
  );

  const pageHeight = Math.max(document.documentElement.scrollHeight, VIEW_H());
  const canvas = new OffscreenCanvas(
    Math.round(VIEW_W() * dpr),
    Math.round(pageHeight * dpr),
  );
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Paint the marker exactly where the PII text is rendered. If redaction is
  // even slightly off, these pixels survive and the count is non-zero.
  let painted = 0;
  ctx.fillStyle = MARKER;
  for (const entry of rects) {
    for (const [x, y, w, h] of entry.rects) {
      ctx.fillRect(x * dpr, y * dpr, w * dpr, h * dpr);
      painted += Math.round(w * dpr) * Math.round(h * dpr);
    }
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });

  const shot: ScreenshotMeta = {
    dataUrl,
    kind: "page",
    scale: dpr,
    originX: 0,
    originY: 0,
    cssWidth: VIEW_W(),
    cssHeight: pageHeight,
    tiles: 1,
  };

  const before = await countColours(dataUrl);
  const vault = new Vault();
  const outcome = await sanitize({ dom, screenshot: shot }, vault, undefined, async (requests) =>
    spanRects(requests),
  );

  host.remove();

  check("text pixels: the detector found PII in the prose",
    textFindings.length >= 3,
    `${textFindings.length} span(s): ${textFindings.map((f) => f.kind).join(", ")}`, true);
  check("text pixels: those spans were located on screen",
    rects.every((r) => r.precision === "range"),
    `${rects.filter((r) => r.precision === "range").length}/${rects.length} measured exactly`, true);
  check("text pixels: the marker was actually painted", before.face > 500,
    `${before.face} marker pixels at ${painted} expected`, true);

  if (!outcome.screenshot) {
    check("text pixels: redaction produced an image", false,
      outcome.report.screenshotError ?? "no reason given");
    return;
  }

  const after = await countColours(outcome.screenshot.dataUrl);

  check("text pixels: every PII pixel was destroyed", after.face === 0,
    `${before.face} -> ${after.face} pixels`, true);
  check("text pixels: spans were covered, not skipped",
    outcome.report.redact.textSpansCovered >= 3 &&
      outcome.report.redact.textSpansUnresolved === 0,
    `${outcome.report.redact.textSpansCovered} covered, ` +
      `${outcome.report.redact.textSpansUnresolved} unresolved`, true);

  // The token painted into the image must be the token in the tree, or the
  // model sees two different names for the same thing.
  const wire = JSON.stringify(outcome.dom);
  const emailToken = wire.match(/<EMAIL_\d+>/)?.[0];
  check("text pixels: the tree and the image agree on the token",
    emailToken !== undefined && vault.resolve(emailToken) === "priya.sharma@example.in",
    emailToken ?? "no email token in the tree", true);
}

/**
 * Regions that fall outside the image must be counted, not silently dropped -
 * and, more importantly, must not knock the vault's two passes out of step.
 *
 * The collect pass asks for one seal per burn-region finding. If the redactor
 * skips sealing for a region it cannot draw, the sequences diverge and the
 * replay throws. That is a real bug this scenario caught once, so it stays.
 */
async function offImageScenario(
  dom: ReturnType<typeof captureDom>,
  shot: ScreenshotMeta,
): Promise<void> {
  // Same findings, but an image far too small to contain any of them.
  const tiny: ScreenshotMeta = {
    ...shot,
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" +
      "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    cssWidth: 1,
    cssHeight: 1,
    scale: 1,
  };

  let threw: string | undefined;
  let outcome: Awaited<ReturnType<typeof sanitize>> | undefined;
  try {
    outcome = await sanitize({ dom, screenshot: tiny }, new Vault());
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }

  check("off-image: sanitizing did not throw", threw === undefined, threw ?? "");
  check("off-image: regions were counted as outside the image",
    (outcome?.report.redact.regionsOutsideViewport ?? 0) > 0,
    `${outcome?.report.redact.regionsOutsideViewport ?? 0} outside, ` +
      `${outcome?.report.redact.regionsBurned ?? 0} burned`, true);
  check("off-image: the text half still sanitized cleanly",
    outcome !== undefined && outcome.report.residual.length === 0,
    `${outcome?.report.residual.length ?? "n/a"} residual`, true);
}

/**
 * Actions must resolve against the same ids the planner was shown.
 *
 * The agent used to keep a second, flatter view of the page with its own id
 * space. Once the planner started reading the sanitized capture tree, those two
 * registries would have disagreed and every click would have landed on the
 * wrong element - silently, since both ids are just numbers.
 *
 * There is now one tree and one registry. This drives real actions through it,
 * on a live DOM, and checks the effects rather than the return values.
 */
async function actionScenario(): Promise<void> {
  const host = document.createElement("div");
  host.innerHTML = `
    <label for="ac-in">Search</label>
    <input id="ac-in" type="text" value="">
    <button id="ac-btn" type="button">Run report</button>
    <select id="ac-sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
    <p id="ac-out">untouched</p>
  `;
  document.body.appendChild(host);

  const button = host.querySelector<HTMLButtonElement>("#ac-btn")!;
  let clicked = 0;
  button.addEventListener("click", () => {
    clicked++;
    host.querySelector<HTMLElement>("#ac-out")!.textContent = "clicked";
  });

  await new Promise((r) => setTimeout(r, 150));

  // Capture, then act using the ids the capture produced - the same ids the
  // planner would have been shown.
  const dom = captureDom();
  const nodes: { id: number; tag: string; attrs: Record<string, string> }[] = [];
  const collect = (x: typeof dom.root): void => {
    nodes.push({ id: x.id, tag: x.tag, attrs: x.attrs });
    x.children.forEach(collect);
  };
  collect(dom.root);

  const inputNode = nodes.find((x) => x.attrs.id === "ac-in");
  const buttonNode = nodes.find((x) => x.attrs.id === "ac-btn");
  const selectNode = nodes.find((x) => x.attrs.id === "ac-sel");

  check("actions: the capture contains the controls to act on",
    !!inputNode && !!buttonNode && !!selectNode,
    `input=${inputNode?.id} button=${buttonNode?.id} select=${selectNode?.id}`, true);

  if (!inputNode || !buttonNode || !selectNode) {
    host.remove();
    return;
  }

  const typed = await act({ name: "type" as never, input: { element_id: inputNode.id, text: "quarterly" } });
  const inputEl = host.querySelector<HTMLInputElement>("#ac-in")!;
  check("actions: typing reached the right element",
    typed.ok && inputEl.value === "quarterly",
    `${typed.detail} — value is ${JSON.stringify(inputEl.value)}`, true);

  const clickResult = await act({ name: "click" as never, input: { element_id: buttonNode.id } });
  check("actions: clicking reached the right element",
    clickResult.ok && clicked === 1 &&
      host.querySelector<HTMLElement>("#ac-out")!.textContent === "clicked",
    `${clickResult.detail} — handler fired ${clicked} time(s)`, true);

  const selected = await act({ name: "select" as never, input: { element_id: selectNode.id, option: "Beta" } });
  const selectEl = host.querySelector<HTMLSelectElement>("#ac-sel")!;
  check("actions: selecting reached the right element",
    selected.ok && selectEl.value === "b",
    `${selected.detail} — value is ${JSON.stringify(selectEl.value)}`, true);

  // An id the capture never issued must fail cleanly, not act on something else.
  const bogus = await act({ name: "click" as never, input: { element_id: 99999 } });
  check("actions: an unknown id is refused, not guessed",
    !bogus.ok && /no element/i.test(bogus.detail),
    bogus.detail, true);

  // read_page must return the same shape the planner is rendered from.
  const reread = await act({ name: "read_page" as never, input: {} });
  check("actions: read_page returns a capture, not a stale flat list",
    reread.ok && !!reread.capture && Array.isArray(reread.capture.root.children),
    reread.detail, true);

  host.remove();
}

/**
 * Produces a realistic before/after pair to look at.
 *
 * The other scenarios paint marker colours, which are easy to count and
 * impossible to read. This one draws the page's actual text into the stand-in
 * screenshot at the same coordinates the browser laid it out at, so the
 * redacted result looks like what the model will really be handed.
 */
async function visualDemo(): Promise<{ before: string; after: string } | undefined> {
  const dpr = devicePixelRatio || 1;

  const host = document.createElement("div");
  host.id = "demo";
  host.style.cssText =
    "font:16px/1.9 ui-sans-serif,system-ui,sans-serif; padding:24px; " +
    "background:#fff; color:#111; width:720px";
  host.innerHTML = `
    <p id="d0">Invoice INV-8871 &mdash; Sharma Traders Pvt Ltd</p>
    <p id="d1">Contact priya.sharma@example.in about this invoice.</p>
    <p id="d2">Call +91 98765 43210 during working hours.</p>
    <p id="d3">PAN AAACR5055K, GSTIN 27AAACR5055K1Z7.</p>
    <p id="d4">Ship to 17/B Nehru Nagar, Pune 411014.</p>
    <p id="d5">This line holds nothing sensitive and must stay readable.</p>
  `;
  document.body.appendChild(host);
  await new Promise((r) => setTimeout(r, 200));

  const pageHeight = Math.max(document.documentElement.scrollHeight, VIEW_H());
  const canvas = new OffscreenCanvas(Math.round(VIEW_W() * dpr), Math.round(pageHeight * dpr));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "alphabetic";

  // Draw each line where the browser actually put it, so the redaction
  // rectangles - measured from the same layout - land on the same glyphs.
  for (const el of Array.from(host.querySelectorAll<HTMLElement>("p"))) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize) || 16;
    ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = style.color || "#111";
    const x = (rect.left + scrollX) * dpr;
    const y = (rect.top + scrollY + (rect.height + size * 0.72) / 2) * dpr;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(el.textContent ?? "", x / dpr, y / dpr);
    ctx.restore();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const beforeUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });

  const dom = captureDom();
  const outcome = await sanitize(
    {
      dom,
      screenshot: {
        dataUrl: beforeUrl,
        kind: "page",
        scale: dpr,
        originX: 0,
        originY: 0,
        cssWidth: VIEW_W(),
        cssHeight: pageHeight,
        tiles: 1,
      },
    },
    new Vault(),
    undefined,
    async (requests) => spanRects(requests),
  );

  host.remove();
  if (!outcome.screenshot) return undefined;
  return { before: beforeUrl, after: outcome.screenshot.dataUrl };
}

function render(
  result: Awaited<ReturnType<typeof sanitize>>,
  before: Record<string, number>,
  after: Record<string, number> | undefined,
  demo?: { before: string; after: string },
): void {
  const failed = checks.filter((c) => !c.pass).length;

  (window as unknown as { __RESULT__: unknown }).__RESULT__ = {
    pass: failed === 0,
    checks,
    markerPixels: { before, after },
    report: result.report,
  };

  document.body.innerHTML = `
    <style>
      body { font: 14px/1.6 ui-monospace, monospace; padding: 24px; max-width: 900px; margin: 0 auto; }
      h1 { font-size: 18px; }
      .ok { color: #1a7f4b; } .bad { color: #c8362a; }
      li { margin: 2px 0; } .d { color: #777; }
      img { max-width: 100%; border: 1px solid #ccc; margin-top: 8px; }
    </style>
    <h1 class="${failed === 0 ? "ok" : "bad"}">
      ${failed === 0 ? "All checks passed" : `${failed} check(s) failed`}
    </h1>
    <ul>
      ${checks
        .map(
          (c) =>
            `<li class="${c.pass ? "ok" : "bad"}">${c.pass ? "ok  " : "FAIL"} ${c.name}` +
            // Only show the detail when it explains something: on a pass it is
            // either a measurement worth seeing or the failure text, which
            // would read as a contradiction next to "ok".
            (c.detail && (!c.pass || c.showDetailOnPass)
              ? ` <span class="d">— ${c.detail}</span>`
              : "") +
            `</li>`,
        )
        .join("")}
    </ul>
    ${
      demo
        ? `<h2 style="font-size:15px;margin-top:24px">Before &mdash; never sent</h2>
           <img src="${demo.before}">
           <h2 style="font-size:15px;margin-top:24px">After &mdash; what the model receives</h2>
           <img src="${demo.after}">`
        : ""
    }
    <p class="d" style="margin-top:24px">Image-region redaction (marker colours):</p>
    ${result.screenshot ? `<img src="${result.screenshot.dataUrl}">` : "<p class='bad'>none</p>"}
  `;
}

void run().catch((error) => {
  (window as unknown as { __RESULT__: unknown }).__RESULT__ = {
    pass: false,
    crashed: String(error),
  };
  document.body.textContent = `Self-test crashed: ${String(error)}`;
});
