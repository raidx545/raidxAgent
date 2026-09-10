import { CATALOGUE, type TaskCase } from "./tasks/catalogue";
import { PAGES } from "./tasks/pages";
import { renderPage, alignTask } from "../src/background/wire";
import { sanitize, sanitizeText } from "../src/sanitize/sanitize";
import { gate } from "../src/background/safety";
import { Vault } from "../src/vault/vault";
import { walkCapture } from "../src/capture/dom";
import type { CapturedNode, DomCapture } from "../src/capture/types";

/**
 * Can the agent do these things?
 *
 * A hundred-odd real tasks, each driven through the machinery that decides
 * whether a task is possible: capture is sanitized, the page is rendered as the
 * planner would see it, the element the task needs is looked up in that render,
 * and the safety gate is asked about the decisive action.
 *
 * What this does NOT test is the model's judgement - whether it picks the right
 * element, in the right order, and knows when it is finished. That needs a real
 * provider and real pages. Everything up to the model's decision is here.
 *
 * A failure means one of four things, and the report says which:
 *   invisible  - the control is not in the render, so no planner could act
 *   gate       - the safety layer disagreed with what the task needs
 *   leak       - a value the task should have hidden reached the payload
 *   unusable   - the page lost something the task depends on
 */

interface Failure {
  id: string;
  category: string;
  task: string;
  kind: "invisible" | "gate" | "leak" | "unusable";
  detail: string;
}

const failures: Failure[] = [];
const passed: string[] = [];

/** Finds a node by its visible label or text, the way a planner would. */
function findNode(dom: DomCapture, label: string): CapturedNode | undefined {
  for (const node of walkCapture(dom.root)) {
    if (node.label === label || node.text === label) return node;
  }
  return undefined;
}

async function run(testCase: TaskCase): Promise<void> {
  const raw = PAGES[testCase.page]();
  const vault = new Vault();

  const sanitized = await sanitize({ dom: raw }, vault);
  const wire = renderPage(sanitized.dom);

  // The request goes through the same vault, as it does in the agent.
  const aligned = alignTask(testCase.task, vault.values());
  const { text: sentTask } = await sanitizeText(aligned, vault);

  let ok = true;
  const fail = (kind: Failure["kind"], detail: string): void => {
    ok = false;
    failures.push({ id: testCase.id, category: testCase.category, task: testCase.task, kind, detail });
  };

  // -- can the planner even see what it needs? ------------------------------
  for (const label of testCase.needs) {
    // Labels are sanitized too, so look the node up in the sanitized tree and
    // check *that* id reached the render.
    const node = findNode(sanitized.dom, label) ?? findNode(raw, label);
    if (!node) {
      fail("invisible", `no element labelled "${label}" survived the capture`);
      continue;
    }
    if (!new RegExp(`^\\s*\\[${node.id}\\] `, "m").test(wire)) {
      fail("invisible", `element ${node.id} ("${label}") did not reach the rendered page`);
    }
  }

  // -- does the safety layer permit the decisive action? --------------------
  if (testCase.act) {
    const node = findNode(sanitized.dom, testCase.act.on) ?? findNode(raw, testCase.act.on);
    if (!node) {
      fail("invisible", `the action target "${testCase.act.on}" is not on the page`);
    } else {
      const input: Record<string, unknown> = { element_id: node.id };
      if (testCase.act.kind === "type") {
        input.text = "sample";
        if (testCase.act.submit) input.submit = true;
      }
      if (testCase.act.kind === "select") input.option = "sample";

      const verdict = gate(
        { name: testCase.act.kind as never, input },
        sanitized.dom,
        true,
      ).verdict;

      if (verdict !== testCase.act.gate) {
        fail(
          "gate",
          `${testCase.act.kind} on "${testCase.act.on}" was ${verdict}, expected ${testCase.act.gate}`,
        );
      }
    }
  }

  // -- did anything private survive? ---------------------------------------
  const payload = `${sentTask}\n${wire}`;
  for (const secret of testCase.hides ?? []) {
    if (payload.includes(secret)) fail("leak", `"${secret}" reached the payload`);
  }
  if (sanitized.report.residual.length > 0) {
    fail("leak", `residual: ${sanitized.report.residual.map((f) => f.kind).join(", ")}`);
  }

  // -- is the page still usable for this task? ------------------------------
  for (const keep of testCase.keeps ?? []) {
    if (!payload.includes(keep)) fail("unusable", `the page lost "${keep}"`);
  }

  if (ok) passed.push(testCase.id);
}

for (const testCase of CATALOGUE) {
  await run(testCase);
}

// ---------------------------------------------------------------- reporting

const byCategory = new Map<string, { total: number; failed: number }>();
for (const testCase of CATALOGUE) {
  const row = byCategory.get(testCase.category) ?? { total: 0, failed: 0 };
  row.total++;
  byCategory.set(testCase.category, row);
}
for (const failure of failures) {
  const row = byCategory.get(failure.category)!;
  row.failed++;
}

const byKind = new Map<string, number>();
for (const failure of failures) {
  byKind.set(failure.kind, (byKind.get(failure.kind) ?? 0) + 1);
}

console.log(JSON.stringify({
  tasks: CATALOGUE.length,
  passed: passed.length,
  failed: new Set(failures.map((f) => f.id)).size,
  byCategory: Object.fromEntries(
    [...byCategory].map(([k, v]) => [k, `${v.total - v.failed}/${v.total}`]),
  ),
  failuresByKind: Object.fromEntries(byKind),
  failures: failures.map((f) => `[${f.kind}] ${f.id} — ${f.task} :: ${f.detail}`),
  pass: failures.length === 0,
}, null, 2));
