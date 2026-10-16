// R3-18 — the monospace-token sweep: 64 spellings in 37 files became one token.
// This suite *is* the instrument: it re-measures the debt the way
// 4-Design-System.md §4 documents it, and passes only when the debt is zero.
// Run from the repo root with nvm's Node 24 (PATH node is Homebrew v20):
//   node --experimental-strip-types --no-warnings tests/mono18.test.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass++; return; }
  fails.push(name);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|css)$/.test(e)) out.push(p);
  }
  return out;
}

const files = walk('src');
const globals = readFileSync('src/app/globals.css', 'utf8');

// --- A. the token itself is untouched and singular --------------------------
const TOKEN = '--mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;';
ok('A1 globals.css still defines the token verbatim', globals.includes(TOKEN));
ok('A2 exactly one --mono definition in the file',
  (globals.match(/--mono:/g) || []).length === 1);

// --- B. the debt is zero -----------------------------------------------------
// A spelling is any font-family that names a mono family *outside* the token:
// class rules (font-family: …monospace) and inline props (fontFamily: '…monospace').
// var(--mono) lines are excluded: the token's own name is not a spelling.
const classSpelling = /font-family:.*monospace/i;
const inlineSpelling = /fontFamily:[^,}\n]*monospace/i;
const classLines = [];
const inlineLines = [];
const selfRef = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    const isTokenDef = f.endsWith('globals.css') && l.includes('--mono:');
    if (classSpelling.test(l) && !l.includes('var(--mono)') && !isTokenDef) classLines.push(`${f}:${i + 1}`);
    if (inlineSpelling.test(l) && !l.includes('var(--mono)')) inlineLines.push(`${f}:${i + 1}`);
    if (/font-family:\s*var\(--mono[^)]*monospace/i.test(l) && !isTokenDef) selfRef.push(`${f}:${i + 1}`);
  });
}
ok('B1 no class rule spells a mono stack outside the token (was 45)', classLines.length === 0);
ok('B2 no inline style prop spells a mono stack outside the token (was 19)', inlineLines.length === 0);
ok('B3 no var(--mono, …monospace) fallback crept in (a fallback is a second recipe)',
  selfRef.length === 0);

// --- C. the consumers add up -------------------------------------------------
const consumerLines = [];
const consumerFiles = new Set();
for (const f of files) {
  const txt = readFileSync(f, 'utf8');
  if (!txt.includes('var(--mono)')) continue;
  consumerFiles.add(f);
  txt.split('\n').forEach((l) => { if (l.includes('var(--mono)') && !l.includes('--mono:')) consumerLines.push(`${f}|${l}`); });
}
ok('C1 68 lines read the token — 64 swept this round + 4 pre-R3-18 consumers',
  consumerLines.length === 68);
ok('C2 exactly 49 are class rules (45 swept + 4 existing: .tf-cmd-kbd via globals, .jn-mono, .dep-fig, .dep-input-field)',
  consumerLines.filter((l) => l.includes('font-family: var(--mono)')).length === 49);
ok('C3 exactly 19 are inline props (all swept this round)',
  consumerLines.filter((l) => l.includes("fontFamily: 'var(--mono)'")).length === 19);
ok('C4 the token is defined in one file, consumed in no others under a fallback',
  consumerFiles.has('src/app/globals.css'));

// --- D. nothing but the mono stack moved (sibling declarations survive) ------
const pin = (f, re, n, label) => {
  const txt = readFileSync(f, 'utf8');
  ok(label, (txt.match(re) || []).length === n);
};
pin('src/app/portal/page.tsx', /font-family: var\(--mono\);/g, 3,
  'D1 portal page: its three class rules are token reads with the semicolon intact');
pin('src/app/portal/page.tsx', /letter-spacing: 0\.03em/g, 1,
  'D2 portal .pt-gstin kept its letter-spacing (the sed stopped at the semicolon)');
pin('src/components/InvoiceDocument.tsx', /fontFamily: 'var\(--mono\)'/g, 3,
  'D3 InvoiceDocument: three inline props, the legal artefact now wears the house stack');
pin('src/components/OrderDocument.tsx', /fontFamily: 'var\(--mono\)'/g, 2,
  'D4 OrderDocument: two inline props swept');
pin('src/app/(app)/layout.tsx', /var\(--mono\)/g, 2,
  'D5 shell layout: GSTIN chip and sidebar badge both read the token');
pin('src/app/(app)/ledger/page.tsx', /var\(--mono\)/g, 2,
  'D6 ledger: one inline prop + one class rule');
pin('src/app/(app)/inventory/recipes/page.tsx', /font-family: var\(--mono\);/g, 1,
  'D7 recipes .rc-mono swept without disturbing the four rc-wip-* rules R3-17 added');

// --- E. the diff is exactly the sweep ---------------------------------------
// The 37 swept files are the token consumers minus the three that already read
// the token before this round — their post-sweep text is byte-indistinguishable
// from a swept one, so this is content plus recorded history, not a fresh measure.
const PRE18 = ['src/app/globals.css', 'src/app/(app)/journal/page.tsx', 'src/app/(app)/gst/calendar/page.tsx'];
const swept = [...consumerFiles].filter((f) => !PRE18.includes(f));
ok('E1 40 token files − 3 that read the token before R3-18 = the 37 the sweep touched',
  consumerFiles.size === 40 && swept.length === 37);
ok('E2 none of the three pre-18 files spells a stack outside the token (globals.css:30 is the definition)',
  PRE18.every((f) => {
    const ls = readFileSync(f, 'utf8').split('\n');
    return !ls.some((l, i) => (classSpelling.test(l) || inlineSpelling.test(l)) && !l.includes('var(--mono)') && !(f.endsWith('globals.css') && l.includes('--mono:')));
  }));

console.log(`${pass}/${pass + fails.length} assertions passed`);
if (fails.length) {
  for (const f of fails) console.log('  FAIL: ' + f);
  process.exit(1);
}
