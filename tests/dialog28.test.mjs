// R3-28 — every modal is a door, and the keyboard can use it.
//
// For twenty-seven rounds every page dialog was a mouse door. `role="dialog"` was declared and
// `aria-modal` was set, so a screen reader announced a modal — and then Escape did nothing, Tab
// walked into the page behind it, and closing it dropped focus on <body>. The command palette was
// the only keyboard surface in the app, and it knew it: its own comment said "Page modals below do
// not listen for Escape; stop it reaching them."
//
// This round adds one hook to the design kit — `useDialog(onClose)` in `src/components/ui.tsx` —
// and gives its ref to every page dialog's scrim. The hook takes focus on open unless a field's
// `autoFocus` already did, traps Tab, closes on Escape through the caller's own close function,
// and hands focus back to the opener. The palette keeps its own keys on purpose: it is a listbox
// whose Tab is deliberately cancelled, and it already restores its opener. It is the one dialog
// with no shared ref, and the hook's comment says so.
//
// React 19's ref-callback cleanup form does the lifecycle: a conditionally rendered modal attaches
// its listeners on mount and removes them on unmount, with no `open` flag and no effect to keep in
// step with the markup. The listener is bound in the capture phase so Escape/Tab reach the topmost
// dialog before the palette's bubble listener sees them; `topmost()` stands a covered page modal
// down if a second dialog opens over it.
//
// This suite fences:
//   A. the census: 57 real dialog tags in 29 files, 56 wired, the palette the single named exemption;
//   B. every dialog names itself, announces itself as modal, and carries no markup tabindex;
//   C. every wired tag's ref resolves to a `useDialog` declaration in the same file, and every
//      declaration is attached to a dialog — no orphan hook, no orphan ref;
//   D. the hook's own source pins what it promises: capture listener, IME guard, both Tab wraps,
//      focus-on-open only when unheld, focus returned to the opener on unmount, and the opener
//      recovered from an opener trail at mount — the one point that is right both for an
//      always-mounted page hook and after a field's autoFocus has already run;
//   E. one keydown listener in the kit plus the palette's own — no page invents a local Escape
//      handler (the lone one in /inventory/recipes is gone);
//   F. the palette's exemption is truthful in code and in comment: no ref, its own Escape branch,
//      its own opener restore, and the stale "page modals do not listen" sentence deleted.
//
// Run from the repo root with nvm's Node 24:
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/dialog28.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  pass += 1
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ── the walk ──────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const files = walk(SRC)
const rel = (p) => relative(ROOT, p).split(sep).join('/')

// A tag is a real dialog only when `role="dialog"` sits inside its attributes. Comments and the
// hook's own `querySelector` string mention `[role="dialog"]` but open no tag, so they never match.
const TAG = /<([A-Za-z][\w.]*)\b[^<>]*?\brole="dialog"[^<>]*?>/gs

const dialogs = []   // { file, tag, line }
const sources = new Map()
for (const p of files) {
  const src = readFileSync(p, 'utf8')
  sources.set(p, src)
  for (const m of src.matchAll(TAG)) {
    dialogs.push({ file: rel(p), tag: m[0], line: src.slice(0, m.index).split('\n').length })
  }
}

// ── A. the census ─────────────────────────────────────────────────────────────
const palettePath = 'src/components/CommandPalette.tsx'
const palette = dialogs.find(d => d.file === palettePath)
const wired = dialogs.filter(d => d !== palette)
const dialogFiles = [...new Set(dialogs.map(d => d.file))].sort()

eq('A1. real dialogs in the tree', dialogs.length, 57)
eq('A2. files that open one', dialogFiles.length, 29)
eq('A3. the palette opens exactly one dialog', dialogs.filter(d => d.file === palettePath).length, 1)
eq('A4. wired dialogs (all but the palette)', wired.length, 56)
eq('A5. dialog-bearing files (all but the palette)', dialogFiles.filter(f => f !== palettePath).length, 28)

