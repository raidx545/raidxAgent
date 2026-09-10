import { sanitize } from "../../src/sanitize/sanitize";
import { Vault } from "../../src/vault/vault";
import { captureDom } from "../../src/capture/dom";
import { spanRects } from "../../src/capture/spans";
import type { OcrEngine } from "../../src/pii/ocr";
import { TranscriptView } from "../../src/sidepanel/transcript";
import { act } from "../../src/content/act";
import { findScroller, scrollState } from "../../src/capture/scroller";
import { renderPage } from "../../src/background/wire";
import { CLICK_START, settle } from "../../src/content/settle";
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
  // Wait for the tab to have a real viewport before measuring anything.
  //
  // A preview pane, a background tab or a just-restored tab reports 0x0 for the
  // first frames after load. Every geometry check below - visibility, scroll
  // heights, element bounds - would then be measuring a page that was never
  // laid out, and would fail for a reason that has nothing to do with the code
  // under test. That is exactly what happened once: a run reported the whole
  // capture as pruned, when the page simply had no size yet.
  for (let i = 0; i < 200 && (innerWidth === 0 || innerHeight === 0); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

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
  await appShellScrollScenario();
  await dialogCaptureScenario();
  await responsivenessScenario();
  await richEditorScenario();
  await backgroundAvatarScenario();
  await ocrRedactionScenario();
  await transcriptScenario();
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
 * Scrolling a page that does not scroll the window.
 *
 * This is the shape of Gmail, Slack and most application shells: the window is
 * pinned at height 100% and a panel inside it holds the long list. Every scroll
 * in this extension used to go to `window.scrollBy`, which on such a page moves
 * nothing at all - while `window.scrollY` stayed 0 and `document.body
 * .scrollHeight` was one viewport tall, so the agent was told it had reached
 * "y=0 (bottom of page)" scrolling *both* directions. Believing the inbox was
 * one screen long and already at its end, it stopped looking and went back to
 * clicking the button it had already clicked.
 *
 * These checks fail on the old code.
 */
async function appShellScrollScenario(): Promise<void> {
  const host = document.createElement("div");
  // Fixed to the viewport and exactly its size: the window has nothing to
  // scroll, which is the whole point.
  host.style.cssText =
    "position:fixed;inset:0;display:flex;flex-direction:column;background:#fff;z-index:9999";
  host.innerHTML = `
    <div style="height:64px;flex:none;background:#eee">Toolbar</div>
    <div id="shell-list" style="flex:1;overflow-y:auto">
      ${Array.from({ length: 400 }, (_, i) =>
        `<div style="height:40px">Row ${i} — subject line ${i}</div>`).join("")}
    </div>`;
  document.body.appendChild(host);
  await new Promise((r) => setTimeout(r, 150));

  const panel = host.querySelector<HTMLElement>("#shell-list")!;

  // -- is the right element identified at all? ------------------------------
  const found = findScroller();
  check("app shell: the scrolling panel is found, not the window",
    found === panel,
    `found <${found.tagName.toLowerCase()}${(found as HTMLElement).id ? "#" + (found as HTMLElement).id : ""}>`,
    true);

  // -- does scrolling move anything? ----------------------------------------
  const down = await act({ name: "scroll" as never, input: { direction: "down" } });
  check("app shell: scrolling down actually moves the page",
    down.ok && panel.scrollTop > 100,
    `${down.detail} — panel.scrollTop is ${Math.round(panel.scrollTop)}`, true);

  // The bug in one line: the old code reported bottom-of-page while at zero.
  check("app shell: a page that did not move is not reported as scrolled",
    !/bottom/i.test(down.detail) || panel.scrollTop > 0,
    down.detail);

  const afterDown = panel.scrollTop;
  const up = await act({ name: "scroll" as never, input: { direction: "up" } });
  check("app shell: scrolling up goes back, and says so",
    up.ok && panel.scrollTop < afterDown,
    `${up.detail} — ${Math.round(afterDown)} → ${Math.round(panel.scrollTop)}`, true);

  // Both directions claiming "bottom of page" is what the real log showed.
  check("app shell: up and down do not both claim the bottom",
    !(/bottom/i.test(down.detail) && /bottom/i.test(up.detail)),
    `down: ${down.detail} / up: ${up.detail}`);

  // -- reaching the end, and knowing it ------------------------------------
  panel.scrollTop = panel.scrollHeight;
  const stuck = await act({ name: "scroll" as never, input: { direction: "down" } });
  check("app shell: scrolling past the end reports that nothing moved",
    stuck.ok && /nothing scrolled|already at/i.test(stuck.detail),
    stuck.detail, true);

  // -- is the planner told the truth about how long the page is? ------------
  panel.scrollTop = 0;
  const state = scrollState();
  check("app shell: the reported page height is the panel's, not the window's",
    state.inner && state.pageHeight > 10000,
    `reported ${state.pageHeight}px (window says ${document.body.scrollHeight}px)`, true);

  // -- and the screenshot frame is left alone ------------------------------
  //
  // viewport.scrollX/scrollY is the coordinate frame every redaction box is
  // expressed in. If reporting the panel's offset had leaked into those, every
  // black box on a Gmail screenshot would land in the wrong place.
  panel.scrollTop = 800;
  const dom = captureDom();
  check("app shell: the screenshot coordinate frame stays the window's",
    dom.viewport.scrollY === Math.round(scrollY) && dom.viewport.contentScrollY === 800,
    `frame scrollY=${dom.viewport.scrollY}, content=${String(dom.viewport.contentScrollY)}`, true);

  host.remove();
}

/**
 * Does the capture carry what the render budget asks it about?
 *
 * The budget gives an open dialog first claim on the four hundred lines a page
 * is allowed, so that clicking "Compose" on an inbox of two thousand rows shows
 * the compose window rather than rows 1-400 of the list behind it. That check
 * reads `aria-modal` off the captured node - and `aria-modal` was not in the
 * list of attributes the capture keeps, so it was always undefined and the
 * branch was half dead. The unit test passed because its fixtures set the
 * attribute by hand; nothing asserted that a real DOM would produce it.
 *
 * This is the seam that test could not see: a real element, through the real
 * capture, into the real render.
 */
async function dialogCaptureScenario(): Promise<void> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;background:#fff;z-index:9999";
  host.innerHTML = `
    <button id="dc-compose">Compose</button>
    <div id="dc-list">
      ${Array.from({ length: 60 }, (_, i) =>
        `<div>Row ${i} — subject ${i}</div>`).join("")}
    </div>
    <div id="dc-dialog" role="dialog" aria-modal="true" aria-label="New Message"
         style="position:fixed;right:16px;bottom:0;width:500px;height:400px;background:#fff;border:1px solid #444">
      <input id="dc-to" aria-label="To recipients">
      <input id="dc-subject" aria-label="Subject">
      <div id="dc-body" role="textbox" contenteditable aria-label="Message Body"></div>
      <button id="dc-send">Send</button>
    </div>
    <!--
      The shape that actually broke it: a wrapper with no size of its own
      holding a window that is painted normally. An application shell uses this
      everywhere - a 0x0 anchor with a positioned popup hanging off it.
    -->
    <div id="dc-anchor" style="width:0;height:0">
      <div id="dc-anchored" role="dialog" aria-label="Second Message"
           style="position:fixed;left:16px;bottom:0;width:400px;height:300px;background:#fff;border:1px solid #444">
        <input id="dc-anchored-to" aria-label="Anchored To recipients">
        <button id="dc-anchored-send">Anchored Send</button>
      </div>
    </div>`;
  document.body.appendChild(host);
  await new Promise((r) => setTimeout(r, 150));

  const dom = captureDom();
  const flat: typeof dom.root[] = [];
  (function collect(node: typeof dom.root) {
    flat.push(node);
    node.children.forEach(collect);
  })(dom.root);

  const dialog = flat.find((x) => x.attrs.id === "dc-dialog");
  const anchored = flat.find((x) => x.attrs.id === "dc-anchored");

  check("dialog: the capture keeps aria-modal, which the budget reads",
    dialog?.attrs["aria-modal"] === "true",
    dialog
      ? `attrs are ${JSON.stringify(Object.keys(dialog.attrs))}`
      : "the dialog was pruned from the capture entirely");

  check("dialog: the capture keeps role=dialog",
    dialog?.role === "dialog" || dialog?.attrs.role === "dialog",
    `role is ${JSON.stringify(dialog?.role)}`, true);

  // The fields are the point - a dialog whose inputs were pruned is no better
  // than no dialog at all.
  for (const [id, label] of [["dc-to", "To recipients"], ["dc-subject", "Subject"],
                             ["dc-body", "Message Body"], ["dc-send", "Send"]] as const) {
    const node = flat.find((x) => x.attrs.id === id);
    check(`dialog: the capture keeps the "${label}" control`, !!node,
      node ? `element ${node.id}` : "pruned", false);
  }

  // -- the zero-sized wrapper -----------------------------------------------
  //
  // The capture used to stop at any element whose own box measured 0x0 and
  // return nothing for the whole subtree, so a popup hanging off a 0x0 anchor
  // vanished entirely - while remaining perfectly visible on screen, and
  // perfectly clickable. The agent was told its click had done nothing.
  check("dialog: a window anchored to a zero-sized wrapper survives capture",
    !!anchored,
    anchored ? `element ${anchored.id}` : "the whole subtree was pruned at the 0x0 wrapper");

  for (const [id, label] of [["dc-anchored-to", "Anchored To recipients"],
                             ["dc-anchored-send", "Anchored Send"]] as const) {
    const node = flat.find((x) => x.attrs.id === id);
    check(`dialog: "${label}" survives the zero-sized wrapper`, !!node,
      node ? `element ${node.id}` : "pruned with its wrapper");
  }

  // It is on screen, so it must be marked so - a captured-but-invisible node
  // is dropped by the render budget and helps nobody.
  check("dialog: the anchored window is marked visible",
    anchored?.visible === true,
    `visible=${String(anchored?.visible)} bbox=${JSON.stringify(anchored?.bbox)}`, true);

  // End to end: what the planner is actually handed.
  const wire = renderPage(dom);
  check("dialog: the rendered page announces the open dialog",
    /dialog is open/i.test(wire),
    wire.split("\n").slice(0, 4).join(" | "));

  check("dialog: the rendered page contains the fields to fill in",
    ["To recipients", "Subject", "Message Body", "Send"].every((t) => wire.includes(t)),
    ["To recipients", "Subject", "Message Body", "Send"]
      .filter((t) => !wire.includes(t))
      .join(", ") || "all present");

  check("dialog: the anchored window reaches the planner too",
    wire.includes("Anchored To recipients") && wire.includes("Anchored Send"),
    wire.includes("Anchored To recipients") ? "present" : "missing from the render");

  host.remove();

  // -- what descending those wrappers costs ---------------------------------
  //
  // The old shortcut existed for a reason: cutting a subtree off at a zero-size
  // box skips a lot of DOM. Now that every one of them is descended into, the
  // cost is worth knowing rather than assuming - a capture that takes a second
  // would be its own bug.
  const heavy = document.createElement("div");
  heavy.innerHTML =
    Array.from({ length: 800 }, (_, i) =>
      `<div style="width:0;height:0"><span>anchor ${i}</span></div>`).join("") +
    Array.from({ length: 800 }, (_, i) =>
      `<div style="display:none"><span>closed ${i}</span></div>`).join("");
  document.body.appendChild(heavy);
  await new Promise((r) => setTimeout(r, 200));

  const started = performance.now();
  const heavyDom = captureDom();
  const elapsed = performance.now() - started;

  check("capture: descending zero-sized wrappers stays cheap",
    elapsed < 400,
    `${Math.round(elapsed)}ms for ${heavyDom.stats.examined} elements ` +
      `(${heavyDom.stats.kept} kept, ${heavyDom.stats.pruned} pruned)`, true);

  // display:none must still cut the subtree off - that is the one case where
  // nothing underneath can possibly be on screen.
  const heavyFlat: typeof heavyDom.root[] = [];
  (function collect(node: typeof heavyDom.root) {
    heavyFlat.push(node);
    node.children.forEach(collect);
  })(heavyDom.root);
  check("capture: display:none still cuts off its subtree",
    !heavyFlat.some((x) => (x.text ?? "").startsWith("closed ")),
    `${heavyFlat.filter((x) => (x.text ?? "").startsWith("closed ")).length} hidden nodes leaked in`);

  heavy.remove();
}

