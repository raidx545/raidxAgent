import { renderPage } from "../src/background/wire";
import type { CapturedNode, DomCapture } from "../src/capture/types";

/**
 * A control's state, as the planner reads it.
 *
 * The render used to print a ticked checkbox, the selected tab and a pressed
 * Bold button exactly like their opposites. "Make sure newsletters are off"
 * was a guess, and a click meant to set a toggle could as easily clear it.
 * Native state and its ARIA equivalent must both come through, and "off" must
 * be said as plainly as "on".
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 100, 20], visible: true, children: [], ...p,
});

const nodes = {
  ariaChecked: n({ role: "checkbox", label: "Select conversation", attrs: { "aria-checked": "true" } }),
  ariaUnchecked: n({ role: "checkbox", label: "Star", attrs: { "aria-checked": "false" } }),
  mixed: n({ role: "checkbox", label: "Select all", attrs: { "aria-checked": "mixed" } }),
  nativeOn: n({ tag: "input", role: "checkbox", label: "Newsletter", attrs: { type: "checkbox", checked: "true" } }),
  nativeOff: n({ tag: "input", role: "checkbox", label: "Remember me", attrs: { type: "checkbox", checked: "false" } }),
  tab: n({ role: "tab", label: "Primary", attrs: { "aria-selected": "true" } }),
  otherTab: n({ role: "tab", label: "Promotions", attrs: { "aria-selected": "false" } }),
  bold: n({ tag: "button", role: "button", label: "Bold", attrs: { "aria-pressed": "true" } }),
  menu: n({ tag: "button", role: "button", label: "More", attrs: { "aria-expanded": "false" } }),
  ariaDisabled: n({ role: "button", label: "Send", attrs: { "aria-disabled": "true" } }),
  readonly: n({ tag: "input", role: "textbox", label: "Invoice number", value: "INV-2024-001", attrs: { readonly: "true" } }),
  required: n({ tag: "input", role: "textbox", label: "Email", attrs: { "aria-required": "true", "aria-invalid": "true" } }),
  plain: n({ tag: "button", role: "button", label: "Cancel" }),
};

const capture: DomCapture = {
  url: "https://example.com/", origin: "https://example.com", title: "Form",
  capturedAt: 1,
  viewport: { width: 1200, height: 800, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 800 },
  root: { ...n({ tag: "body", role: "document" }), children: Object.values(nodes) },
  stats: { examined: 1, kept: 1, pruned: 0 },
};

const wire = renderPage(capture);
const line = (node: CapturedNode) =>
  wire.split("\n").find((l) => l.includes(`[${node.id}] `)) ?? "";
const has = (node: CapturedNode, word: string) =>
  new RegExp(`\\(([^)]* )?${word}( [^)]*)?\\)`).test(line(node));

want(has(nodes.ariaChecked, "checked"), `aria-checked=true is not shown: ${line(nodes.ariaChecked)}`);
want(has(nodes.ariaUnchecked, "unchecked"), `aria-checked=false is not shown: ${line(nodes.ariaUnchecked)}`);
want(has(nodes.mixed, "partly-checked"), `aria-checked=mixed is not shown: ${line(nodes.mixed)}`);
want(has(nodes.nativeOn, "checked"), `a ticked native checkbox is not shown: ${line(nodes.nativeOn)}`);
want(has(nodes.nativeOff, "unchecked"), `an unticked native checkbox is not shown: ${line(nodes.nativeOff)}`);
want(has(nodes.tab, "selected"), `the selected tab is not shown: ${line(nodes.tab)}`);
want(!/selected/.test(line(nodes.otherTab)), `an unselected tab claims selection: ${line(nodes.otherTab)}`);
want(has(nodes.bold, "pressed"), `a pressed toggle is not shown: ${line(nodes.bold)}`);
want(has(nodes.menu, "collapsed"), `a collapsed menu button is not shown: ${line(nodes.menu)}`);
want(has(nodes.ariaDisabled, "disabled"), `aria-disabled is not shown: ${line(nodes.ariaDisabled)}`);
want(has(nodes.readonly, "readonly"), `a read-only field is not shown: ${line(nodes.readonly)}`);
want(has(nodes.required, "required") && has(nodes.required, "invalid"),
  `a required, invalid field is not shown: ${line(nodes.required)}`);
want(!/\(/.test(line(nodes.plain)), `a plain button gained state it does not have: ${line(nodes.plain)}`);

console.log(JSON.stringify({
  lines: Object.values(nodes).map(line),
  failures: fails,
  pass: fails.length === 0,
}, null, 2));
