# TaxFlow India — Development Rules

**Version:** 2.0  
**Date:** October 2026  

---

## Rule 1 — Build One Thing at a Time

Never try to build multiple features simultaneously.
Complete one feature fully, test it, then move to the next.

```
✅ CORRECT: Build invoice form → test → confirm working → move to next
❌ WRONG: Build invoice form + PDF + email all at once
```

---

## Rule 2 — Test Before Moving On

Every feature must be tested before the next phase begins.
Use the TEST THIS checklist at the end of each feature.
If something fails, fix it before continuing.

"Tested" means: `npx tsc --noEmit` clean, `npm run build` clean, the library's own assertions passing, and the page opened in a browser at both a phone and a desktop width.

---

## Rule 3 — Ship After Every Feature

After every feature is tested and working:

```bash
git add <the files you touched>        # never `git add .`
git commit -m "<what changed and why>" # HEREDOC for multi-line messages
git push                               # main is the working branch; Vercel auto-deploys
```

Stage by name. The repo carries scratch files (`new 1.txt`, `vibe_images/`) and `.env.local`; a blanket add sweeps them in. Nothing goes into a commit that could reveal a credential, a token or a connection string.

---

## Rule 4 — Never Hard-Code GST Rules

GST rates, thresholds, and rules change via government notifications.

```typescript
// ❌ WRONG — hard-coded
const gstRate = 18

// ✅ CORRECT — from product master (configurable)
const gstRate = product.gst_rate
```

All GST rates live in the database. Historical invoices retain the rate at time of creation.

---

## Rule 5 — Always Filter by organization_id

Every database query that returns business data MUST filter by organization_id.
No exceptions.

```typescript
// ❌ WRONG — returns all invoices from all businesses
const { data } = await supabase.from('invoices').select('*')

// ✅ CORRECT — only this business's invoices
const { data } = await supabase
  .from('invoices')
  .select('*')
  .eq('organization_id', orgId)
```

---

## Rule 6 — Store Invoice Data at Time of Creation

Invoice line items must store the product name, HSN, rate and tax at the time the invoice was created. Never reference the product master for historical invoice display.

```
Why: If a product's price changes next month,
old invoices must still show the original price.
```

```typescript
// ✅ CORRECT — store all values in invoice_items
{
  item_name: product.name,      // copied, not referenced
  hsn_sac: product.hsn_sac,    // copied
  rate: product.selling_price,  // copied
  gst_rate: product.gst_rate,   // copied
}
```

---

## Rule 7 — Handle Errors Gracefully

Every database call must handle errors. Never let an error crash the page silently.

```typescript
// ✅ CORRECT
try {
  const { data, error } = await supabase.from('invoices').insert(...)
  if (error) throw error
  // success
} catch (err: any) {
  setError(err.message || 'Something went wrong')
} finally {
  setSaving(false)
}
```

---

## Rule 8 — Loading States on Every Action

Every button that triggers a database call must show a loading state.

```typescript
const [saving, setSaving] = useState(false)

// Button
<button disabled={saving}>
  {saving ? 'Saving...' : 'Save Invoice'}
</button>
```

---

## Rule 9 — Validate Before Saving

Validate all required fields before making any database call.

```typescript
// ✅ CORRECT — validate first
if (!customerId) { setError('Please select a customer'); return }
if (!placeOfSupply) { setError('Please select place of supply'); return }
if (validItems.length === 0) { setError('Please add at least one item'); return }

// Then save
await supabase.from('invoices').insert(...)
```

---

## Rule 10 — GSTIN Format Validation

Always validate GSTIN format before saving. Use the validateGSTIN() function from constants.ts.

```typescript
import { validateGSTIN } from '@/lib/constants'

if (gstin && !validateGSTIN(gstin)) {
  setError('Invalid GSTIN format')
  return
}
```

GSTIN format: 2-digit state code + 10-char PAN + 1 entity + Z + 1 checksum = 15 characters.

---

## Rule 11 — Never Directly File GST Returns

The app prepares data for GST returns. It does NOT file returns directly.

Always show this warning on GST reports:
```
⚠️ This report is prepared from your books of accounts.
Always verify figures against the official GST portal before filing.
```

---

## Rule 12 — Financial Calculations Use 2 Decimal Places

All monetary amounts are stored and displayed with exactly 2 decimal places.
Use the round2() helper for intermediate calculations.

```typescript
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
```

Grand total is rounded to the nearest whole rupee. Round-off difference is stored separately.