/**
 * Waiting for the page rather than for the clock.
 *
 * Actions used to end in a fixed sleep - 500ms after a click, 400ms after
 * typing. That is dead time on a static page and not enough time on a slow
 * one, which is the worst of both: a twenty-step task spent ten seconds
 * waiting for pages that had already finished, while Gmail's compose window
 * was still mounting when the capture after the click ran.
 *
 * Three behaviours matter: quick when nothing happens, patient when something
 * does, and never hanging on a page that is permanently in motion.
 */
async function responsivenessScenario(): Promise<void> {
  // -- nothing happening: the quick actions stay quick ----------------------
  //
  // A scroll or a keystroke either moves the page at once or never, so these
  // must not sit around waiting. The old code spent a flat 300ms on a scroll
  // and 200ms on a keystroke whatever happened.
  const idleStart = performance.now();
  await settle();
  const idle = performance.now() - idleStart;
  check("responsiveness: a keystroke on an inert page does not wait around",
    idle < 400,
    `${Math.round(idle)}ms`, true);

  // -- something slow happening: must wait for it ---------------------------
  const host = document.createElement("div");
  document.body.appendChild(host);

  // A dialog that mounts late, the way a real compose window does.
  setTimeout(() => {
    const late = document.createElement("div");
    late.id = "late-dialog";
    late.textContent = "New Message";
    host.appendChild(late);
  }, 600);

  const waitStart = performance.now();
  await settle({ start: CLICK_START, ceiling: 4000 });
  const waited = performance.now() - waitStart;
  const sawIt = !!document.getElementById("late-dialog");

  // This is the Gmail compose case in miniature: the window mounts well after
  // the click returns. A fixed 500ms sleep - and a 250ms grace, which is what
  // this was first written with - both miss it and report an unchanged page.
  check("responsiveness: a dialog that mounts late is still seen",
    sawIt && waited >= 500,
    `${Math.round(waited)}ms, dialog present: ${sawIt}`, true);

  // Having waited for it, it must not then dawdle: the settle should end
  // shortly after the dialog appears, not run to the ceiling.
  check("responsiveness: waiting stops once the page goes quiet",
    waited < 1600,
    `${Math.round(waited)}ms — should end just after the 600ms mutation, not at the ceiling`, true);

  host.remove();

  // -- constant motion: must not hang ---------------------------------------
  const spinner = document.createElement("div");
  document.body.appendChild(spinner);
  const beat = setInterval(() => { spinner.textContent = String(Date.now()); }, 30);

  const spinStart = performance.now();
  await settle({ ceiling: 800 });
  const spun = performance.now() - spinStart;
  clearInterval(beat);
  spinner.remove();

  check("responsiveness: a page that never stops moving still returns",
    spun < 1400,
    `${Math.round(spun)}ms against an 800ms ceiling`, true);
}