// The per-file shape is pinned so a new dialog cannot arrive unnoticed in a file this round counted.
const EXPECTED_COUNTS = {
  'src/app/(app)/accounting/page.tsx': 1,
  'src/app/(app)/audit/page.tsx': 3,
  'src/app/(app)/business/page.tsx': 2,
  'src/app/(app)/challans/page.tsx': 1,
  'src/app/(app)/cost-centres/page.tsx': 2,
  'src/app/(app)/customers/page.tsx': 1,
  'src/app/(app)/expenses/page.tsx': 1,
  'src/app/(app)/fx/page.tsx': 2,
  'src/app/(app)/gst/einvoice/page.tsx': 3,
  'src/app/(app)/gst/exports/page.tsx': 4,
  'src/app/(app)/gst/filings/page.tsx': 3,
  'src/app/(app)/gst/job-work/page.tsx': 3,
  'src/app/(app)/inventory/batches/page.tsx': 3,
  'src/app/(app)/inventory/godowns/page.tsx': 2,
  'src/app/(app)/inventory/recipes/page.tsx': 3,
  'src/app/(app)/inventory/serials/page.tsx': 3,
  'src/app/(app)/journal/page.tsx': 3,
  'src/app/(app)/ledger/page.tsx': 1,
  'src/app/(app)/payments/links/page.tsx': 1,
  'src/app/(app)/payments/page.tsx': 1,
  'src/app/(app)/payroll/page.tsx': 2,
  'src/app/(app)/payroll/payslip/page.tsx': 1,
  'src/app/(app)/products/page.tsx': 1,
  'src/app/(app)/projects/page.tsx': 4,
  'src/app/(app)/recurring/page.tsx': 2,
  'src/app/(app)/vendors/page.tsx': 1,
  'src/components/CommandPalette.tsx': 1,
  'src/components/OrderDocument.tsx': 1,
  'src/components/OrderRegister.tsx': 1,
}
for (const [file, count] of Object.entries(EXPECTED_COUNTS)) {
  eq(`A6. ${file} opens ${count}`, dialogs.filter(d => d.file === file).length, count)
}

// ── B. every dialog is announced and none carries a markup tabindex ───────────
for (const d of dialogs) {
  const at = `${d.file}:${d.line}`
  ok(`B1. ${at} carries an aria-label`, /aria-label=/.test(d.tag), d.tag.slice(0, 80))
  ok(`B2. ${at}'s aria-label is not empty`, !/aria-label=(""|\{\s*(?:''|"")\s*\})/.test(d.tag))
  ok(`B3. ${at} declares aria-modal="true"`, /aria-modal="true"/.test(d.tag))
  // The hook sets tabindex="-1" at runtime; markup must not fight it or add a second tab stop.
  ok(`B4. ${at} has no markup tabindex`, !/\btabindex\s*=/i.test(d.tag))
}

