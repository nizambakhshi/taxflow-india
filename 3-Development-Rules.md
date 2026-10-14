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

**Suites are per-round throwaways in `/tmp` and are never committed** (`/tmp/payroll-test.mjs` is 435 assertions over the salary register, its R2-32 attendance half `/tmp/attendance-test.mjs` is 212, the R2-33 document half `/tmp/payslip-test.mjs` is 394, its R2-34 kept-page half `/tmp/daybook-test.mjs` is 247, and the R2-30 shopping suite is 95). `/tmp` gets wiped mid-project — it has happened three times: the second took seventeen suites with it, and the third (2026-10-14) took the five that stood at R3-7 (filings 547, journal 393, fold 250, audit 172, setup 131 = 1,493, unrecoverable and re-run never since). **What exists today is two suites on the rebuilt registrar harness**: `/tmp/tally3-test.mjs` (99, written at R3-8) and `/tmp/vault3-test.mjs` (120, written at R3-9) = **219 assertions, both re-run green at the R3-9 docs pass** — so a round records **its own** assertion count and says plainly that the older ones were not re-run, rather than quoting a running total it cannot prove. A suite is cheap to rewrite from the library's own exports, and the claim worth keeping in the docs is *which rule each assertion polices*, not the number.

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

`src/lib/vault.ts` holds `REGISTERS` — one `RegisterSpec` per device-side key, thirty-five of them — and `takeBackup()` walks **that list and nothing else**. A sweep of localStorage would catch the Supabase auth keys (`sb-*`) alongside the books; walking named entries is what keeps session material out of a file the user emails to their CA. Every spec names its group, its owning page, its encoding, its row counter and — for the 29 restorable ones — the `write` function that saves it.

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
- **The seal is a door the write path asks, not a wall around the store.** `sealGuard(orgId, date)` is the one question — it reads the register and returns the register's own sentence, so the page never invents one. When the answer is yes the write stops *and* the attempt lands as a `refused` event, even though nothing changed. Which paths consult the seal is printed on the page, because a lock that quietly covers only some doors is worse than one that names them. **R3-5 widened that door and split the question into its three honest forms — see Rule 42.**
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

## Rule 41 — A Filing Register Transcribes What the Portal Says and Posts Nothing; It Reads the Seal, Never Guards a Door

R3-4 gave the shop a filings & amendment history at `/gst/filings`. The rule the round establishes: **a register may state a return's figures without owning them — it is a transcript of what was filed, kept for history, and it must never pretend to be the posting, the submission, or the portal. Where the journal writes a rupee forward and answers to `sealGuard`, a filing row copies a rupee that already exists on the return and only *reads* the seal, because a transcript moves nothing on the statements and there is no write to stop.**

Six conventions come with it:

- **Snapshot the calendar's date, then re-derive it and print the disagreement.** A due date is copied onto the row from `compliance.ts` and kept — a filed history must not silently re-date itself when the calendar's rule text is later corrected — and `statutoryDue()` independently re-derives the day from the rule for the forms where a rule states it. `expectedRows()`/`calendarObjections()` print every place the two disagree as **drift, not a fix** (Rule 29): the register never overwrites the date it was shown, it shows both. A quarter key names the **financial year** it belongs to, not the calendar year its last month falls in — Q4 of FY 2026-27 is Jan–Mar **2027** and reads `2026-27`, never `2027-28` — a wrap this round had to fix.
- **A late fee is a slab, not a headline.** Section 47's ₹5,000 is the middle of three ceilings that turn on the preceding year's turnover, a nil return caps lower (₹500), and GSTR-9 carries its own table capped by a percentage of the turnover in that State. The estimate reads the shop's own slab and **names the notification that decided it** (19/20/21/2021 dated 01.06.2021, 07/2023 dated 31.03.2023); a composition ceiling is labelled *this register's reading* rather than quoted as statute. The `/gst/calendar` card now points here for exactly this reason: it prints the headline, this register works out the slab.
- **An amendment lives inside a window, and a window that has shut is printed as shut.** The five kinds (`gstr1a · table9a · invoice_omitted · note_omitted · itc_late`) each carry their own clock — the proviso to rule 59(1), Table 9A's annual filing, section 16(4)'s 30-November/annual-filing-prior limit (Circular 237/31/2024-GST dated 15.10.2024) — and a correction with no window left becomes `lapsed`, not a task. The chain that bars it is **quoted, not invented**: rule 59(6)(a)/(b) and 59(6)(d) with 88C(1) are the only bars named, and an empty register legitimately prints the 59(6)(a) bar instead of fabricating a due date.
- **The variance names a head only past ₹1, and reports it as books-minus-stated.** `varianceFor()` keeps the sign honest — a positive diff means the books hold *more* than the return said — and stays silent inside a rupee so a rounding artefact is never printed as a discrepancy. The `tax` figures a return stated are **stored, not re-derived** from this register's own taxable amounts; the point is what the portal was told, not what the engine would have computed.
- **The seal is read and offered, never asked as a door.** Unlike the journal (Rule 40), a filing record is a transcript that moves no rupee on the statements, so `recordFiling()` and `addAmendment()` do **not** call the seal as a door — there is nothing to stop. Instead `sealForPeriod()` (R3-5 folded this register's second spelling, `sealOf()`, into it, so a period has exactly one path to a seal, standing on `audit.ts`'s `sealForDate()`) shows a period already under a standing seal as **closed paper** (a lock badge on the row), and `sealFilingsPeriod()` **hands** a close request to `/audit`'s own `sealPeriod()`, which keeps its rules (an ended period, no overlap) so this register never re-implements the lock or keeps a second copy of it (Rule 37 — another register's control is drawn, never duplicated). A quarter is not a seal kind, so asking for one refuses with the months it would take and points at `/audit`. `/audit` prints this as a *read*, not a guarded door, so the seal's coverage claim cannot outrun the wiring (Rules 38 and 42).
- **Transcribe, do not file, post, or invent.** Nothing here is a GSP submission and no ARN is checked; a row is *what the shop says was filed*. `ledger.ts` reads none of it — correcting a filed return does not move the balance sheet; that is a journal entry's job, and the two stay deliberately apart (Rule 33). Five outward figures a shop might expect (the portal feed, the IFF, the PMT-06 deposit a QRMP filer owes, refunds/notices/demands, the statement figures themselves) are printed as `NOT_TRACKED` with their rule rather than guessed. A `filed_on` in the future is refused by `validateFiling`, `deleteFiling()` refuses while an open amendment still points at the period, and a removal is journalled to the trail as *removed from the filings register* — history does not vanish quietly. `taxflow:filings:<orgId>` joined the vault the same round (Rule 31), lives in this browser (ADR-013), and files nothing.