/**
 * Typing into editors that are not <input>s, and keys with modifiers.
 *
 * `textContent = text` worked for Gmail's body and for nothing more demanding.
 * Rich editors keep their own document model and update it only from the
 * `beforeinput`/`input` events a keyboard produces; overwrite the DOM under
 * them and the editor still believes the field is empty, so the message goes
 * out blank. The check below models that editor: it records what it was told
 * through events, and the test asks whether it heard the text.
 */
async function richEditorScenario(): Promise<void> {
  const host = document.createElement("div");
  host.innerHTML = `<div id="rich" contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div>`;
  document.body.appendChild(host);
  const rich = host.querySelector<HTMLElement>("#rich")!;

  // The editor's own model, fed only by events.
  let heard = "";
  let beforeInputs = 0;
  rich.addEventListener("beforeinput", (e) => { beforeInputs++; if ((e as InputEvent).data) heard += (e as InputEvent).data; });
  rich.addEventListener("input", (e) => {
    // Editors that ignore beforeinput still read from input.
    if (!heard && (e as InputEvent).data) heard = (e as InputEvent).data!;
  });

  await new Promise((r) => setTimeout(r, 100));
  const dom = captureDom();
  let node: typeof dom.root | undefined;
  (function find(x: typeof dom.root) { if (x.attrs.id === "rich") node = x; x.children.forEach(find); })(dom.root);

  check("editor: a contenteditable is captured as something to type into", !!node,
    node ? `element ${node.id}` : "not captured");

  if (node) {
    const typed = await act({ name: "type" as never, input: { element_id: node.id, text: "hello editor" } });
    check("editor: the text is on screen", typed.ok && rich.innerText.trim() === "hello editor",
      `${typed.detail} — innerText is ${JSON.stringify(rich.innerText)}`, true);
    check("editor: the editor's own model heard the text through events",
      heard.includes("hello editor"),
      `heard ${JSON.stringify(heard)} via ${beforeInputs} beforeinput event(s) — a textContent write produces none`, true);
  }

  // -- keys with modifiers -------------------------------------------------
  const input = document.createElement("input");
  input.value = "select me";
  host.appendChild(input);
  input.focus();

  let sawCtrl = false;
  input.addEventListener("keydown", (e) => { if (e.key === "a" && e.ctrlKey) sawCtrl = true; });
  const pressed = await act({ name: "key" as never, input: { key: "ctrl+a" } });
  check("keys: a modifier combination is delivered as one event",
    pressed.ok && sawCtrl, `${pressed.detail} — ctrlKey seen: ${sawCtrl}`, true);
  check("keys: ctrl+a actually selects the field",
    input.selectionStart === 0 && input.selectionEnd === input.value.length,
    `selection ${input.selectionStart}-${input.selectionEnd} of ${input.value.length}`);

  const spelled = await act({ name: "key" as never, input: { key: "esc" } });
  check("keys: a casual spelling is understood", spelled.ok && /Escape/.test(spelled.detail), spelled.detail, true);

  host.remove();
}