Storage and calculation are always paise-exact. **Display** may drop paise when the layout demands it — a dense statutory grid (GSTR-9's ten-column reconciliation) formats whole rupees with `Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })` because `₹13,04,500.00` overflows the column. Never round a number that feeds a total; round only the string a user reads.

---

## Rule 13 — File and Folder Naming

| Type | Convention | Example |
|------|-----------|---------|
| Pages | lowercase with hyphens | `credit-notes/page.tsx` |
| Components | PascalCase | `InvoiceDocument.tsx` |
| Utilities | kebab-case | `gst-engine.ts`, `party-ledger.ts` |
| Constants | camelCase | `constants.ts` |

A route's page keeps its own markup and CSS; anything that computes, validates or formats goes to `src/lib` as a pure function so it can be tested without a browser.

---

## Rule 14 — TypeScript Types

Always define types for data structures. Avoid `any` in new code.

```typescript
// ✅ CORRECT
type Invoice = {
  id: string
  invoice_number: string
  grand_total: number
  payment_status: 'unpaid' | 'partial' | 'paid'
}

// ❌ AVOID
const invoice: any = ...
```

**Known baseline:** there are no generated Supabase types, so rows come back as `as any[]` and eslint reports `no-explicit-any` on every page that queries. Do not "fix" the baseline inside a feature commit — lint only your own files and compare against a sibling page (e.g. `npx eslint src/app/\(app\)/gst/gstr3b src/app/\(app\)/gst/gstr9`). A shared row type (`MoneyDoc`, `RegisterRow`, `Gstr9Table`) defined once in the library is the right way out when a shape is reused.

---

## Rule 15 — Environment Variables

Never commit `.env.local` to GitHub.
Always use `NEXT_PUBLIC_` prefix for variables that need to be accessible in the browser.

```
# .env.local (never commit)
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

Set the same variables in Vercel dashboard for production.

---

## Rule 16 — No Unnecessary Libraries

Before adding a new npm library, ask:
- Can this be done with what we already have?
- Is this library well-maintained?
- Does it significantly simplify the code?

Current approved libraries:
- `@supabase/supabase-js` + `@supabase/ssr` — database and auth
- `next`, `react`, `react-dom`, `typescript`, `tailwindcss` — framework and styles
- `jspdf` + `html2canvas` — document PDF export in the browser (`src/lib/pdf-export.ts` screenshots one `#…-capture` region at `scale: 2`, and since R2-33 `downloadElementsAsPdf()` puts several regions into one file with a page each — the month's payslips — skipping a region that is not on the page instead of failing the pack)
- `tesseract.js` — OCR for the bill scanner, in the browser
- `pdfjs-dist` — text extraction from PDF bills; its worker is served from `/api/pdf-worker` so the version stays locked to the bundle

Deliberately **not** used: a component library (the kit in `src/components/ui.tsx` is the design system), a chart library (`ui.tsx` draws SVG bars), a date library (India-FY maths is a handful of pure functions), and any server-side LLM (the AI features are deterministic and local so a bill never leaves the device).

---

## Rule 17 — Navigation Is Data in One Place

New pages are added to `src/lib/nav.ts`, not to the shell markup. Both the sidebar and the ⌘K palette read `NAV_ITEMS`, so a page that is missing there is invisible in both.

```typescript
// NavLeaf: label, href and an Icon key from src/components/Icons.tsx — not an emoji
{ label: 'Reorder Planner', href: '/inventory/reorder', icon: 'cart' }
```

Rules that come with it:
- The `icon` string must exist in `Icons.tsx`; an unknown key silently falls back to `dashboard`, so look at the rendered sidebar before committing.
- A page reachable from the palette must accept `?q=` and filter on the **same columns** the palette searches (`ENTITY_SPECS.orColumns` in `commands.ts`), or a palette hit lands on an empty list.
- A list page that reads `useSearchParams` must be split into `XPageInner` plus a `<Suspense>` default export, because these routes prerender.
- Only genuinely important destinations join `BOTTOM_NAV` (mobile has four slots plus *More*).

---

## Rule 18 — Stock Movement Recording

Any operation that changes stock must use the `record_stock_movement` database function. Never update `products.current_stock` directly.

```typescript
await supabase.rpc('record_stock_movement', {
  p_organization_id: orgId,
  p_product_id: productId,
  p_movement_type: 'sale',
  p_quantity: -qty,  // negative for stock out
  ...
})
```

**Guard against a real data-loss bug:** a product edit must never rewrite `current_stock` from `opening_stock`. `current_stock` is seeded on insert only; recomputing it on update silently discards every movement since.

---

## Rule 19 — GST Compliance Warning

All pages that display GST return data must include this warning:

```
⚠️ Important: This report is prepared from your books of accounts.
Always verify figures against the official GST portal before filing.
GST rules and return schemas may change — verify at gstn.gov.in.
```

Say plainly what the app cannot see. Anything only the portal knows — filed 3B figures, Rule 42/43 reversals, ITCA-01, Table 8/9 detail — is either an owner-declared input labelled as such, or shown as a gap. Never estimate a statutory number and let it look like data.

---

## Rule 20 — Commit Message Format

One line that names the feature and the behaviour, and a body that explains the *why*. Phases are internal; the message should make `git log` readable on its own.

```
Statutory registers: party-wise, HSN/SAC, B2B, state-wise and e-way bill

Invoice document templates: modern band and minimal skins
```

```bash
git commit -m "$(cat <<'EOF'
Reorder planner: demand-driven (s,S) suggestions, supplier-grouped purchase orders

Body: why the decision was made, what the trap is.
EOF
)"
```

Bug fixes are committed with the bug named, not folded into a feature message (`Fix register line-item fetch 400, mobile toolbar overflow and 36MB invoice PDFs`).

---

## Rule 21 — Client-Side First, No Migrations

The Supabase schema is hand-managed in the dashboard and there are no migration files in this repo. A new feature therefore:

1. reads existing tables with explicit `.select()` lists,
2. keeps anything new in per-organisation `localStorage`,
3. ships as a workpaper or an export when the real integration needs a paid provider.

Do not invent a column, do not add a table, and do not write a migration "while you're in there". If a feature genuinely cannot work without schema change, say so and ship the version that does — that is how e-invoicing, the offline outbox and the ledger all shipped.

---

## Rule 22 — One Write Path Per Document

`src/lib/create-invoice.ts` and `src/lib/create-bill.ts` are the only ways to write an invoice or a purchase bill. The invoice form, POS and the offline replay all call the same helper, which is why an offline invoice cannot diverge from an online one.

A new feature that creates a document calls the helper. It does not re-implement sequence numbering, line-item insert, tax totals or the stock RPC. (The same applies to shared read paths: `registers.ts` fetches line items in 500-id batches because a full-FY `in (...)` list returns 400.)

---

## Rule 23 — Pure Libraries, Tested Without a Browser

Anything in `src/lib` must be free of React and of I/O: it takes rows in, returns numbers and strings, and can be executed with the TS loader.

```bash
node --experimental-strip-types --no-warnings --import /tmp/jr-register.mjs /tmp/<lib>-test.mjs
```

`--import` works **only when the module it imports is a registrar**, not the hook itself: `/tmp/jr-register.mjs` is two lines — `import { register } from 'node:module'`, then `register('/tmp/jr-hooks.mjs', 'file:///tmp/')` — and `jr-hooks.mjs` is the `resolve()` hook that maps `@/lib/x` onto `<repo>/src/lib/x.ts` and gives an extensionless relative specifier its `.ts`. Importing the hook file directly does nothing, and `--loader /tmp/ts-loader.mjs` (the older form, still on disk and still working) is deprecated on this Node — the registrar is the recipe to copy forward.

Assertions are written against the domain, not the implementation: FY-weighted splits must sum to exactly the annual plan, a credit note must reduce the month it is dated in, `csvFromRows` must quote a field containing a comma, a PF ceiling must change on the 17th of September and not the day before.

**Suites are per-round throwaways in `/tmp` and are never committed** (`/tmp/payroll-test.mjs` is 435 assertions over the salary register, its R2-32 attendance half `/tmp/attendance-test.mjs` is 212, the R2-33 document half `/tmp/payslip-test.mjs` is 394, its R2-34 kept-page half `/tmp/daybook-test.mjs` is 247, and the R2-30 shopping suite is 95). `/tmp` gets wiped mid-project — it happened twice, and the second time took seventeen suites with it — so a round records **its own** assertion count and says plainly that the older ones were not re-run, rather than quoting a running total it cannot prove. A suite is cheap to rewrite from the library's own exports, and the claim worth keeping in the docs is *which rule each assertion polices*, not the number.

---

## Rule 24 — Local Storage Is Namespaced Per Organisation

```typescript
const KEY = 'taxflow:<feature>:' + orgId      // never a bare global key
```

Store a `version` field and an `updatedAt` timestamp so a shape change can migrate instead of crash, and treat a parse failure as "start fresh" rather than throwing. A shared browser must never show one business's targets, filing profile, outbox or template choice to another.

Anything a user would grieve losing must be reconstructible from documents or exportable (CSV, `.ics`, JSON) — a cleared browser is a normal event, not a disaster.

**A heading is not a register.** R2-33's payslip letterhead went **inside** `taxflow:payroll:<orgId>` rather than earning a key of its own: the paper is a reading of the salary book, so its heading lines belong to the book that computes its figures — and the vault spec list, `PAYROLL_VERSION` and the backup walk all stayed exactly as they were.

---

## Rule 25 — Use the Design System

Build from `src/components/ui.tsx` primitives and `.tf-*` classes, and reference `var(--token)` in page CSS. New hex literals in a page are a regression, and a page being edited should come out of the file it is in.

Numbers in a column get `.tf-num`. Mobile is not an afterthought: CSS-grid tables switch to labelled cards at 768px, and because rupee amounts have no break opportunity, **one figure per line** on mobile — verify with `scrollWidth − clientWidth === 0` on every scroll container. Watch selector specificity: a desktop `.cols > .is-right` rule outranks a mobile `.cols > span` rule.

Icons come from `Icons.tsx`. Emoji are not the interface language — the partly-migrated lists (`bills`, `credit-notes`, `debit-notes`, `quotations`) and a few content strings still carry some (`✓` empty states, the document's `🏢` logo placeholder); do not add more.

---

## Rule 26 — Verify in the Browser Before Committing

```bash
npm run dev    # http://localhost:3000
```

Use the test account only to log in to the local dev server. **Never write a credential into a file, source, fixture or commit, and do not open or quote `.env` / `.env.local`.**

What "verified" means for a page:
- the golden path runs against real data and the console is clean;
- numbers agree with a hand-check (one FY turnover figure, one ITC total, one ageing bucket);
- the layout holds at a phone width (371–455px is what the verification panel gives you natively) **and** at 1440px — inject a same-origin iframe at 1440×900 and read `getComputedStyle` / `scrollWidth` from inside it;
- anything you created to test (a draft invoice, a scan, a plan) is cleaned up through the app's own Cancel/Deactivate, and verification-only `localStorage` blobs and helper iframes are removed before the commit.

Screenshots are not informative in this environment — DOM and computed-style reads are the authority.

---

## Rule 27 — Honest Scoping Beats a Fake Integration

Where a real integration needs money or an agreement (GSP for e-invoice/e-way bill, a bank feed, portal filing), ship the deterministic part and label the rest. Examples already in the app: e-invoice builds NIC v1.10 JSON the user pastes into the portal; the GSP layer has a mock provider behind an adapter so a real one drops in; bank data is entered or imported rather than aggregated.

A feature that quietly invents a statutory figure is worse than no feature.

---

## Rule 28 — Money Maths: Sign First, Absolute Never

Credit notes are signed rows (`document_type: 'credit_note'` → −1) and must reduce the period they are dated in. `Math.abs()` on a signed amount is always a bug. Targets and registers measure **taxable value with GST excluded**. Payments tie to a document before a name, and a receipt pointing at a cancelled or missing document is dropped rather than credited to a same-named party.

---

## Rule 29 — A Statutory Period Is a Dated Table, Not a Constant

How long export proceeds may take to reach India is not one number: `REALISATION_BANDS` in `src/lib/exports.ts` runs nine months → fifteen from 13-11-2025 → nine from 05-06-2026 → fifteen (eighteen for rupee-denominated trade) from 01-10-2026, and `ADVANCE_BANDS` moved twelve → thirty-six in the same amendment. A period that a regulator can amend is therefore stored as **bands keyed by the date the clock starts on** — the date of export, not today — and every band carries `from`, `months`, `rupee_months`, its `source` instrument with a `url`, and a `note` written the way it would be quoted to a bank. `bandOn(date)` takes the **last band whose `from` is on or before that date**; nothing reads a bare constant.

Two obligations come with the shape:

- **A source disagreement is kept visible, not resolved silently.** The November-2025 amendment is dated 13-11-2025 by one source and effective 14-11-2025 by another, so the band carries `disputed: { from, to, instead_months, why }` and the page prints the one-day gap **as a question** with both answers. Picking a side would look tidier and would be a guess the user cannot see; the register lets a file override the window and labels the override wherever it shows.
- **A rule the app cites is labelled as cited.** `SERVICE_INVOICE_DAYS = 30` (rule 47 read with section 31(2), from CBIC's *Handbook on Invoicing under GST*) prints on `/projects` as *cited, not settled*, because notifications widen the window for classes of supplier. Same reason `indicative_tax` on `/gst/job-work` is always labelled indicative.

The rate table is the weaker form of the same discipline and stays that way on purpose: `src/lib/gst-rates.ts` records the 56th Council's effective date (22 Sep 2025) in its header and keeps the retired 12% and 28% slabs so a credit note against an old invoice can still repeat the original rate. Where a *period* is what moves — the FEMA window, the advance window — a dated header is not enough, because the period is computed from a date the document carries: that table has to be keyed, and `bandOn()` has to be the only reader of it.

**R2-31 keyed a *rate* the same way.** `PF_WAGE_CEILINGS` in `src/lib/payroll.ts` is ₹15,000 up to 16-09-2026 and ₹25,000 from 17-09-2026 (S.O. 5109(E)), and a run reads the ceiling for **its own salary month** through `pfCeilingOn(monthLastDay)` — a September payroll computed against an August ceiling is a different payroll — which is why the month CSV carries *PF ceiling used* as its own column. Two consequences come with it. The bands of **different statutes are allowed to disagree on the same payslip**: ESI kept its ₹21,000 ordinary ceiling (₹25,000 for a person with disability) while PF moved, so the page prints the disagreement as a finding instead of harmonising it away. And a ceiling the regulator has not settled — whether EPS' *pensionable* salary moved with the contributory one — becomes an **owner-set figure printed on every slip with the value it used**, never a default hidden in arithmetic.

---

## Rule 30 — A Feature's Deadlines Are Read From That Feature

`/gst/calendar` does not invent dates and does not ask the profile to tick a box: it **calls the register that owns the obligation** and merges the rows. `generateEvents()` draws the statutory return dates, `jobWorkEvents()` reads `loadJob()` + `itc04Periods()` (movements recorded ⇒ statements owed), `exportEvents()` calls `watchRows()` on the export register — LUT renewal, the FEMA realisation window, the section 54(1) refund clock and the advance-dispatch clock — and since R2-31 `payrollEvents()` emits an ECR / ESIC / salary-TDS row for every month the salary register actually ran, one ESI return per contribution period it touched and one Form 16 row for the year. Each carries the file's own id and href, so a calendar row and the register it came from cannot disagree and a deleted file's deadline disappears with it. **When a register files a month, the profile's guess for that month is dropped** — the payroll rows filter out the tick-box's monthly PF/PT entries, matching after stepping back one month because a guessed row names the *deposit* month and the register names the *salary* month. A duty with no national date (professional tax is a state subject) gets `due: ''`, lands in its own *State dates* rail, counts as neither overdue nor due soon, and stays out of the `.ics` — an .ics event needs a start date, and inventing one is the error this rule exists to prevent.

Two consequences to respect when adding the next one:

- **A non-GST default carries words, not a rate.** FEMA rows land in `category: 'other'` with `penalty.note` naming what actually happens (the AD bank can hold further exports until a contravention is condoned; section 54(1) simply runs out). The ₹-per-day estimator must stay silent on a default it has no statutory late fee for — inventing a number is Rule 27's fake figure in calendar clothing.
- **Filtering is the calendar's job, not the feature's.** `exportEvents()` clips to the selected FY after `watchRows()` returns, so the register stays complete and the year shown is a view.

---

## Rule 31 — A Backup Walks a Named List and Restores Through the Owners

`src/lib/vault.ts` holds `REGISTERS` — one `RegisterSpec` per device-side key, thirty-four of them — and `takeBackup()` walks **that list and nothing else**. A sweep of localStorage would catch the Supabase auth keys (`sb-*`) alongside the books; walking named entries is what keeps session material out of a file the user emails to their CA. Every spec names its group, its owning page, its encoding, its row counter and — for the 29 restorable ones — the `write` function that saves it.

Restore goes **through the owner, then proves it**: `applyRestore()` calls `spec.write(orgId, data)`, then `spec.verify()` — the register's own loader — and prints `from → seen` per register, so rows silently dropped by a parser are counted, not lost. A direct `setItem` would bypass every parser and every version check the register owns. Three guards stand before any write, each refusing by name: the **org** (`foreign` — the file belongs to another business), the **checksum** (per-block FNV-1a — a truncated or edited block is refused even when the JSON parses), and **shape** (`accepts()` — the register's own type guard, so a v2 shape cannot be forced into a v1 loader).

Consequences to respect when the next register appears:

- **A new `taxflow:<name>:<orgId>` key must join `REGISTERS` in the same round that creates it** — otherwise the register is real but unownable: invisible to the backup and un-restorable after a browser wipe. Evidence-only logs (outbox, e-way bills, Tally import, palette recents, compliance profile) are collected into the file with `write: undefined` and a reason, so the restore plan can *show* them and never *write* them — replaying a pending invoice would bill it twice.
- **Restore is not a transaction, and every attempt is logged.** Registers restore one by one and the run stops nowhere — a refusal mid-run leaves the earlier writes in place, which is why the plan (nine states, plan-before-write, `blank` selectable but never pre-ticked) is the page's main product and why the vault's own log (`taxflow:vault:`) records refused runs too. That log is deliberately **not** in the vault itself: a backup that recorded its backups would grow every time it was restored, and "when did you last take this file" belongs to the browser that took it.

---

## Rule 32 — A Pasted Sheet Is Planned, Approved and Thrown Away

A shop does not keep payroll; it keeps an attendance sheet. R2-32 turned that paste into lost days on `/payroll`, and the shape it took is the pattern for every sheet this app will be asked to read afterwards. R2-34 then gave the days that pattern reads somewhere to live — a kept **day book** (Rule 34) — without changing anything below: the month run still reads a paste for one figure and stores no sheet.

The engine splits into two functions with a click between them. `planAttendance(store, month, text)` is pure: it returns the delimiter it settled on, every column with its role, the **basis** with the sentence that justifies it, the matches, the refusals, the findings, and the sheet-level blockers. `applyAttendance(orgId, month, plan)` is **the only door**, and it re-checks the plan's own month against the screen's before writing a row — a preview read against September must not land on the October run. Nothing is written while a blocker stands, "Do not apply" has to write literally nothing, and the page must be able to show both.

Four refusals are non-negotiable, and each exists because the alternative was a silent guess:

- **A number with no direction is refused, never defaulted.** `LOP_HEADERS` and `PRESENT_HEADERS` decide which way a column points, `AMBIGUOUS_HEADERS` (`days`, `total`, `count`) name a number without pointing it anywhere, and `SERIAL_HEADERS` are excluded from identity on purpose — reading `Sl. No` as a payroll code would match strangers. A lone column of numbers produces a blocker instead of a payroll.
- **The sheet's own basis outranks the shop's setting.** A `24/26` cell states its month length, so `AttendanceBasis.kind` becomes `sheet` and the setting is not consulted; when a row carries *both* a present and a lost column they must agree to the day, and when they do not, the row is refused — `“the register will not choose between two numbers that contradict each other”`. Blank means *the sheet does not say*, which is not zero: a person on the rolls the sheet never mentions keeps the lost days they had and is printed as a finding naming them.
- **Nothing is written that the register's own form would refuse.** Every candidate row goes back through `validateInput()` *inside* the write, because the People tab may have moved a joining date between the preview and the click. A row that no longer passes is skipped and named in the receipt rather than force-fitted.
- **A paste is read, not kept.** The bytes that reach `taxflow:payroll:<orgId>` are one `lop_days` number and a `[attendance <month>]` sentence stamped into that month row's note — re-importing a month **replaces** that segment (`stampAttendanceNote`) instead of stacking a second answer to the same month, and text the owner typed after the em dash survives. No new key, no new register, no version bump, and the vault spec's `what` line says the sheet itself is never kept. Since R2-34 the *days* a date-ruled page names can be kept — that is the day book, and it is a different write through its own door (Rule 34); the paste's bytes still never reach storage.

Two conventions come with it. **Reuse the reader you have**: `planAttendance` calls `detectDelimiter()` and `splitRow()` from `bank-statement.ts` rather than writing a third parser for a comma-or-tab paste — Rule 16's economy applied inside `src/lib`. And **print the sheet you want back**: `attendanceTemplate(store, month, grid)` rules the month's roster with the register's *own* codes, so a paste can fail on a missing line but not on a spelling.

**A preview belongs to the selection it was read against**, and resetting it from an effect is banned by `react-hooks/set-state-in-effect`. The house answer is React's adjust-during-render recipe — keep the previous value in state and clear the dependent state while rendering, so the stale sheet is never painted for a frame:

```tsx
const [sheetMonth, setSheetMonth] = useState(month)
if (sheetMonth !== month) { setSheetMonth(month); setPlan(null); setApplied(null); setText('') }
```

---

## Rule 33 — Printed Paper Is a Reading of the Engine, Never a Second Computation

Every payroll product in India hands the employee a payslip, and this app now prints one (`src/lib/payslip.ts`, `/payroll/payslip`). The rule the round established is older than the payslip: **a document page lays out what the engine computed; it does not work anything out again.**

`buildPayslip(store, slip, workspaceName, today)` receives the `Payslip` that `payslipOf()` returned and arranges its lines. It re-derives no rupee — a slip that added up its own columns could disagree with the register it came from, which is precisely the failure ADR-034 exists to prevent. The suite therefore polices the **tie**, not the layout: `earnings_total = monthly structure + arrears + bonus`, `deduction_total = loss of pay + the statutory legs`, `net_pay` landing on the engine's figure, `employer_legs_total` summing only the legs printed under its own heading, and `employer_cost − net_pay = employer_legs_total + deduction_total − loss of pay` (loss of pay counted once, because it is already taken off inside gross).

Four conventions travel with any sheet this app prints:

- **A statement, not a payment.** The line says *Net payable*. Whether money moved is a fact about the bank; `/expenses` and `/payments` remain the only writers. Standing sentences — `PAYSLIP_BOUNDARIES`, four of them — print on every slip: payable is not paid, statutory columns are computed not recorded, **this is not Form 16**, and nothing here is filed.
- **A refusal produces no figures at all.** `printable: false` carries the engine's `why_not`, the deduction and employer blocks are not laid out, the header states the refusal **instead of a ₹0.00 net**, and Print/PDF stay disabled with that reason as their tooltip. Nobody signs a salary of nothing.
- **Absence is a dash with a sentence, zero is a claim.** `SlipLine.amount: number | null` plus `dash`. The same holds for identifiers: the letterhead's four statutory codes are *asked for* and a blank prints a dash beside the line naming what it would be needed for — a statutory-looking document carrying an invented establishment code is worse than one carrying a dash.
- **Exceptions stay on the owner's side of the paper.** Register flags, letterhead gaps and a missing UAN / ESIC number / PAN print in a `.no-print` strip beside the sheet; the employee's copy carries its own facts only. A batch keeps its refusals visible too: `monthPack()` returns `docs` **and** `refused` with `partial`, so a printed pack is never silently a subset.

Print and PDF must be **the same document**: the capture region is padded so its padding becomes the A4 margin (`@page { size: A4 portrait; margin: 15mm }`, everything else hidden), and a pack goes through `downloadElementsAsPdf()` — one file, a page per region, a missing region skipped rather than the whole pack failing.

**Rule 26 caught what the suite could not.** The 394 assertions could not see the page-level branch that made a refused month print *"net payable ₹0.00"* with Print enabled, because the header builds its subtitle out of document fields. When a page has a *no-figures* branch, drive that branch in the browser.

---

## Rule 34 — A Kept Record Is Evidence; One Deliberate Pull Moves It

R2-34's day book (`src/lib/attendance.ts`, `/payroll`'s *Day book* tab) is the app's first **kept** record that is neither a document nor a money register: one attendance mark per person per day — `{employee_id, date, mark, source, note, written_at}` — stored as evidence and holding no rupee. It is the pattern for any future *"the shop wrote it down"* register.

Five conventions come with it:

- **The doctrine is data, not decoration.** *Unwritten days are not absent days* is `DayBook.doctrine`, printed on the page and enforced everywhere the book touches money: a blank day is counted nowhere, a person the book never wrote is `untouched` by the pull **rather than zeroed**, and an empty book **refuses** to pull at all — *"an empty book is not a month of absents — nothing is pulled, and nothing is deducted."*
- **A refusal is data too — carry the `kind`, never parse the sentence.** The sheet reader's refusals cross into the marks bridge by their machine-readable `kind` (`identity` / `scale` / `mark` / `blank` / `figure`): every kind stops the whole page, because a book with a silent gap in it looks complete — the one exception is `blank`, which is the sheet agreeing with the book's own doctrine, so it is noted and skipped as *not a refusal either*. A bridge that matched on the refusal's wording would have refused the register's own ruled template the day its trailing note changed.
- **One door for the write, one click for the money.** `markDay()` refuses rather than guesses (a day that has not happened, before joining / after leaving, an inactive person, a mark the register cannot read) and an empty mark is a legal **clear**. `pullMonthFromBook()` is the only click on the tab that can change a salary figure, and it re-runs the month form's own `validateInput()` — a kept record can never smuggle past the month's rules.
- **The kept page is erasable, labellable and printable.** `clearMonthMarks()` erases one person-month and touches no month row; provenance shows on the grid (a mark read from a pasted sheet is outlined in dots); `dayBookCsv()` downloads the ruled page with its findings and its closing sentence, and `attendanceTemplate(…, grid = true)` rules a blank page that pastes back a year later.
- **Boundary, printed: it is a book, not a clock.** No device or biometric feed, no shift timings, no overtime priced from the marks, no per-day wage ledger, nothing filed — the marks are what the shop wrote, and the pull is the only thing they can move. Since R2-37 the marks are also evidence a job can draw hours from — as a **proposal, never a write** (Rule 37): the drawn row lands in the project's register, and the book itself still moves no rupee.

---

## Rule 35 — A Unit Pick Is All or Nothing; the Register Has the Last Word

R2-35 let a build draw at `/inventory/recipes` name the actual numbered units it took. The rule the round establishes: **where a lot answers *how many*, a serial answers *which one* — and an unnamed draw is legal while a half-answered one is not.** A draw that names no unit follows nothing (or the register's own oldest-first proposal); the moment one unit is named, the pick set has to be the whole draw.

Six conventions come with it:

- **Three states, and the empty one is a choice.** `unitIds` absent follows the shelf's proposal (`allocateSerials()` — longest on the shelf first); `[]` names none *deliberately*; a list names exactly those units — `unitPicksOf()` applies the shop's answer to the proposal rather than replacing it, and keeps an explicitly named unit that has left the shelf *in* the set so the library's verdict can name it instead of the UI silently dropping it.
- **A pick set covers the drawn quantity to the unit.** `validateSerialIssues()` only checks a line that picks, and then refuses: a unit not on the register, a unit named twice (*"one physical unit cannot go in twice"*), a unit booked against another part (*"a draw cannot take someone else's unit"*), a unit off the shelf — any status but in-stock, *In a build* included — and a count that does not equal the drawn quantity: *"The units on … cover 2 of the 3 drawn — the rest names no unit. Issue the whole draw or none of it."* A fractional draw can name no whole unit and says so. Unnamed draws never block; a partial one holds Save, and the refusal's own escape hatch is printed with it — *correct the units, or record the run with that part unnamed*.
- **The stored picks are a copy of a decision, not a balance.** Before a run is written the set faces the register's verdict read fresh that moment — the save holds the stamped set to `validateSerialIssues()` against the live `taxflow:serials:` + `taxflow:serialevents:`, and a plan recorded straight from the run list re-proposes both its lots and its units off the registers as they stand now — never trusting a promise made on the day the plan was written. ADR-031's lot rule, applied in unit terms.
- **The run writes through the register's own door.** `serialWritesFor()` emits one `issued` event per unit with the job as `doc_ref` ("Build JOB-… — Chocolate TCB-001 issued into the run") and the writes go through `serials.ts`'s `appendEvents()` — the append-only log, never a status field edited from the recipes page. The flash, the run-log trace (*"3 units issued — see which"*) and the run detail (`issued TCB-001, TCB-002, TCB-003`) all read the one `serialTrail()`, and `BUILD_CSV_HEADERS` keeps a *Units drawn* column beside *Lots drawn*.
- **A cancel turns the verb round and never overwrites history.** `reverseSerialWritesFor()` writes the `restocked` pair ("… went back on the shelf"), and `serialMovedOn()` refuses the *whole reversal*, by unit name, when a unit left `issued` since — sold, written off, or put back by hand — because restocking a written-off unit would resurrect it and restocking a hand-restocked one would claim the cancel did what a hand did. The shop decides; the register refuses and names the unit.
- **Boundary, printed: a run names what it took, not what it made.** The units a build *produces* are still numbered at the counter on `/inventory/serials` afterwards — a build knows a quantity and the register knows an identity — and a part is only offered picks at all when the register holds units of it (`serialledProducts`), exactly as lots are only offered for `batchedProducts`.

---

## Rule 36 — A Named Hour Is Costed Beside the Number, Never Inside It

R2-36 let a timesheet row at `/projects` name the person whose hours they were. The rule the round establishes: **a join may read a figure it does not own, and the reading prints beside the number it is not allowed to change.** An entry that names a payroll person is costed at that person's own employer cost for the entry's own month — while contribution stays billed revenue less attached spend, and the costed figure sits outside it, labelled.

Five conventions come with it:

- **The rows cross as data; the library still owns no payroll.** `projects.ts` imports nothing from `payroll.ts` — `HourCostRow` is a structural subset of payroll's own `HourCost` (`employee_id`, `name`, `month`, `cost_per_hour: number | null`, `basis`, `why`), so the Node strip-types suite exercises `costHours()` against hand-built rows, and the one-way dependency that keeps every client-side register testable survives a join between two of them. The page is where the two registers meet (`costPerHourFor`, `employeeById`, `offRosterWhy`).
- **The month is the entry's own.** A cost is looked up per `(employee_id, periodOf(entry.date))` — not by today, not by the project's life — because an hour's cost is a property of the month the work happened in: the ceiling, the lost days and the employer cost are read as of that month, the same person in two months is two figures, and the modal preview names the month it is reading (`October 2026: this person's hour cost ₹X`).
- **A refusal is a row, not a zero.** Where the register keeps the person off that month's roster (or never heard of them), the page synthesises a row with `cost_per_hour: null` and the register's own sentence — `offRosterWhy()`'s words, or *"Not on the payroll register."* — so `costHours()` returns a refusal that carries its reason and the page prints it as a finding, never a ₹0 that would read as a costless hour.
- **The reading never rewrites the register's number.** `after_labour = contribution − labour_cost` prints as its own row, marked *partial* whenever linked hours remain unpriced or typed-only hours exist (`costed_hours < hours`, `unlinked_hours > 0`), and the boundary copy says why: where the same wages are also attached to the project as a bill the two readings overlap — *read them together, do not add them*. A typed name is not a wage link, and the modal hint says so in those words.
- **Additive under the same version.** `employee_id` shipped under `PROJECTS_VERSION = 1`, because a version bump would read every existing register as empty — the one outcome the version stamp exists to prevent. An old envelope reads no link, which is exactly what was recorded before the field existed.

The line worth keeping: R2-34's day book is *evidence*, R2-36's join is a *reading*, and neither lets a job invent a wage. An hour nothing names stays priced only.

---

## Rule 37 — Another Register's Evidence Is Drawn, Never Copied; Only the Tick Writes

R2-37 let the timesheet at `/projects` draw hours from R2-34's kept day book. The rule the round establishes: **an hour can be drawn, not invented — one register may offer another's evidence as proposed rows, but only the owner's explicit tick, through the owner's own validator, writes anything.** The day book keeps evidence (a mark per person per day, no rupee); the project keeps measurements (an hours row); the draw is the seam between them, and it runs one way.

Six conventions come with it:

- **The rows cross as data; neither library imports the other.** `projects.ts` imports neither `attendance.ts` nor `payroll.ts` — the **page** reads a person-month through `dayBook()` + `markWork()`, maps on-roll cells into structural `BookWorkDay[]` (`{date, label, hours, why}`), and hands them to the pure `drawHours()`. The structural-subset discipline (third application, after `BookInput`/`docsFor` and `HourCostRow`) is what keeps both registers testable alone while a seam joins them.
- **The register's own divisor prices the day.** A present mark proposes the payroll register's own `hours_per_day` — a half mark proposes half — and the spelling is never re-parsed here: `markWork()` in `attendance.ts` is the one reader, so a mark learned once works everywhere. The draw invents hours no more than the book invents days.
- **A refusal is a row with the register's own sentence, and nothing is drawn from it.** A lost day, a paid-not-worked day, an unwritten day, an unreadable mark — each arrives as a `DrawnDay` with zero hours and the register's own `why` (*"A lost day — the register reads it as no work, so nothing is drawn from it."*, *"Unwritten — an unwritten day is not a day worked, and the draw will not invent one."*), printed in the draw list rather than dropped. A person with no page in the month refuses at the person level (*"No day of this person's book falls in … — there is no page to draw from."*), and an empty book refuses with the deep link that fixes it — *"… mark the days at /payroll, or log hours by hand."* (`/payroll?tab=daybook&month=YYYY-MM`).
- **`ticks: null` means proposal, never row.** `drawHours()` returns the days and pre-ticks only present and half days; the page un-ticks a day already on the project (linked or typed under the same name) and prints why, still allows ticking a day that has hours elsewhere on that date but does not propose it, and resets `ticks` to `null` whenever the picker changes — a proposal for one person must never be written against another.
- **The write goes through the owner's door.** Only the shop's tick reaches `upsertEntries()` — the same function the manual form uses — and every drawn row still passes `validateEntry` (a day that has not happened, a date before the project started, the 24-hour ceiling). The row carries its `employee_id` the moment it lands, so the R2-36 cost reading picks it up without a second step, and a note records the draw.
- **Boundary, printed: the hours flow one way.** The draw reads the book and writes the project, never the reverse: the mark prices nothing, a drawn hour is the project's own row, and deleting that row does not unwrite the day. Rule 34's boundary stands unchanged — no device feed, no overtime priced off the marks — and the draw reads only what the shop wrote, at the register's own hours a day.

---

## Rule 38 — A Closed Period Is Sealed, an Attempted Edit Is Logged, and the Trail Proves Itself

R3-1 gave the shop an append-only audit trail and a financial period lock at `/audit`. The rule the round establishes: **a decision about the books is kept as evidence, never as a rupee — the trail is append-only and proves its own integrity, a period can be sealed only after it has ended, and releasing a seal is a stamp on the record rather than a deletion of it.** Like the cost centres, the projects and the day book, `audit.ts` holds no money: a seal is a window, an event is a sentence, and the rupees stay in the documents the seal only governs.

Six conventions come with it:

- **The trail has one writer, and it numbers every row.** `append()` is the only function that touches `events`; every event gains a monotonic `seq` counting from 1 through it. `verifyChain()` walks the log *by number, not by order* — a run of 1,2,3,5 skipped a row, 1,2,2,4 re-used one — and names each break. It is a **checksum, not a signature**: it shows a hand-edit happened, it cannot say who, so the page prints "the trail is unbroken" and never a security claim stronger than that.
- **A seal closes a window that has ended, and only a window that has ended.** `sealPeriod()` refuses a range whose last day is today or later (*"A period is sealed only once it has ended — … the last day has not passed."*) and refuses one that overlaps a seal already standing. A month you are still in cannot be sealed and called history.
- **Releasing is not deleting, and no reason means no release.** `releaseSeal()` never removes the row: it stamps `released_at` and a `release_reason`, and the seal stays visible forever as a released seal. An empty reason is refused — *"Releasing a seal without a reason is a silent unlock"* — because a silent unlock is exactly what an auditor looks for.
- **The seal is a door the write path asks, not a wall around the store.** `sealGuard(orgId, date)` is the one question a document save calls before it writes; it reads the register and returns the register's own sentence, so the page never invents one. When the answer is yes the invoice page stops the save *and* `recordRefusal()` appends a `refused` event — the attempt is on the record even though nothing changed. Which paths consult the seal is printed on the page, because a lock that quietly covers only some doors is worse than one that names them.
- **The refusal reads as prose.** `recordRefusal()` builds its note article-aware (`an invoice`, `a bill`), and `sealGuard`/`sealPeriod`/`releaseSeal` each carry their own full sentence so every refusal quotes the register's wording, not a template with a hole in it.
- **Evidence rides the vault, holds no rupee, and files nothing.** `taxflow:audit:<orgId>` joined the vault in the same round it was created (Rule 31); its counts render through `StatCard` as **strings**, bypassing the card's default `formatCompactINR` so a register that keeps no money never shows "₹0". It lives in this browser (ADR-013), travels only inside the books vault, and files nothing with any authority — the seal is the shop's own discipline, not a portal submission.

---

## Rule 39 — The Shape of a Number Is the Shop's; the Counter Belongs to the Register, and a Branch Stamps Its Name

R3-2 gave the shop a branch register and configurable document series at `/business`. The rule the round establishes: **a number has two halves — the counter and the shape — and only the shape is configurable. The register that counts keeps counting exactly where it always did; the business register only dresses the number it prints. And a branch is a registration, not a label: it may change what a document says about where it was issued, never what it says about how much.**

Six conventions come with it:

- **The counter stays, the dress changes, and nothing is re-issued.** `composeNumber(fmt, n, fy)` wears whatever prefix, pad width and FY-inside the shop chose, but `n` still comes from the Supabase `invoice_sequences` row (invoices) or the order kind's own high-water walk (challans, both order registers). `seriesHistory()` + `usedNumber()` make the walk read **every shape a kind has worn**, so a mid-year change cannot number anything twice, a series that drops the year inherits the largest count the year-shaped series had reached, and papers already issued keep the shape they were born with — proven live: after a `TAX` override, invoice #12 previewed `TAX-2026-27-0012` while the list still read `INV-2026-27-00xx`.
- **One prefix, one series.** `validateSeries()` refuses a prefix two kinds would share (*"… already numbers … — two series with one prefix would issue the same number twice."*) before a shape lands — the collision check runs over the *other* kinds' live shapes, not the edited row's own history. Prefix is ≤ 8 characters of letters/digits/inner dashes, pad is 1–8 digits wide.
- **A branch is a registration, and the pair must agree.** A row needs a 15-character GSTIN (the same shape rule `einvoice.ts` checks — checksum digits are verified nowhere without a GSP, and the refusal says so) and the state code the GSTIN starts with: *"A Tamil registration cannot carry a <st> branch"* — because place of supply and the CGST/SGST split read that pair. Codes and GSTINs are unique on the register; typing a GSTIN pre-fills its state.
- **The head is held, not owned, and history does not go out of business.** Exactly one branch is head (the first one is, by construction), and the head cannot be closed or deleted until handed over (*"hand the head over first, or the header loses the signature it prints by default."*). A branch whose code is still stamped `[branch CODE]` in invoice notes can only be **deactivated** — and the page reads that reference from the invoice rows themselves (`deleteBranch()` takes the answer as an argument), so the refusal comes from what the books say, not from the modal that asks.
- **The stamp rides the notes; the print page reads it back.** The schema was not touched (Rule 21): the issuing branch lives as `[branch CODE]` in the invoice's `notes` — replace-never-stack — and `/invoices/[id]` swaps the printed seller header from the stamp. When the register can no longer answer (a branch deleted after its papers), the page prints a **named fallback** banner rather than silently substituting the primary registration. The primary registration in Settings still signs the statutory pages; a branch here is what your paper prints.
- **No rupee lives on `/business`, and an opening stands only from its own day.** The register dresses numbers and names places; the opening balances the balance sheet starts on live on `/accounting` — and since this round they grew `bank · receivables · payables · as_of`. `computeBalanceSheet()` gates the three new money lines behind `openingStood` (a balance sheet drawn before the books opened shows the documents it has, not an opening it was not yet standing on), prints the opening receivable/payable as named sub-lines, and states the honest limit: a payment grows `cash` but cannot reduce an opening receivable, because the engine will not guess which pre-books paper it settled — a settlement that wants to move both sides is an invoice with a number, not an opening figure.

---

## Rule 40 — Judgement May Be Written By Hand Only Where It Balances, Is Answered Rather Than Erased, and Asks the Seal

R3-2b gave the shop a manual journal at `/journal` — the first register in the app that holds rupees *and* is allowed to state a movement no document raised. The rule the round establishes: **a hand-written figure is trustworthy only in the shapes that make it checkable — it must balance before it can be read, a posted row is answered by a mirror rather than edited or deleted, the seal is a door the write path asks (not a control the page disables), and the fold reports how many lines it left changed, because a count of legs is not a claim about money.**

Six conventions come with it:

- **Balance is the entry's definition, not a nicety.** `validateLegs` sums both sides through `paise()` — every total in the register is an integer count of paise, so a float tail cannot decide whether an entry balances — and `postEntry` refuses a rupee of difference. A draft may be unbalanced (the debit tonight, the credit found tomorrow) but only a whole entry reaches a statement, so `computeProfitLoss`/`computeBalanceSheet` can never read a half-entry. Two legs are asked for even of a draft, and shortness is reported *beside* the other holes rather than instead of them.
- **The claim is arithmetic, and it is printed as arithmetic.** Because every posting was balanced on the way in, Δplug = Σ debits − Σ credits = **0**: a journal renames money out of "Capital account (derived)" and cannot move that line by a rupee. `plugProof()` reads that back off the rows the statements actually hold — not off the register the page is editing — and `/accounting` prints the two totals in its own sentence (*"The N journal entries this sheet read balanced to the paisa — ₹X on each side — so the derived capital line did not move by a rupee."*) instead of asserting the property; the invariant is walked over **every pair of the fifteen lines** in the fold suite rather than sampled. Seen in the dev session: a ₹40,000 depreciation-against-accumulated-depreciation posting, its mirror, and a ₹2,500 bank-charge-against-a-loan posting moved the expense category and the loans line while the derived capital figure held to the rupee. The one exception is stated rather than hidden: a head named as **capital** does move the plug, because `journalCapital` is subtracted by name — the journal gives room back to the derived figure instead of borrowing from it.
- **A posted entry is answered, never erased.** `writeEntry` refuses to change a posted row and `deleteEntry` refuses to remove one (*"a delete would leave a number with no entry"*); `reverseEntry` re-summonses every leg from the original with its side flipped — head, rupee and reference unchanged, the narration naming the entry it answers — and requires a reason, because an unexplained reversal is the silent unlock Rule 38 refuses on a seal. Both halves stay on the register and the fold nets them to nothing: the correction is on the record, the money is not.
- **A seal is asked, not enforced by a held button.** `stopForSeal` calls `sealGuard` for the entry's own date **before any leg is read**, on the draft write, the posting and the reversal, and `recordRefusal` appends the attempt as a `refused` event. So the composer keeps Save and Post *enabled* on a sealed date and lets the engine refuse: a disabled button would stop the click reaching the door and leave a prevented write off the trail — which is exactly the evidence a seal exists to produce. `/audit` prints which doors ask the seal (`GUARDED`, live ones named in the copy), so the lock never claims a coverage the wiring has not earned.
- **A fold counts lines moved, not legs written** (Rule 27). `JournalFold.touched` is the number of statement lines the fold leaves *changed*; a reversed pair — or two heads netting on one line — folds four legs and touches nothing, and the footnote says *"answer each other … no figure here moved"* rather than counting what it folded. Slots that net to zero are absent from the fold, never zero-printed, and the assets-side sentence is gated on the asset side actually carrying a journal figure.
- **Judgement stays beside the paper it dresses** (Rules 33 and 39). `journalRows()` hands `ledger.ts` plain signed rows — the engine imports nothing (Rule 23), so the row shape is re-declared, not shared — and each figure prints as its own sub-line tagged *from the journal*, never merged into the document total it sits on. An unknown slot moves nothing rather than being guessed, an undated row is read by neither statement, `/ai/ask` answers journal expense heads as *"judgement rather than a bill, so they are not counted in the figures above"*, and the entry's number is dressed from `/business`'s sixth series while the count stays this register's own `seq`, taken only when the entry becomes paper.

---

## Code Quality Checklist

Before marking any feature complete, verify:

- [ ] All required fields validated
- [ ] Loading states on buttons; the button is disabled while in flight
- [ ] Error messages displayed to the user, not just logged
- [ ] `organization_id` filter on every query
- [ ] Explicit `.select()` column list (no `*` on a hot path)
- [ ] No new database table, column or migration (Rule 21)
- [ ] New settings live in `taxflow:<feature>:<orgId>` with `version` + `updatedAt`
- [ ] Calculation lives in a pure `src/lib` function and has assertions
- [ ] Built from `ui.tsx` / `.tf-*` / tokens — no new hex literals
- [ ] Nav entry in `src/lib/nav.ts` with a real icon key
- [ ] `?q=` handled if the page is a palette target
- [ ] `npx tsc --noEmit`, `npm run build`, `npx eslint <touched files>` clean
- [ ] Browser-verified at a phone width and at 1440px; zero horizontal overflow
- [ ] Console clean on load and through the golden path
- [ ] Test data cleaned up through the app; no verification blobs or helper iframes left behind
- [ ] Committed by file name and pushed

---

## GST Compliance Checklist

Before any GST feature goes live:

- [ ] Tax rates from the database, not hard-coded
- [ ] CGST+SGST for same state, IGST for different state / export
- [ ] GST compliance warning displayed
- [ ] GSTIN format validated
- [ ] Historical invoices unaffected by later rate changes
- [ ] Credit notes signed into the period they are dated in (no `Math.abs()`)
- [ ] Turnover figures exclude GST unless the report is explicitly gross
- [ ] Portal-only data shown as owner-declared input or as a labelled gap
- [ ] Numbers reconcile against a hand-check on real data
- [ ] Nothing in the app files, submits or alters anything on the GST portal

---

## Verification Environment Notes

- Dev server: `http://localhost:3000`; log in with the local test account (credentials are never recorded in this repo).
- The browser tool's panel is ~371–455 CSS px, so it renders the mobile breakpoint natively — desktop layouts must be inspected through a same-origin iframe sized 1440×900.
- `take_screenshot` returns no image here; assert on DOM and computed styles instead.
- React-controlled `<select>` / `<input>` values are set through the native value setter, then dispatch `change` / `input`.
- An off-task call (e.g. fetching a path outside the workspace) is blocked by the classifier — keep every browser action inside the feature being verified.