---

## Rule 42 — A Seal Is a Door on the Writer, Not on the Page; the Page That Hosts the Button Inherits It

R3-5 widened the period seal from two doors to nineteen. The rule the round establishes: **a control that lives on a form only governs the forms that were thought of that day — the durable place to hang it is the code every write path already passes through, so the door sits inside the shared writers and the page that hosts the button inherits it. A register's coverage claim must then be a list the suite checks, counted off the same array the page prints, with its deliberately open rows left visible rather than deleted.**

Six conventions come with it:

- **The door belongs on the writer, and a page that hosts a button inherits it.** R3-1 shipped the seal with one door and R3-2b gave it a second; R3-5 closed the rest. `createInvoice` (`create-invoice.ts`), `createPurchaseBill` (`create-bill.ts`) and `createNote` (`creditnote.ts`) each call `requireOpenSeal()` as their **first statement**, so every path that raises that paper — the invoice form, the POS counter, a recurring catch-up, an outbox replay, a sales or purchase order, a challan conversion, a Tally voucher, a scanned bill, a credit or debit note — is refused in the one place all of them pass through. **Twelve dated money paths are now covered by three doors instead of twelve pages each carrying its own** — before R3-5 the seal was asked on two of them and the other ten saved without the question being put. A door on the form is a door on whoever happens to build the next form; a page added later would simply not have it.
- **Ask before the number is spent.** In each writer the seal comes first and the sequence second (`// The seal first, the sequence second: a refused save must not burn a number.`), because a refusal that lands after `last_number + 1` has been written leaves a hole in a statutory series — a gap an officer reads as a deleted invoice. A date that is not a real calendar day cannot fall inside a window, so it passes the seal and is refused by the writer's own validation instead; the seal answers only the question it owns (Rule 27).
- **One question, three honest forms.** `sealGuard()` **reads** — it is what a banner calls, and a banner must never write the trail, because painting a warning is not an attempt to write. `askSeal()` **reads and logs** — it appends the attempt as a `refused` event, then returns the guard or `null` so a caller's happy path stays one line; a page that *reports* a stop uses this form (the journal's `stopForSeal`, the six page-carried doors, the stamp/cancel actions). `requireOpenSeal()` **throws** `SealedWriteError` on top of `askSeal`, carrying the register's own sentence as its `message` and keeping a stable `name` plus a `.sealed` flag, because a shared writer has no screen of its own — it refuses upward and whichever caller is nearest the user prints it. A disabled button is not one of the forms: Rule 40's reason still holds — it stops the click reaching the door and leaves the prevented write off the trail.
- **Where a page types straight into its table, that page carries its own door.** Six paths never touch a shared writer (`/expenses`, `/payments`, quotation → invoice, invoice paid-stamp and cancel, bill paid-stamp and cancel, and a scanned receipt kept as an expense) so each calls `askSeal()` itself before its `.insert()`/`.update()`; the journal's door sits in `journal.ts`, so `/audit` labels it **its own engine** rather than claiming the page wrote it. The label describes **which hand writes**, not which page looks tidy — and the same scan page legitimately carries two doors under two labels, since accepting a bill goes through `createPurchaseBill` while keeping it as an expense is typed directly.
- **The coverage claim is a list the suite checks.** `GUARDED` on `/audit` is 21 rows — 19 asking (`the writer` ×12, `its own engine` ×1, `this page` ×6) and 2 printed **`not wired` on purpose**: master records carry no date and GSTR-1 filing status is not dated money, so a period seal has nothing to close. Both stay on the list rather than vanishing from it, because a claim of coverage is only honest with its holes visible. The counts are computed from the array (`doorsAsking`, `doorsWriter`, `doorsEngine`, `doorsPage`) and interpolated into the printed sentence, so new copy cannot outrun the wiring; the audit suite re-reads that array from source and asserts every labelled row's page actually mentions the seal, that every `href` resolves to a real route, and that at least one row stays open. Adding a door changes the sentence by itself; adding a dead link fails the suite (this round's catch: `/bills/new` — a route that does not exist).
- **One banner, and the boundary printed where it is read.** `src/components/SealNotice.tsx` is the whole seal warning — eight pages hang it under whichever date field a write path is about to save (invoice new and detail, bills, credit and debit notes, expenses, payments, the scan page), it calls `sealGuard()` only, and it renders nothing until both the org and a date are known. `.tf-notice` in `globals.css` gives it one look instead of eight. R3-5 added no register, no `localStorage` key (Rule 31 untriggered) and no glyph — the registry stays at 74 and the vault at 35 specs. What is printed beside it stays the boundary: **the door is in this app's writers**, so a row changed through the Supabase table or another client is not stopped, and a seal never rewrites or erases paper already issued. Rule **42** / ADR-**039** is where the question gets asked, which is a rule, not a route.

---

## Rule 43 — A Calendar Emits the Period the Rule Names, and Every Day, Sum and Citation on It Is Read From a Primary Text or Labelled as the Shop's Own

R3-6 taught `compliance.ts` what rule 61(1)(ii) and 61(3) actually ask a quarterly filer to do, and then went back through the sentences the app had already been printing about that scheme. The rule the round establishes: **a calendar is the statute's voice on screen, so it must emit the period the rule speaks of — not a monthly row a downstream reader folds into a quarter — and anything it dates, charges or cites has to be traceable to the primary text that says it. Where the rule states a day and leaves the sum to be notified, print the day with confidence and leave the rupee to the shop; where the app cannot place a shop in a table at all, print the earlier day and say out loud that it is unchecked.**

Six conventions come with it:

- **Fix the emitter, not the reader.** For two rounds the calendar emitted a QRMP filer *twelve* monthly summary rows and `filings.ts` folded them into the four quarters rule 61(1)(ii) names, printing the fold as an objection. The fold was honest and still wrong: the screen a shop reads at 9am showed twelve dates the rule under which that shop files cannot produce. The emitter now writes four quarters, and what remains folded is only the **key** — `eventPeriod()` still lands a row saved against any month of a quarter inside the quarter that owns it, because a register keeps periods while a calendar prints dates (Rule 29's finding-then-correcting applies to a disagreement between two texts, not to a date the wrong form was ever allowed to keep).
- **One table, one function, two readers.** Rule 61(1)(ii)'s two rows of states live in `compliance.ts` as `QRMP_TWENTY_SECOND` / `QRMP_TWENTY_FOURTH` behind one exported `qrmpCategory(stateCode)`; `filings.ts` deleted its own half-read copy and re-exports the emitter's (`export { qrmpCategory, type QrmpCategory }`) so `/gst/filings` keeps its import path. Two copies of that table would drift into a register that disputes its own calendar over a state neither of them had finished reading. The lookup is keyed on the state's **name**, because the app's two-digit codes are its own and are not all the codes the portal issues; Chandigarh and Delhi both sit in the twenty-fourth row, and the two names of the reorganised union territory are both placed so either spelling lands on the twenty-second rather than going unanswered.
- **A day the rule states is derived; a day a notification sets is labelled as the app's reading.** `generateEvents()`'s own comment now separates the twentieth (61(1)(i)), the twenty-second/twenty-fourth (61(1)(ii)), the eighteenth (62(1)(i)), the twenty-fifth (61(3)) and the thirteenth that closes the IFF window (59(2)) — all stated in rule text — from GSTR-1's eleventh and a quarter's thirteenth, which come from a notification table the app carries and models no shift for. `statutoryDue()` keeps the same split in data: a date derived from a rule the register has read returns `cited: true`, and the quarterly GSTR-1's thirteenth now returns `cited: false` with a citation that refuses to name an instrument it has not read.
- **A citation the app cannot produce is deleted, not kept in plausible shape.** This round's sweep read rule 61, rule 59, Notification No. 85/2020-Central Tax and Circular No. 143/13/2020-GST from the primary texts (CBIC's own rule pages; the GST Council's own notification PDFs; the Circular's own PDF) and removed six things the app had been printing as authority: a **"six per cent"** deposit figure, two notifications dated **17.02.2025** that are in fact dated 17.09.2025 and cover other subjects, a Circular dated **23.02.2020** with a *"two days prior to the due date for filing of GSTR-1"* reading that appears nowhere in it, a **12% interest cap under "the second proviso to rule 61(3)"** — no such proviso exists, and no 12% appears in the consolidated rules — the claim that rule 61(4) bars a further top-up, and the **35% PMT-06 fixed sum cited to Circular 143 alone** when it is notified by Notification No. 85/2020-Central Tax dated 10.11.2020 (section 148 r/w section 39(7)), the Circular being the Board's explanatory reading of it. The app's IFF date moved from the eleventh to the **thirteenth**, which is what rule 59(2) says in its own words, and the ₹50 lakh ceiling is now described as covering **inter-State and intra-State** B2B both, because rule 59(5)(a) names both. What is quoted on screen is quoted from those texts, and the sentences that used to depend on the invented ones were rewritten rather than patched.
- **State the day you are sure of and the amount you do not have.** Rule 61(3) asks for *"the tax due under proviso to sub-section (7) of section 39"* **by the twenty fifth day of the month succeeding such month** — and states no sum, because section 39(7) leaves the amount to be notified. The notified sum is **notified law, not a Circular's paragraph**: Notification No. 85/2020-Central Tax, dated 10.11.2020, issued under section 148 read with the proviso to section 39(7), prescribes *"thirty five per cent. of the tax liability paid by debiting the electronic cash ledger in the return for the preceding quarter"*, and Circular No. 143/13/2020-GST of the same date is the Board's explanatory reading of that notification (para 6.1). The alternative shape the portal offers is a self-assessed figure for the month. So the calendar prints the twenty-fifth with confidence, the register prints an objection that says which half is missing and why (the cash-tax figure lives in its own filed rows and in the cash ledger, and folding them into a pre-computed challan is named as the next round's work), and no rupee is guessed on either screen.
- **An unstated fact prints as a gap, never as a pass.** A QRMP shop whose principal place of business is not named gets the **earlier** of the two days on its quarterly rows — so the date on screen is never later than the rule allows and a day early at worst — the row says so in those words, and `/gst/filings` reports those periods as *cannot be checked* rather than confirming them. The calendar now reads the shop's own primary `gst_registrations` row for the answer and offers it as a prefill; a state the owner already chose on the page wins, and the registration fills the blank rather than overwriting it. And the last thing the scheme's own wording teaches is what a deposit is not: section 47's late fee attaches to *a default in furnishing a return*, so the IFF (rule 59(2) reads *"may furnish"*) and the PMT-06 challan carry **no fee** in this app — what runs late there is interest, worked at the eighteen per annum of section 50(1) the filings register already uses everywhere, with Circular 143's para 8.1(ii) quoted as *"at the applicable rate"* and para 8.1(i)'s shield printed beside it.

R3-6 added no register, no `localStorage` key, no route and no glyph, so Rule 31 stayed untriggered and the vault stays at 35 specs / 30 restorable. What it changed in the UI was one page's own chrome: `/gst/calendar` gained the state control that sets the day, and its two `#bfdbfe` hairlines became the new `:root` token `--brand-line` — the same move R3-5 made with `--mono`, so the next page has something to point at while the five literals that remain in other pages stay open cleanup rather than a mid-feature sweep. Rule **43** / ADR-**040** is where a calendar's dates are answerable to the text that set them.

---

## Rule 44 — A Sum on a Calendar Is Either the Shop's Own or a Labelled Ceiling, and a Fold Names the Line It Read

R3-7 picked up the one thing Rule 43 left open on purpose: rule 61(3) fixes the twenty-fifth and states no amount, so the deposit row carried a day and an empty rupee. The rule the round establishes: **a figure this app computes is either derived from a primary text the code has read, or folded from rows the shop itself put in — and the screen has to say which of the two it is looking at. Where the register holds a different kind of number from the one the statute asks for, print the arithmetic as a ceiling and name the line it was read from; never rename the figure until the shop names it.**

Six conventions come with it:

- **Two sources, three states, one card.** `depositFor(store, statuses, supplyMonth)` returns `DepositFigures` with a `source` of `ready` (35% of the cash tax the shop stated for the base quarter), `ceiling` (35% of what that quarter's filed GSTR-3B *stated in total*), or `none` (neither exists yet). `/gst/calendar` prints `ready` as ₹ and the sentence that produced it, `ceiling` as **up to ₹…** in `--amber`, and `none` as the rule and the notification with no rupee at all. A ceiling is only exact when none of the quarter's tax was met from input credit, and the card says so — relabelling a stated total as a cash leg would break Rule 43 from the other side.
- **Fold the period that owns the money, not the period on the row.** A PMT-06 deposit answers for one month and its base is the quarter *before* the quarter that month sits in, so the fold is `prevPeriod(quarterOfMonth(...))` — a May 2025 deposit reads `2024-Q4`, and a January one reads `2025-Q3`, because Q4 belongs to the next calendar year (the carry R3-4 already learned). `depositFor()` returns `null` for anything that is not a month: the calendar's own `pmt06-<YYYY-MM>` event id is the only input this fold accepts.
- **A stated figure lives on the envelope the screen already owns.** The cash tax is stored under `cash:<quarter>` inside `taxflow:compliance:<orgId>` — no new key, so Rule 31 stayed untriggered and the vault's 35 specs are unchanged — and it is keyed by **quarter**, not by deposit, so one entry feeds both months. `isCashTaxKey()` then separates the envelope's two kinds of row, because a quarter's cash figure is not a return that was filed: the vault row for this key counts them apart (`2 returns marked filed · 1 quarter with a stated cash tax`) instead of letting a sum inflate a filing count.
- **Copy that deferred is copy that has to be re-read.** R3-6 left two sentences pointing at the future — `UNTRACKED_CALENDAR_FORMS['PMT-06']` ("the money itself belongs to the cash ledger") and the register's disclosure card ("folding the two together into a pre-computed challan is the next round's work"). R3-7 did the fold, so both were rewritten to describe the screen as it now behaves: the card explains the stated-versus-cash distinction and tells the shop to name the quarter's cash tax. A disclosure that describes last round's app is a discrepancy the app has not found yet.
- **Never mutate the map you were handed.** `withEnteredCashTax()` returns a new object, but the first version `delete`d `cashTax` off the *entry* it shared with the caller's map — so clearing a figure quietly rewrote the previous state, and a deposit that was `ready` read back as a `ceiling` in the very next render's memo. The fix builds a new entry (`{ doneOn, reference }`) and the suite pins it: *clearing leaves the map it was handed alone*.
- **A ceiling is not a warning.** The amber figure and the input sit in the same card, so the shop reads the app's best reading and the box that replaces it in one look; `amountHint` (the payroll rows' own rupee text) is suppressed exactly when a deposit fold exists rather than printed twice against it. Nothing here reads the portal: the challan on the GST site stays the record, and the card's wording says *state*, not *this is what you owe*.

R3-7 added no register, no `localStorage` key, no route, no glyph and no component: `compliance.ts` **407 → 435**, `filings.ts` **2,296 → 2,368**, `vault.ts` (1,433 lines, one spec's three fields), `/gst/calendar` **593 → 675**. Ledger re-counted at this pass: **65 `page.tsx` + 2 `route.ts` = 67 route files, 54 libraries, 10 component files, 74 glyphs, 35 vault specs (30 restorable, 5 evidence-only)**. Verification: `tsc` 0 errors, `eslint` at the HEAD baseline (one pre-existing `react-hooks/exhaustive-deps` warning on this page's load effect), `npm run build` ✓ 67/67, and **1,493 assertions across the five `/tmp` suites, 0 failing** (filings **511 → 547**, journal 393, fold 250, audit 172, setup 131). **NOT VERIFIED LIVE** — the browser session is still signed out, so the deposit card, the state selector and the quarter rows have not been driven through the UI; this round's drive joins R3-4's, R3-5's and R3-6's as owed. Rule **44** / ADR-**041** is where a folded number says which line it came from.

---

## Rule 45 — An Import May Raise a Draft, Never a Posting, and a Deepening Borrows the Door of the Register It Lands In

R3-8 faced ADR-029's oldest sentence — *receipts, payments, journals and delivery challans are listed as skipped* — and moved it exactly one word rather than erasing it. The rule the round establishes: **when a file names a document whose page lives elsewhere, the bridge may hand that page a draft — never a posting, never a number, never a head or a party or a product it invents — and in doing so it must travel through the destination register's own writer, its own numbering and its own key, not a parallel path of the bridge's.**

Six conventions come with it:

- **One word, one boundary.** A journal or challan voucher becomes a plan row (`journal_draft` / `challan_draft`) that, when ticked, calls `writeEntry` on the journal register or `appendDraft` on the challan series — the same two calls the registers' own pages make. A draft **burns no number**: the JR number is taken at posting, the DC number at raising, and both from the register's high-water mark. The suite pins the whole chain — draft lands with `number === ''`, the peek number survives untouched, posting mints exactly `JR-2025-26-0001`.
- **The seal is inherited, not rewired.** R3-5 put the door inside `writeEntry`, and `writeEntry` asks it **even for a draft** — a file that tries to seed an entry dated inside a sealed April 2025 is refused with `sealed: true` before anything writes, because a draft dated there is a future posting dated there. The bridge added no seal call of its own.
- **Money's one writer reaches inside vouchers.** ADR-029 skipped receipts and payments because they are money; the new kinds carry the same refusal at line level: a **cash or bank leg in a journal voucher blocks** — "Payments are the only writer of money here, and an import does not make one" — and a receipt or payment voucher still skips with its money sentence.
- **Resolve one-way, block the rest.** A journal leg lands only on a head that already stands on the register (case-folded match; a head closed since still lands with a flag) and a challan only against a **party and items the books know** — an unknown name blocks with the missing word printed, and the row becomes draftable only when the shop registers that name; `expandSelection` carries the requirement so ticking the draft pulls the missing product row, never invents it silently. A voucher whose legs **do not balance blocks rather than being squared**; a ₹0 line is dropped with a flag, never planned as a zero leg.
- **What the destination row cannot carry is said, not smoothed.** Challan lines are **untaxed**: tax sitting in a challan voucher lands in `flags` ("of tax sits… the lines win") and the row stays ready at the lines' rupees; an unknown movement reason defaults to `other` with a read-before-confirm flag; the place of supply is derived exactly as an invoice's from the party's GSTIN; a party with no state falls back to the shop's own **only when the organisation's primary GSTIN names one**, with a flag, and blocks when there is none to read; a **negative-quantity line blocks** — a reverse challan is a different register's semantics and the bridge does not arbitrate that.
- **The key stays the bridge's own.** The import log grew two counters (`journal_drafts`, `challan_drafts`) **on the existing `taxflow:tally:<orgId>` envelope** — no new key, Rule 31 untriggered, the vault unchanged at 35 specs — and the page's log chips print them beside the note counts. Dedupe runs across import generations the way the note rows' does: a draft whose `Tally Journal #J-…` / `Tally Delivery Challan #DC-…` line already sits in a stored row's notes reads **already**.

R3-8 added no register, no `localStorage` key, no route, no glyph and no component: `tally.ts` **3,211 → 3,513**, `/tally` **1,608 → 1,735**, and one line of ⌘K keywords. Ledger re-counted at this pass: **65 `page.tsx` + 2 `route.ts` = 67 route files, 54 libraries, 10 component files, 74 glyphs, 35 vault specs (30 restorable, 5 evidence-only)** — the build's route table prints **69 rows**, and the R3-9 pass re-counted that arithmetic row by row from the build log rather than trusting any round's summary of it: **65 pages (the root `src/app/page.tsx` included — it is a bare `redirect('/login')` and still prints its own `/` row), 2 api handlers, `src/app/manifest.ts` as `/manifest.webmanifest`, and the framework's `/_not-found`** = 69 over 67 route source files. Verification: `tsc` 0 errors, `eslint` 0 problems on the round's three changed files, `npm run build` ✓, and **99 assertions in `/tmp/tally3-test.mjs`, 0 failing** — the `/tmp` harness was rebuilt this round after the 2026-10-14 wipe (`/tmp/jr-register.mjs` registrar + `/tmp/jr-hooks.mjs` ESM resolve hook), so this round's figure stands alone: the **five** suites that last ran at R3-7 (filings 547, journal 393, fold 250, audit 172, setup 131) went unrecoverable with the wipe and their counts stay as recorded there. **NOT VERIFIED LIVE** — the browser session is still signed out, so dropping a file with a journal and a challan and watching the drafts land on `/journal` and `/challans` has not been driven through the UI; this round's drive joins R3-4's through R3-7's as owed. Rule **45** / ADR-**042** is where an import stops at the draft's door.

---

## Rule 46 — A Backup's Promise Is Measured on the Device, and Which Books Moved Is Answered by Checksum, Never by Timestamp and Never from the File

R3-9 took the vault's oldest honest gap: `recordBackup` stored *that* a file was taken and how big it was, so `/vault` could say "3 days ago" but could not say whether the books had moved since. The rule the round establishes: **a backup is a claim about a device at a moment, so the only place the follow-up question can be answered is that device — and the answer must come from comparing content to content, never from a timestamp, never from the file that already left.**

Six conventions come with it:

- **The fingerprint is taken at the moment of packing, from the block itself.** Each recorded backup leaves a `{rows, checksum}` per register on the event — the *same* FNV-1a the file's block was packed with, through the spec's own `checksumOf()`, so a text key and a JSON key are compared as their own content, not as whatever localStorage happens to look like. An unreadable JSON value checksums to `''` and therefore reads as `changed`, never as fresh.
- **The memory lives in the log that is never in the file.** Fingerprints ride `taxflow:vault:<orgId>`, which ADR-013 already keeps outside every vault file (a backup that recorded its own backups would grow each time it was restored). So **no new key was created and Rule 31 stayed untriggered — the vault is unchanged at 35 specs / 30 restorable** — and the claim cannot travel: a second laptop restoring the file inherits the books, not the answer. That is deliberate; a device-side memory that did travel would make one laptop's `fresh` another laptop's lie.
- **Seven states, and the two that admit ignorance are printed, not folded away.** `registerFreshness()` returns `fresh · changed · new-since · cleared · nothing · unrecorded · never`. A backup taken before fingerprints existed makes *every* row `unrecorded` ("Cannot tell", with the why naming the cure — take a new backup) rather than guessing from row counts; no backup at all makes a book with content `never` ("In no file yet"). A book the file carries and the browser no longer does is `cleared` — the file is the *surviving* copy there, so it is kept **out** of the at-risk list, which counts only `changed · new-since · never` with rows > 0: what a wipe would take with it, not what a wipe would save.
- **A hand-edited log is sanitised on the way in, not trusted.** `loadVaultLog()` drops any fingerprints entry that is not a clean object and re-types the survivors (`{rows: Number, checksum: String}`); a non-object `fingerprints` value survives raw so the fold can see it is not a map and degrade every row to `unrecorded`. A forged checksum still only ever *compares* — the suite pins that a hand-written `'abc'` reads `changed`, so editing the log cannot manufacture an "In your file" badge.
- **The screen asks the question where the answer is already loaded.** Registers-tab rows gained a *Since your file* column, a `What moved since your last backup` card with the counted chips, an at-risk list that links each book to the page that owns it, and a *Take a backup now* button that returns to the Backup tab. `registerFreshness(oid)` is called in exactly the two places the snapshot is built — the load effect and `refresh()` — so the existing `recordBackup → refresh()` path means taking a backup re-answers the question on the same click, with no second state store. The card's own copy says the file is *not* read here, because it is in a folder or a mail and this screen cannot know what it became after it left.
- **No new register, key, route, glyph or component.** `vault.ts` **1,433 → 1,597**, `/vault` **1,071 → 1,226**, two existing glyphs (`compare`, `clock`), so the registry stays at **74**; the page's kit table grew one column inside the `.tfv-inv` grid the responsive toolkit already folds below 768px. Ledger re-counted at this pass: **65 `page.tsx` + 2 `route.ts` = 67 route files, 54 libraries, 10 component files, 74 glyphs, 35 vault specs (30 restorable, 5 evidence-only)**, build route table **69 rows** (the breakdown re-counted row by row from this round's own build log, in Rule 45's paragraph above — which also settles the 68-vs-69 drift between the R3-5 and R3-6 notes: the root `page.tsx` *does* print a `/` row). Verification: **120 assertions in `/tmp/vault3-test.mjs`, 0 failing** (new suite — no-backup, first backup, unchanged, edited, cleared, new book, evidence-only, `unrecorded`, the sanitiser, restore-and-rebackup, cross-org isolation, and the page's own wiring: no hex literals, both `registerFreshness` call sites, the 7th column, the honest notes), `/tmp/tally3-test.mjs` re-run **99 / 0**, `tsc` 0 errors, `eslint` 0 problems on the round's two changed files, `npm run build` ✓ with `/vault` in the route table. Width behaviour checked by **static CSS audit only** — no dev server and `/vault` redirects to `/login` signed out. **NOT VERIFIED LIVE**: taking a backup, changing a register and reading the Registers tab has not been driven through the UI; this round's drive joins R3-4's through R3-8's as owed. Rule **46** / ADR-**043** is where a backup stops being a date and becomes a claim the device can check.