/**
 * A profile picture that is not an <img>.
 *
 * X, LinkedIn, Slack and most chat interfaces paint the avatar as a CSS
 * background on a <div>. The pixel tier walked image *tags*, so every one of
 * those faces went to the model untouched while the <img> beside it was
 * blacked out. The capture now records the background's host the way it
 * records an <img>'s, and the pixel tier treats the two alike.
 */
async function backgroundAvatarScenario(): Promise<void> {
  const host = document.createElement("div");
  host.innerHTML = `
    <div id="bg-avatar" style="width:48px;height:48px;border-radius:50%;
         background-image:url('https://pbs.twimg.com/profile_images/1/abc.jpg');background-size:cover"></div>
    <div id="bg-banner" style="width:600px;height:120px;
         background-image:url('https://cdn.example.com/hero.jpg')"></div>
    <div id="bg-icon" style="width:16px;height:16px;
         background-image:url('https://pbs.twimg.com/icon.png')"></div>`;
  document.body.appendChild(host);
  await new Promise((r) => setTimeout(r, 100));

  const dom = captureDom();
  const flat: typeof dom.root[] = [];
  (function collect(x: typeof dom.root) { flat.push(x); x.children.forEach(collect); })(dom.root);

  const avatar = flat.find((x) => x.attrs.id === "bg-avatar");
  const banner = flat.find((x) => x.attrs.id === "bg-banner");
  const icon = flat.find((x) => x.attrs.id === "bg-icon");

  check("bg avatar: a div painting a background image survives capture", !!avatar,
    avatar ? `element ${avatar.id}` : "pruned as an empty wrapper");
  check("bg avatar: the background's host is recorded like an <img> src",
    avatar?.attrs.bgHost === "pbs.twimg.com",
    `bgHost=${String(avatar?.attrs.bgHost)}`, true);
  check("bg avatar: a 16px icon is not recorded as an image",
    !icon || !icon.attrs.bgHost,
    icon?.attrs.bgHost ? `icon recorded bgHost=${icon.attrs.bgHost}` : "ignored");

  const { detect } = await import("../../src/pii/detect");
  const result = await detect(dom);
  const pixel = result.findings.filter((f) => f.shape === "pixel");
  const onAvatar = pixel.find((f) => avatar && f.nodeId === avatar.id);
  const onBanner = pixel.find((f) => banner && f.nodeId === banner.id);

  check("bg avatar: the pixel tier marks it for burning",
    !!onAvatar && onAvatar.action === "burn-region" && onAvatar.kind === "face_or_photo",
    onAvatar ? `${onAvatar.kind} (${onAvatar.confidence}) — ${onAvatar.why}` : "no pixel finding");
  check("bg avatar: a wide hero banner from an unknown host is left alone",
    !onBanner,
    onBanner ? `banner burned as ${onBanner.kind}: ${onBanner.why}` : "not flagged", true);

  host.remove();
}

