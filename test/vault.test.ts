import { Vault, escapeExistingTokens, TOKEN_PATTERN } from "../src/vault/vault";

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

const v = new Vault();

// --- stability: the same value must always get the same token (join keys) ---
const t1 = v.tokenize("Sharma Traders", "org_name");
const t2 = v.tokenize("Sharma Traders", "org_name");
want(t1 === t2, `unstable token: ${t1} vs ${t2}`);
want(t1 === "<ORG_1>", `unexpected token format: ${t1}`);

// different value -> different token
const t3 = v.tokenize("Verma Exports", "org_name");
want(t3 === "<ORG_2>", `counter did not advance: ${t3}`);

// same string, different kind -> different token (kind is part of identity)
const t4 = v.tokenize("Sharma Traders", "person_name");
want(t4 !== t1, "same string under a different kind reused the token");
want(t4 === "<NAME_1>", `wrong prefix for person_name: ${t4}`);

// --- round trip ---
want(v.resolve(t1) === "Sharma Traders", "resolve did not return the value");
want(v.resolve("<ORG_99>") === undefined, "resolved a token never issued");

// --- sealed tokens: visible but empty forever ---
const sealed = v.seal("credential_field");
want(sealed === "<SECRET_1>", `wrong sealed token: ${sealed}`);
want(v.issued(sealed), "sealed token not recorded as issued");
want(v.resolve(sealed) === undefined, "a sealed token resolved to a value");

// --- resolveAll: the swap-back path ---
const planned = `Email <EMAIL_1> about <ORG_1>, secret is <SECRET_1>, ghost <ORG_77>`;
const email = v.tokenize("priya@example.in", "email");
want(email === "<EMAIL_1>", `email token mismatch: ${email}`);
const r = v.resolveAll(planned);
want(r.text.includes("priya@example.in"), "resolveAll did not substitute email");
want(r.text.includes("Sharma Traders"), "resolveAll did not substitute org");
want(r.text.includes("<SECRET_1>"), "sealed token was substituted");
want(r.sealed.length === 1 && r.sealed[0] === "<SECRET_1>", "sealed not reported");
want(r.text.includes("<ORG_77>"), "unknown token was substituted");
want(r.unknown.length === 1 && r.unknown[0] === "<ORG_77>", "unknown not reported");

// --- use counting ---
const view = v.view();
const orgView = view.find((e) => e.token === "<ORG_1>")!;
want(orgView.uses >= 2, `use count not tracked: ${orgView.uses}`);
want(!JSON.stringify(view).includes("Sharma Traders"), "vault view leaked a real value");
want(!JSON.stringify(view).includes("priya@example.in"), "vault view leaked an email");
want(orgView.length === "Sharma Traders".length, "view lost the length");

// --- the vault must be safe to stringify by accident ---
const dumped = JSON.stringify(v);
want(!dumped.includes("Sharma Traders"), `stringify leaked a value: ${dumped}`);
want(!dumped.includes("priya@example.in"), `stringify leaked an email: ${dumped}`);
want(dumped === '{"vault":"sealed","entries":5}', `unexpected safe dump: ${dumped}`);
// Nested inside another object is the realistic accident (console.log({vault})).
const nested = JSON.stringify({ state: { vault: v, note: "debug" } });
want(!nested.includes("Sharma Traders"), `nested stringify leaked: ${nested}`);

// --- token collision defence ---
const hostile = "Contact <EMAIL_1> now";  // page text that mimics a token
const escaped = escapeExistingTokens(hostile);
want(!/<EMAIL_1>/.test(escaped), `page-supplied token not neutralised: ${escaped}`);
const afterEscape = v.resolveAll(escaped);
want(!afterEscape.text.includes("priya@example.in"),
  "escaped page text still resolved to a real value");

// TOKEN_PATTERN is global; make sure repeated use does not skip matches
TOKEN_PATTERN.lastIndex = 0;
const c1 = (`<A_1> <B_2>`.match(TOKEN_PATTERN) ?? []).length;
const c2 = (`<A_1> <B_2>`.match(TOKEN_PATTERN) ?? []).length;
want(c1 === 2 && c2 === 2, `lastIndex leaks between uses: ${c1} then ${c2}`);

// --- clear() really clears ---
v.clear();
want(v.size === 0, "clear left entries");
want(v.resolve(t1) === undefined, "value survived clear");

console.log(JSON.stringify({ failures: fails, pass: fails.length === 0 }, null, 2));