---

## Rule 47 — Where the Law Files Nothing, the App Reads the Two Returns the Money Travels On, and a Row Nothing Can Be Read Against Is Printed as Ignorance, Not a Breach

R3-10 took competitor row #16's second half. `src/lib/exports.ts` already knew *that* a consignment left and *by when* the proceeds had to land, and said nothing at all about the refund of the IGST it knew had been paid. The rule the round establishes: **when the statute treats a document the shop has already filed as the application itself, the app raises no form of its own — it reads the conditions that decide whether that document carried anything, names the one that fails, and prints a row it has nothing to read against as its own ignorance.**

Seven conventions come with it:

- **No RFD-1 on the goods route, in the engine or in the copy.** `refundTrack(views, filings)` groups goods files by the trimmed shipping bill number and answers, per bill, which return the bill has to ride on is missing or short. The nine `REFUND_TRACK_CITATIONS` open in the portal's own words — *"Shipping Bill itself shall be treated as refund application"*, *"The taxpayer is not required to file separate refund application in this case"* — and the claim modal changed to match: a goods file now asks for a **Refund reference (ARN / ICEGATE)** and a **Refund order / ICEGATE sanction ref**, not an `RFD-1 ARN`, because asking for the wrong form is the app teaching the wrong law. A service file still asks for the RFD-1 and its ARN, because there the claim really is a form.
- **Soundness runs one way, and the tab prints the direction of its own weakness.** The filings register stores a return's **total** stated IGST, while the portal's test is table 3.1(b) against tables 6A + 6B — *parts* of that total. So a bill whose IGST exceeds the whole return is **provably** short; a bill that fits inside it proves nothing. `clear` is therefore labelled **"Nothing here blocks it"** (tone blue) and its `says` ends *What happens next is Customs' and ICEGATE's, and this app cannot read it*. No state in `TRACK_META` promises money.
- **`unread` is a state and it is counted apart.** `has_filings` is `filings.filings.length > 0`; with nothing ever recorded on this device every readable bill lands `unread` — *"This is ignorance, not a breach: the returns may well be filed"* — and `TrackResult.unread` counts it **outside** `at_risk` / `waiting` / `clear`. The first draft let an empty register fall through to `no_gstr1`, which is a claim about the portal that this device cannot make; a per-period `no_record` still reads *blocking*, but only once the shop has recorded something, so "not filed here" keeps its meaning.
- **The period is found by containment, not by string.** `coveringRecord()` matches the export date against `periodRange(record.period)` rather than formatting a key, because a QRMP shop's GSTR-1 is a *quarter* period while its GSTR-3B may be a month, and a key built here would be a guess about the shop's filing cadence; when a month and a quarter both cover the date, the month wins as the narrower reading. A bill whose invoices straddle two periods is **one claim with two periods to satisfy** — both are read, and the bill's IGST is split per period, so a January row is never proved by a February return.
- **One bill is one claim, and two unnamed consignments are not one bill.** The key is `shipping_bill_number.trim() || 'no-bill:' + file_id`; `claim` is the single member status or `mixed`, and `mixed` raises a warning naming **both** transcriptions instead of picking one. The rupee is summed only over members whose invoice is in the books, with `igst_unknown` carried beside it so a figure that is a floor prints as a floor and the ladder stops at `igst_unknown` rather than passing a verdict on money it never read.
- **The screen answers "why not mine" before anyone asks.** Six `ScreenKind`s (service, SEZ, LUT-with-no-tax, LUT-but-tax-paid, route-not-recorded, IGST-route-with-no-IGST) each carry a `why` naming what runs instead — section 54(1) for a service, the exporter's own application with the zone documents for a SEZ. Screening tests `!v.unmatched && v.igst_paid <= 0`, so a goods file whose invoice is *missing* from the books is not screened out for having no IGST: it stays on the track as unread, because the honest reading is *we cannot see this one*, not *this one owes nothing*.
- **The gap list stopped asking for paper that does not exist, and every citation answers Rule 43.** `paperGaps()` for a goods file on the IGST-paid route with no claim now names **the returns the bill has to ride on** (this period's GSTR-1 table 6A and GSTR-3B table 3.1(b)) and says there is no RFD-1 to raise on that route; service files keep the RFD-1 / 54(1) gap. Eight citations are `read: 'primary'` with URL and source; rule 96's entry states inside its own `source` that the CBIC page could not be fetched and that **the numbered sub-rules are NOT quoted here**, and the ninth opens `Reading:` because it is this register's inference. `REFUND_TRACK_BOUNDARIES` prints the five sentences about what the tab does not do.

**No new register, key, field, route, glyph or component.** `EXP_VERSION` stays **1** and `newFile()` grew no field — the track reads what the export register and `/gst/filings` already store, and derives everything on every open (ADR-013, Rule 21, Rule 31 untriggered, the vault unchanged at 35 specs / 30 restorable). `exports.ts` **1,856 → 2,542**, `/gst/exports` **1,574 → 1,837**: five tabs now (register / undertakings / watch list / **the IGST refund track** / the rule) and two CSVs added (refund track, supplies outside the mechanism). The page's 20 distinct glyph values all resolve — the registry stays at **74** — and it audits at **0 hex** with 177 `var()` uses over 23 tokens, every one of them declared in `:root`.

Ledger re-counted at this pass: **65 `page.tsx` + 2 `route.ts` = 67 route files, 54 libraries, 10 component files, 74 glyphs (75 regex lines − the component's own `name: string` prop), 35 vault specs (30 restorable, 5 evidence-only)**, build route table **69 rows** including `○ /gst/exports`. Verification: `tsc` 0 errors; `eslint` **0 problems** on both changed files against a HEAD `git worktree` baseline at `fa1f089` that also reports 0; `npm run build` ✓ exit 0; **344 assertions in `/tmp/refundtrack-test.mjs`, 0 failing** — the six screens and the ghost file that stays on the track, one-bill-one-claim and the trimmed key and `no_bill` never grouping, grant / rejection / mixed, `unread` against `no_record` / `no_period` / `igst_unknown`, both conditions at once, the ₹0.5 tolerance (₹18,000 against a ₹18,000 bill reads `clear`, ₹17,999.8 reads `clear`, ₹17,400 reads short), nil and recorded-not-filed rows, a null `igst_stated`, multi-period bills split per period, QRMP quarters resolved by containment with the month preferred, Rule 96B's unrealised-proceeds and late-realisation warnings, the ladder order and all five counts, both CSV shapes and `formColumn`'s four readings, the corrected `paperGaps` wording, every citation's URL and primary-vs-own reading, the eleven-state legend, and the page's own wiring (tab present, `loadFilings` read-only, the goods claim-modal wording, `track.unread`, the mobile rules, no `taxflow:track` key, no hex, no `localStorage.setItem`). `/tmp/vault3-test.mjs` re-ran **120 / 0** and `/tmp/tally3-test.mjs` **99 / 0** — **563 assertions across the three suites that survived the 2026-10-14 `/tmp` wipe, 0 failing**. The dev server ran for this round and `/gst/exports` renders the app's own redirect to `/login` — the Supabase session is signed out — so **the new tab has not been driven through the UI**; the console stays clean at `/login`, and width behaviour is checked by **static CSS audit** (`.ex-head-track` / `.ex-row-track` fold to one column below 768px, `.ex-track-state` swaps its left tone rule for the dashed top rule, `.ex-track-counts` re-gaps). This round's drive joins R3-4's through R3-9's as owed. Rule **47** / ADR-**044** is where the register stops asking for a form the law never asked for.

---

## Rule 48 — A Register Nobody Can Reach Is a Register Nobody Uses; ⌘K Finds Its Rows, and the Reachability Carries the Engine's Own Reading, Never an Invented One

R3-11 closed the boundary named every round since R3-4: two Round-3 registers existed but lived only behind a sidebar click. `/gst/filings` (R3-4) and the export refund track (R3-10) had no ⌘K presence, so a March GSTR-3B, an open April amendment, or shipping bill `SB-99120` could not be found by typing its number. The rule the round establishes: **a device register becomes reachable by joining the palette's existing synchronous live search — the same path the order-flow documents ride — and every row it contributes prints only what the engine already decided. No due date is recomputed, no rupee is re-read from the books for the row's own sake, and an empty register yields no rows rather than a claim of absence.**

Five conventions come with it:

- **The third synchronous source, not a fourth search.** `registerRecordCommands(orgId, query)` sits beside `orderRecordCommands` in the palette's `localRecords` pool, gates on the same `normalizeQuery(query).length >= MIN_QUERY`, and returns plain `kind: 'record'` commands so the one shared `rankCommands` / `groupBySection` filters, ranks, de-dupes and titles them exactly as every other record. `REGISTER_ENTITIES` (`filing` / `amendment` / `export_file`) extends `RECORD_ORDER`, so the new groups appear in the palette's own display order with their `ENTITY_META` titles ("Filing periods", "Open amendments", "Export files") and their "More in …" footer.
- **The label is a join of two maps the register already owns.** A filing row reads `${FORM_META[f.form].label} · ${periodLabel(f.period)}` and a sublabel of `STATUS_META[f.status].label` + the filed date + the reference **as written**; an amendment reads `AMENDMENT_META[kind].label` + period + `AMENDMENT_STATUS_META[status].label` + `doc_ref` + `party`; an export reads `SB <bill>` for a goods file that carries a shipping bill, else its invoice number, with `ROUTE_META[route].short` beside the destination. Every fallback is `?? <raw field>` — a meta map that cannot name a value prints the value, never the word "unknown" the engine did not choose. `commands.ts` imports both registers read-only: nothing here writes a filing, an amendment, or a consignment.
- **A hit lands on a view that is already honoured.** Filing rows deep-link `/gst/filings?q=<periodLabel>`; amendments add the `?tab=amendments` the page reads at load; a billed goods consignment lands on `/gst/exports?tab=track&q=<bill>` and a service or bill-less file lands on `/gst/exports?q=<invoice>`. The filings page already read `?tab=` and `?q=`; the exports page read `?q=` but **not** `?tab=` — so this round added exactly one line there, reading `?tab=` through the same five-value guard the tab strip already uses. The shared `useSearchDeepLink` filter then keeps the row in view; the palette never re-implements the page's matching.
- **The number that needs the books stays on the page that reads the books.** The track's IGST rupee is joined from the invoice ledger and `/fx`, which the palette does not hold. So no export or filing row prints a ₹ or a recomputed due date — the row is a door to the reading, and the reading stays where its inputs live. The test asserts the sublabels carry no `₹` and no due-date string, proving the reachability invented nothing.
- **An empty register says nothing.** `registerRecordCommands` reads the store, maps over `.filings` / `.amendments` / `.files`, and returns whatever is there; a store with no rows contributes no commands and never a "no filings" line. A wrong-version or damaged store parses to empty upstream (Rule 21, the `EXP_VERSION`/`FILINGS_VERSION` guard), so the palette cannot offer a row the register itself would refuse to show.

**No new register, key, field, route, glyph, or vault spec — this is a wiring round.** `FILINGS_VERSION` and `EXP_VERSION` both stay **1**, no `localStorage.setItem` is added, and the two registries are opened with their existing `loadFilings` / `loadExp` readers. `commands.ts` **935 → 1,049** (`RegisterEntity`, `REGISTER_ENTITIES`, the three `ENTITY_META` rows, `registerRecordCommands`, the refund-track action), `CommandPalette.tsx` **322 → 323**, `/gst/exports` **1,837 → 1,841**; `/gst/filings` is unchanged because its deep-links already worked. The palette's glyphs are the already-registered `filing` and `ship` — the registry stays at **74** — and the route count is unmoved.

Ledger re-counted at this pass: **65 `page.tsx` + 2 `route.ts` = 67 route files, 54 libraries, 10 component files, 74 glyphs, 35 vault specs (30 restorable, 5 evidence-only)**, build route table **69 rows** — no new route, as a discovery round must not add one. Verification: `tsc` 0 errors; `eslint` on the four touched files reports the **same 3 `react-hooks/set-state-in-effect` problems as the HEAD `git worktree` baseline** (all pre-existing effect-body `setState` calls in the palette's debounce / clamp effects and the exports load effect — my `setTab` rides the effect that already fires there, so it adds no new report); `npm run build` ✓ exit 0. **New suite `/tmp/kb-record-test.mjs` — 60 assertions, 0 failing**: the three gates (empty query / no orgId / no `window` each yield zero rows), a filing found by form, an amendment by kind, an export by shipping bill, the labels and sublabels asserted as exact joins of `FORM_META`/`STATUS_META`/`AMENDMENT_META`/`AMENDMENT_STATUS_META`/`ROUTE_META.short`/`periodLabel`/`formatDateIN`, the three href shapes (`?q=`, `?tab=amendments&q=`, `?tab=track&q=`) and their register-vs-track split, **no `₹` and no recomputed due date in any row**, every href base resolving through `isKnownHref`, the `RECORD_ORDER` and group-title wiring, an empty register yielding zero rows and inventing no message, the new `action:export-refund-track` pointing at `?tab=track`, and the shipping-bill query ranking the export row first. `/tmp/tally3-test.mjs` **99 / 0**, `/tmp/vault3-test.mjs` **120 / 0**, `/tmp/refundtrack-test.mjs` **344 / 0** — **623 assertions across the four suites, 0 failing**. The dev server build is clean, but the Supabase session is signed out, so **the new palette rows have not been driven through the UI**; this round's drive joins R3-4's through R3-10's as owed. Rule **48** / ADR-**045** is where the two hidden registers finally answer to ⌘K.

---

## Rule 49 — Deepening a Shipped Register Must Charge the Correct Statutory Base, Reuse the Register's Own Dates, and Turn "I Don't Know" into an Upper Bound with a Reason — Never a Zero

Round 3's registers were each built once; R3-12 is the first *deepening* of one, and the round sets the rule a deepening must follow. `/gst/filings` (R3-4) already costed a **late-filed return** under rule 88B(1) — interest on the portion paid by debiting the electronic **cash ledger**. The one figure it never printed was the cost of an **amendment**: the document the return missed, which rule 88B(2) — "in all other cases" — charges on **the gross tax that remains unpaid**, from the day the tax was due till the day it is paid. The rule this round establishes: **a read-only fold over a shipped register re-derives nothing it can read, charges the base the statute actually names for the case at hand, and where a date it would need does not exist on the register, prints the figure as an upper bound beside the reason — it never borrows a base the register cannot see, never invents a date to stop a clock, and never renders ignorance as zero.**

Seven conventions come with it:

- **The base follows the case, and the register must know which case it is in.** An `add` amendment runs on `tax` gross — an invoice left out of a July GSTR-1 and surfacing in September draws interest on the whole ₹18,000, exactly the CBIC Handbook's worked example — because `amendmentCost()` cannot see the electronic cash/credit ledgers and rule 88B(2) does not ask it to. The register's ordinary late-fee path stays on its cash-portion reading; the two are never merged, and the page prints the 88B(1)-vs-88B(2) boundary in its own words so a reader cannot mistake the ceiling for a demand.
- **The start date is read in the order the register can stand behind, and "nothing" is a state.** `dueToBePaid()` prefers the corrected period's own filed GSTR-3B row's `due`, then that row's `filed_on` (the earliest date the day the tax was owed had arrived is proven), then `statutoryDue('gstr3b', …)` re-derived for the shop's cadence and state, then **nothing** — which is the `cannot_tell` state, not a silent zero. Interest starts the day *after* the due date (section 50(2)), and the elapsed count is the register's existing `daysBetween`, so a page and the engine cannot disagree about what a day means.
- **Six states, and only two of them are money.** `running` and `carried_undated` add up; `reduce_takes_tax_out` (a reduction pays nothing out), `no_tax_to_run_on`, `not_due_yet` and `cannot_tell` each print a labelled reason and are counted *out of* the sum by `amendmentCostTotals()`, which names every excluded state. A `reduce` row is never shown costing rupees; an unparseable period never shows ₹0 as though it were checked.
- **A carried row stops on a date the register does not hold, so it reads as a ceiling.** `carried_undated` computes the same arithmetic **to today** and states why the real figure is lower by however long ago the tax actually went in — the same honesty `estimateLateFee()` already used for an unstated payment date. No `paid_on` field was added and `FILINGS_VERSION` stayed **1**: the register cannot stop the clock, so it says so rather than storing a date nobody typed.
- **The rate and the manner are the register's existing convention, and they are labelled as such.** Interest is simple, `tax × 18% × days/365`, the 18% read from Notification No. 13/2017-C.T. dated 28-6-2017 — the identical convention the late-fee estimate on the same page uses, so the two figures are computed alike. This is carried into the citations as one of the two `read: 'own'` entries prefixed `Reading:`, because dividing by 365 without compounding is this register's inference, not a quoted rule.
- **Every citation is verbatim from a primary text or says it is the app's own.** `COST_CITATIONS` carries **8** entries — **6 `read: 'primary'`** quoted word-for-word from the CBIC *Handbook on Interest, Late Fee and Penalties under GST* (rule 88B(2)'s gross language and its "any amount is missed out and found out later, interest is on gross amount" commentary from p. 5; rule 88B(1) and the Notification 14/2022-CT insertion from p. 4; the 18% rate from p. 1; section 50(2)'s day-succeeding start from p. 2) — and **2 `read: 'own'`** labelled `Reading:` for the 365-day convention and the upper-bound rule. Each primary entry carries a live `https` source URL (all pointed at the one CloudFront PDF verified HTTP 200 this round, after a guessed `cbic-gst.gov.in/gst-concepts/handbook` link proved 404 — the same class of defect R3-6's citation sweep struck); an `own` entry cites no external page and names itself "not a quoted text". The soundness is one-way, per Rule 47: a quoted mark guarantees a source, never the reverse.
- **A printed page receives the figures and re-derives none (Rule 33), and a deepening adds paper only where it is honest.** The amendments tab's "What waiting costs" card renders `amendmentCosts()` / `amendmentCostTotals()` output verbatim, exports the fold as a **fourth CSV** (`AMENDMENT_COST_CSV_HEADERS`, **16** columns — the register's CSVs are now grid **27** / board **17** / variance **10** / cost **16**), and lists the citations in a `<details>`. It re-computes no day and no rupee.

`src/lib/filings.ts` **2,368 → 2,664** (+296; the +11 exports are `CostState`, `COST_STATE_META`, `AmendmentCost`, `amendmentCost()`, `amendmentCosts()`, `CostTotals`, `amendmentCostTotals()`, `AMENDMENT_COST_CSV_HEADERS`, `amendmentCostCsvRows()`, `CostCitation`, `COST_CITATIONS`); `/gst/filings/page.tsx` **2,079 → 2,193**. `NOT_TRACKED` gained one honest gap ("The date a correction tax actually left") and `BOUNDARY` the gross-vs-cash sentence. **No new register, key, field, route, glyph, component or vault spec — `FILINGS_VERSION` stays 1 and the ledger is unmoved at 67 routes / 54 libraries / 10 components / 74 glyphs / 35 vault specs (30 restorable), build route table 69 rows.** Verification: `tsc` 0 errors; `eslint` reports **0 findings on both touched files** (the three pre-existing `set-state-in-effect` notes live in the palette and exports pages, not here); `npm run build` ✓ exit 0, 69 rows. **New suite `/tmp/filings12-test.mjs` — 110 assertions, 0 failing**: the gross base against the handbook's ₹18,000 example, the four-deep due-date resolution order (filed row's `due` → its `filed_on` → re-derived rule 61 → nothing), every one of the six states reached from real input and asserted reachable, running-to-today vs the carried upper bound, `not_due_yet` printing no negative days, `cannot_tell` printing no date and no zero, a blank `found_on` as `null` not 0, the totals excluding ignorance and splitting running from the ceiling, the oldest-wait pick, the deterministic read-only fold (same inputs, same figures, store unmutated), the 16-wide CSV with its `Rule` column citing 88B(2), and the citation split — 6 primary all `https`-sourced with a quotation mark, 2 `own` labelled `Reading:` with no URL, the gross "remains unpaid", the 18%/13/2017 rate and the s.50(2) "day succeeding" all present among the primaries. The four carried suites re-ran green — `/tmp/tally3-test.mjs` **99 / 0**, `/tmp/vault3-test.mjs` **120 / 0**, `/tmp/refundtrack-test.mjs` **344 / 0**, `/tmp/kb-record-test.mjs` **60 / 0** — **733 assertions across the five current `/tmp` suites, 0 failing**. As with R3-4 through R3-11, the Supabase session is signed out, so **this card has not been driven through the live UI**; its drive joins the same owed session. Rule **49** / ADR-**046** is where a shipped register learned to print what its waiting costs, on the base the rule actually names.

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