/**
 * What OCR does to the picture.
 *
 * A canvas is painted with a marker colour and, as far as the DOM knows,
 * contains nothing - so it is blacked out whole. A fake engine "reads" a phone
 * number in a small box inside it. The result must be: that box destroyed and
 * stamped with a token, the rest of the canvas untouched (released from the
 * wholesale burn), and the token the same one the tree uses for that number.
 * The engine is faked; the canvas, the cropping, the burning and the vault are
 * all real.
 */
async function ocrRedactionScenario(): Promise<void> {
  const MARK = "#00c8ff";
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:20px;top:20px";
  host.innerHTML = `
    <p id="ocr-tree">Helpline 98765 43210</p>
    <canvas id="ocr-canvas" width="400" height="200" style="display:block"></canvas>`;
  document.body.appendChild(host);
  const canvasEl = host.querySelector<HTMLCanvasElement>("#ocr-canvas")!;
  canvasEl.getContext("2d")!.fillStyle = MARK;
  canvasEl.getContext("2d")!.fillRect(0, 0, 400, 200);
  await new Promise((r) => setTimeout(r, 120));

  const dom = captureDom();
  const canvasNode = (() => {
    let hit: typeof dom.root | undefined;
    (function find(x: typeof dom.root) { if (x.attrs.id === "ocr-canvas") hit = x; x.children.forEach(find); })(dom.root);
    return hit;
  })();
  check("ocr paint: the canvas is captured", !!canvasNode, "canvas missing from capture");
  if (!canvasNode) { host.remove(); return; }

  // A screenshot that shows the canvas where it really is.
  const dpr = devicePixelRatio || 1;
  const shotCanvas = new OffscreenCanvas(Math.round(VIEW_W() * dpr), Math.round(VIEW_H() * dpr));
  const sctx = shotCanvas.getContext("2d")!;
  sctx.fillStyle = "#ffffff";
  sctx.fillRect(0, 0, shotCanvas.width, shotCanvas.height);
  const rect = canvasEl.getBoundingClientRect();
  sctx.fillStyle = MARK;
  sctx.fillRect(rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr);
  const blob = await shotCanvas.convertToBlob({ type: "image/png" });
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
  const shot: ScreenshotMeta = {
    dataUrl, kind: "viewport", scale: dpr, originX: Math.round(scrollX), originY: Math.round(scrollY),
    cssWidth: VIEW_W(), cssHeight: VIEW_H(), tiles: 1,
  };

  // The engine reports the number in a 200x30 crop-pixel box near the top-left
  // of whatever crop it is handed; the crop is the canvas, at the real zoom.
  const engine: OcrEngine = {
    name: "fake",
    async available() { return true; },
    async recognize(images) {
      return images.map((img) => {
        const zoom = dpr >= 2 ? 1 : 2;
        const w = (t: string, x: number, wd: number) => ({ text: t, x0: x * zoom, y0: 20 * zoom, x1: (x + wd) * zoom, y1: 50 * zoom, confidence: 92 });
        const words = [w("Call", 10, 40), w("98765", 60, 70), w("43210", 140, 70)];
        return { id: img.id, ms: 3, lines: [{ text: words.map((x) => x.text).join(" "), words, x0: 10, y0: 20, x1: 210, y1: 50, confidence: 92 }] };
      });
    },
  };

  // Count pixels of one exact colour - the canvas marker - before and after.
  const countMark = async (url: string): Promise<number> => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const cx = c.getContext("2d")!;
    cx.drawImage(bitmap, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let count = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 0x00 && d[i + 1] === 0xc8 && d[i + 2] === 0xff) count++;
    }
    return count;
  };

  const before = await countMark(dataUrl);
  const vault = new Vault();
  const result = await sanitize({ dom, screenshot: shot }, vault,
    { burnUnverifiedRegions: true, aggressiveNames: false, ocr: "images" }, undefined, engine);

  check("ocr paint: the engine was consulted and read the canvas",
    (result.report.ocr?.regionsScanned ?? 0) >= 1 && !result.report.ocr?.error,
    JSON.stringify(result.report.ocr));
  check("ocr paint: the canvas was released from its wholesale burn",
    result.report.ocr?.regionsReleased === 1,
    `released ${result.report.ocr?.regionsReleased}`);
  check("ocr paint: the number's box was painted over",
    result.report.redact.ocrSpansCovered === 1,
    `ocrSpansCovered=${result.report.redact.ocrSpansCovered}, error=${result.report.screenshotError}`);

  if (result.screenshot) {
    const after = await countMark(result.screenshot.dataUrl);
    const total = before;
    const gone = total - after;
    // The engine's box is 150x30 crop pixels, and the crop maps back to the
    // screenshot 1:1 at its own zoom, so exactly 150x30 image pixels plus the
    // 3px bleed on every edge - (150+6)*(30+6) = 5,616 - must be gone. Far
    // more means the canvas was blacked out whole; far less means a mis-mapped
    // box; and it must be nowhere near the whole canvas either way.
    const expected = (150 + 6) * (30 + 6);
    check("ocr paint: exactly the number's box was destroyed, not the whole canvas",
      gone >= expected * 0.9 && gone <= expected * 1.25 && gone < total * 0.3,
      `${gone} of ${total} marker pixels destroyed; expected about ${expected}`, true);
  } else {
    check("ocr paint: a screenshot came back", false, result.report.screenshotError ?? "no screenshot, no error");
  }

  const phoneTokens = vault.view().filter((e) => e.kind === "phone").map((e) => e.token);
  check("ocr paint: the picture and the tree share one token for the number",
    phoneTokens.length === 1, `phone tokens: ${phoneTokens.join(", ")}`, true);

  host.remove();
}

