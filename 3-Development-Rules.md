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
- `jspdf` + `html2canvas` — invoice PDF export (screenshots `#invoice-capture` at `scale: 2`)
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
node --experimental-strip-types --no-warnings --loader /tmp/ts-loader.mjs /tmp/<lib>-test.mjs
```

Use `--loader`, not `--import` — `--import` does not register the ESM resolve hooks, so `@/lib/...` imports fail with `ERR_MODULE_NOT_FOUND`. The loader handles `@/` **and** extensionless relative imports.

Assertions are written against the domain, not the implementation: FY-weighted splits must sum to exactly the annual plan, a credit note must reduce the month it is dated in, `csvFromRows` must quote a field containing a comma. Current suites: `gstr2b`, `compliance` (30), `registers` (20), `words` (29), `targets` (38), `commands` (26), `gstr9` (35).

---

## Rule 24 — Local Storage Is Namespaced Per Organisation

```typescript
const KEY = 'taxflow:<feature>:' + orgId      // never a bare global key
```

Store a `version` field and an `updatedAt` timestamp so a shape change can migrate instead of crash, and treat a parse failure as "start fresh" rather than throwing. A shared browser must never show one business's targets, filing profile, outbox or template choice to another.

Anything a user would grieve losing must be reconstructible from documents or exportable (CSV, `.ics`, JSON) — a cleared browser is a normal event, not a disaster.

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