// ── C. refs and declarations are a perfect matching in every wired file ──────
const DECL = /(?:const|let)\s+(\w+)\s*=\s*useDialog\s*\(/g
let declared = 0
for (const file of dialogFiles.filter(f => f !== palettePath)) {
  const src = sources.get(join(ROOT, file))
  const decls = [...src.matchAll(DECL)].map(m => m[1])
  const refs = wired.filter(d => d.file === file).map(d => {
    const m = d.tag.match(/ref=\{(\w+)\}/)
    return m ? m[1] : null
  })
  declared += decls.length
  eq(`C1. ${file}: one declaration per dialog`, decls.length, refs.length)
  for (let i = 0; i < refs.length; i += 1) {
    ok(`C2. ${file}: dialog ${i + 1} has a ref`, refs[i] !== null)
    if (refs[i] !== null) {
      ok(`C3. ${file}: ref ${refs[i]} is declared`, decls.includes(refs[i]), `declared ${JSON.stringify(decls)}`)
    }
  }
  for (const name of decls) {
    ok(`C4. ${file}: ${name} is attached to a dialog`, refs.includes(name))
  }
  // Multi-line imports count: test the whole statement, not its last line.
  const imports = [...src.matchAll(/import\s+[^;]*?from\s+'@\/components\/ui'/g)].map(m => m[0])
  ok(`C5. ${file}: imports useDialog from the kit`, imports.some(i => i.includes('useDialog')))
}
eq('C6. useDialog declarations across the wired files', declared, 56)
eq('C7. the palette is the one dialog without a ref', dialogs.filter(d => !/ref=\{/.test(d.tag)).length, 1)
ok('C8. that one is the palette', palette && !/ref=\{/.test(palette.tag))

// Only the kit may define the hook.
const definitions = files.filter(p => /(?:export\s+)?function\s+useDialog\s*\(/.test(sources.get(p)))
eq('C9. one definition of useDialog in the tree', definitions.length, 1)
eq('C10. it lives in the kit', definitions.length === 1 ? rel(definitions[0]) : '', 'src/components/ui.tsx')

// ── D. the hook's source ──────────────────────────────────────────────────────
const hook = sources.get(join(SRC, 'components/ui.tsx'))
const pins = [
  ['D1. exported signature', 'export function useDialog(onClose: () => void)'],
  ['D2. latest close kept in a ref', 'const closeRef = useRef(onClose)'],
  ['D3. the ref is refreshed every render', 'closeRef.current = onClose'],
  ['D4. null unmount is a no-op', 'if (!node) return'],
  ['D5. React 19 narrowing', 'const el = node'],
  ['D6. the dialog becomes focusable at runtime', "el.setAttribute('tabindex', '-1')"],
  ['D7. a module-level opener trail exists', 'const OPENER_TRAIL: HTMLElement[] = []'],
  ['D8. server rendering binds no listener', "if (typeof document !== 'undefined') {"],
  ['D9. the trail records focus moves', "document.addEventListener('focusin', (event) => {"],
  ['D9a. focus is recorded through the one helper', 'rememberOpener(event.target instanceof Element ? event.target : null)'],
  ['D9b. clicks are recorded too', "document.addEventListener('click', (event) => {"],
  ['D9c. a click records its nearest focusable control', 'rememberOpener(target.closest(DIALOG_FOCUSABLE))'],
  ['D9d. the body is never an opener', 'candidate === document.body'],
  ['D9e. the trail is bounded', 'if (OPENER_TRAIL.length > OPENER_TRAIL_MAX) OPENER_TRAIL.shift()'],
  ['D9f. the opener is walked back at mount', '[...OPENER_TRAIL].reverse().find((candidate) =>'],
  ['D9g. only elements outside the dialog qualify', 'candidate !== el && !el.contains(candidate) && candidate.isConnected'],
  ['D10. topmost wins', "document.querySelectorAll<HTMLElement>('[role=\"dialog\"]')"],
  ['D11. topmost is the last in DOM order', 'open[open.length - 1] === el'],
  ['D12. only visible controls are trapped', '.filter(item => item.tabIndex !== -1 && item.getClientRects().length > 0)'],
  ['D13. an IME composition ends without closing', 'if (e.isComposing) return'],
  ['D14. Escape closes through the caller', "if (e.key === 'Escape')"],
  ['D15. Escape is consumed', 'e.preventDefault()'],
  ['D16. Escape calls the caller\'s close', 'closeRef.current()'],
  ['D17. other keys are ignored', "if (e.key !== 'Tab') return"],
  ['D18. Shift+Tab wraps to the last control', 'last.focus()'],
  ['D19. Tab wraps to the first control', 'first.focus()'],
  ['D20. the listener is bound in the capture phase', "document.addEventListener('keydown', onKey, true)"],
  ['D21. it is removed on unmount', "document.removeEventListener('keydown', onKey, true)"],
  ['D22. focus is taken on the next frame', 'window.requestAnimationFrame(() => {'],
  ['D23. only if a field did not already take it', 'if (alive && !el.contains(document.activeElement)) el.focus()'],
  ['D24. the pending frame is cancelled', 'window.cancelAnimationFrame(frame)'],
  ['D25. focus goes back to the opener', 'if (opener && opener.isConnected) opener.focus()'],
  ['D26. the cleanup sets the dead flag', 'alive = false'],
  ['D27. the focusable selector spans links', "a[href], button:not([disabled])"],
  ['D28. it lets any custom tab stop in', '[tabindex]:not([tabindex="-1"])'],
  ['D29. the stable callback needs no dependencies', '}, [])'],
]
for (const [name, pin] of pins) ok(name, hook.includes(pin), pin)

// The two capture points the drive disproved. Render-time focus is <body> for a hook declared in
// an always-mounted page; ref-attach time is the autoFocus'd field, because React attaches a ref
// after commitMount. Neither may come back: the opener is the focus trail or it is nothing.
const refBody = hook.slice(hook.indexOf('return useCallback((node'))
ok('D30. the ref callback does not recapture the opener', !refBody.includes('const opener = document.activeElement'))
ok('D31. no render-time opener state', !hook.includes('useState'))
ok('D32. the comment names the autoFocus ordering', hook.includes('after the mount has already moved focus to'))
ok('D33. the comment names the page-level failure', hook.includes('always-mounted page reads <body>'))

// ── E. one shared listener, the palette's, and no page-local Escape handler ──
const keydownFiles = files.filter(p => /addEventListener\('keydown',\s*onKey/.test(sources.get(p))).map(rel).sort()
eq('E1. only two keydown listeners in the tree', keydownFiles.length, 2)
eq('E2. the shared hook and the palette', keydownFiles.join(','), 'src/components/CommandPalette.tsx,src/components/ui.tsx')

const recipes = sources.get(join(SRC, 'app/(app)/inventory/recipes/page.tsx'))
ok('E3. recipes has no local keydown handler', !/addEventListener\('keydown'/.test(recipes))
ok('E4. the deleted local-effect comment is gone', !recipes.includes('A modal closes on Escape'))
eq('E5. recipes still wires all three dialogs', [...recipes.matchAll(DECL)].length, 3)

// ── F. the palette is the exemption the comment claims ───────────────────────
const paletteSrc = sources.get(join(SRC, 'components/CommandPalette.tsx'))
ok('F1. the palette names itself', paletteTagHas('aria-label="Command palette"'))
ok('F2. the palette declares no useDialog',
  !/(?:const|let)\s+\w+\s*=\s*useDialog\s*\(/.test(paletteSrc) && !/useDialog\s*\(/.test(paletteSrc))
ok('F3. the palette closes itself on Escape',
  paletteSrc.includes("if (e.key === 'Escape' && openRef.current)"))
ok('F4. the palette stops the key reaching the page', /e\.stopPropagation\(\)/.test(paletteSrc))
ok('F5. the palette remembers its opener',
  paletteSrc.includes('const opener = document.activeElement as HTMLElement | null'))
ok('F6. the palette restores it', paletteSrc.includes('opener.focus()'))
ok('F7. the stale sentence is gone', !paletteSrc.includes('Page modals below do not listen for Escape'))
ok('F8. the truthful replacement names the stand-down',
  paletteSrc.includes('The palette is the last [role="dialog"] in the DOM') &&
  paletteSrc.includes('stands down'))
ok('F9. the hook comment names the one exemption',
  hook.includes('one dialog with no shared ref'))
ok('F10. the hook comment says why the palette keeps its keys',
  hook.includes('it is a listbox, Tab is deliberately cancelled there'))

function paletteTagHas(fragment) {
  return Boolean(palette) && palette.tag.includes(fragment)
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} of ${pass} assertions failed\n`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ dialog28 — ${pass} assertions, 0 failing`)