/**
 * The side panel's transcript, and the layout bug that scattered it.
 *
 * Entry ids came from a counter in the service worker. Chrome terminates an
 * idle MV3 worker whenever it likes, so the counter restarted at one while the
 * panel - a separate document - still held every node it had rendered under
 * those ids. A fresh assistant entry then arrived as "e1", found the *step*
 * node already stored under "e1", and had its text written into it. A step is a
 * two-column grid whose first column is 20px, and a bare text node becomes an
 * anonymous grid item in that column: the model's prose came out roughly two
 * characters per line, high up the panel where the old step had been.
 *
 * The check below reproduces exactly that collision and measures the rendered
 * width, because "two characters per line" is a geometric claim and deserves a
 * geometric test.
 */
async function transcriptScenario(): Promise<void> {
  const host = document.createElement("div");
  // A realistic panel width; the transcript is a flex column inside it.
  host.style.cssText =
    "position:fixed;left:0;top:0;width:380px;height:600px;display:flex;flex-direction:column;background:#fff;z-index:9999";
  const container = document.createElement("main");
  container.className = "transcript";
  container.style.cssText = "flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:12px";
  host.appendChild(container);
  document.body.appendChild(host);

  // The panel's own rules, inline - the selftest page has no stylesheet.
  const style = document.createElement("style");
  style.textContent = `
    .entry { border-radius:14px; padding:10px 12px; white-space:pre-wrap;
             overflow-wrap:anywhere; word-break:break-word; min-width:0; }
    .entry.step { display:grid; grid-template-columns:20px minmax(0,1fr); gap:8px;
                  align-items:start; font-size:12.5px; }
    .entry.step .glyph { text-align:center; }
    .entry.step .detail { min-width:0; }
    .steps, .steps-list { display:flex; flex-direction:column; gap:6px; }
    .steps.folded:not(.unfolded) .steps-list > .entry.step:not(:nth-last-child(-n+3)) { display:none; }
  `;
  document.head.appendChild(style);

  const view = new TranscriptView(container);
  const PROSE = "I opened the compose window and filled in the recipient, subject and body.";

  // -- the collision ---------------------------------------------------------
  view.render({ id: "e1", role: "step", action: "click", text: "Clicked Compose" } as never);
  view.render({ id: "e1", role: "assistant", text: PROSE } as never);
  await new Promise((r) => requestAnimationFrame(r));

  const prose = Array.from(container.querySelectorAll<HTMLElement>(".entry.assistant"))
    .find((el) => el.textContent === PROSE);

  check("panel: an id reused for a different role gets a fresh node",
    !!prose, "the assistant entry did not render at all");
  check("panel: the old step node was removed, not overwritten",
    container.querySelectorAll(".entry.step").length === 0,
    `${container.querySelectorAll(".entry.step").length} step node(s) remain`);

  if (prose) {
    // The bug's signature: text laid out in a 20px grid column.
    const width = prose.getBoundingClientRect().width;
    check("panel: the prose is laid out at panel width, not in the 20px glyph column",
      width > 200,
      `${Math.round(width)}px wide (the bug rendered it at about 20px, two characters per line)`, true);

    // A paragraph that wide should occupy a handful of lines, not fifty.
    const lines = Math.round(prose.getBoundingClientRect().height / 21);
    check("panel: the prose wraps into a few lines, not one word per line",
      lines <= 6, `${lines} rendered lines for ${PROSE.length} characters`, true);
  }

  // -- a long unbreakable string must not widen the panel --------------------
  view.render({
    id: "e2", role: "system",
    text: "data:image/png;base64," + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw".repeat(6),
  } as never);
  await new Promise((r) => requestAnimationFrame(r));
  check("panel: a long unbreakable string wraps instead of scrolling the panel sideways",
    container.scrollWidth <= container.clientWidth + 1,
    `content is ${container.scrollWidth}px in a ${container.clientWidth}px column`);

  // -- streamed deltas still append -----------------------------------------
  view.render({ id: "e3", role: "assistant", text: "Loo" } as never);
  view.patch("e3", { text: "king" });
  view.patch("e3", { text: " at the page" });
  const streamed = Array.from(container.querySelectorAll<HTMLElement>(".entry.assistant"))
    .find((el) => (el.textContent ?? "").startsWith("Looking"));
  check("panel: streamed prose deltas append", streamed?.textContent === "Looking at the page",
    JSON.stringify(streamed?.textContent));

  // A replacement - the answer with real values restored - overwrites instead.
  view.patch("e3", { text: "Looking at the page: +91 98765 43210", replace: true });
  check("panel: a replacement overwrites rather than appending",
    streamed?.textContent === "Looking at the page: +91 98765 43210",
    JSON.stringify(streamed?.textContent));

  // -- a patch to a step replaces its detail and keeps its glyph -------------
  view.render({ id: "e4", role: "step", action: "scroll", text: "Scrolling", pending: true } as never);
  view.patch("e4", { text: "Scrolled down to y=800 of 2960.", pending: false });
  const step = container.querySelector<HTMLElement>(".entry.step");
  check("panel: patching a step keeps its two columns",
    !!step?.querySelector(".glyph") && !!step?.querySelector(".detail"),
    step?.outerHTML.slice(0, 120) ?? "no step");
  check("panel: the step's glyph survived the patch",
    step?.querySelector(".glyph")?.textContent === "↕",
    JSON.stringify(step?.querySelector(".glyph")?.textContent));
  check("panel: the step's detail was replaced, not appended",
    step?.querySelector(".detail")?.textContent === "Scrolled down to y=800 of 2960.",
    JSON.stringify(step?.querySelector(".detail")?.textContent));

  // -- a long run of actions folds -----------------------------------------
  for (let i = 0; i < 14; i++) {
    view.render({ id: `s${i}`, role: "step", action: "scroll", text: `Scrolled to y=${i * 200}` } as never);
  }
  await new Promise((r) => requestAnimationFrame(r));
  const group = container.querySelector<HTMLElement>(".steps.folded");
  check("panel: a long run of actions folds itself", !!group,
    `${container.querySelectorAll(".steps").length} group(s), none folded`);

  if (group) {
    const shown = Array.from(group.querySelectorAll<HTMLElement>(".entry.step"))
      .filter((el) => el.offsetParent !== null).length;
    check("panel: a folded run shows only the most recent actions",
      shown === 3, `${shown} of 15 steps visible`, true);
    const toggle = group.querySelector<HTMLButtonElement>(".steps-toggle")!;
    check("panel: the fold says how many it is hiding",
      /earlier action/.test(toggle.textContent ?? ""), JSON.stringify(toggle.textContent), true);

    toggle.click();
    const afterClick = Array.from(group.querySelectorAll<HTMLElement>(".entry.step"))
      .filter((el) => el.offsetParent !== null).length;
    check("panel: unfolding shows every action", afterClick === 15, `${afterClick} visible after unfolding`);
  }

  // -- clear leaves nothing behind ------------------------------------------
  view.clear();
  check("panel: clearing removes every entry and every group",
    container.querySelectorAll(".entry, .steps").length === 0,
    `${container.querySelectorAll(".entry, .steps").length} node(s) left`);

  host.remove();
  style.remove();
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
