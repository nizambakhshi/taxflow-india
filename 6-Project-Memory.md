# TaxFlow India — Project Memory

**Version:** 2.0  
**Date:** October 2026  
**Last Updated:** 2026-10-07  
**Purpose:** Track everything built, every decision made, every issue fixed.  
Update this file at the end of every development session.

Sessions 1–9 are the September MVP and Version 1 build. Sessions 10–18 are the
October rounds: the responsive rollout, Round 1 competitive features and
Round 2 depth work. The file list, storage keys and next steps below describe
the repository as it exists today.

---

## Project Identity

| Item | Value |
|------|-------|
| Product name | TaxFlow India |
| Live URL | https://taxflow-india.vercel.app |
| GitHub repo | private — `taxflow-india` (push to `main`, Vercel auto-deploys) |
| Local path | ~/Desktop/taxflow-india |
| Supabase project | taxflow-india |
| Supabase region | South Asia (Mumbai) |
| Next.js | 16.3.5 (App Router, Turbopack) |
| React | 19.2.8 |
| TypeScript | 5.x, strict |
| Tailwind CSS | 4.x |
| @supabase/ssr | 0.12.7 |
| @supabase/supabase-js | 2.109.0 |
| ESLint | 9.x flat config — `npx eslint <files>` (`next lint` no longer exists) |
| Node.js | v24 |
| Extra runtime libs | jspdf 4, html2canvas 1.4, tesseract.js 7, pdfjs-dist 6 |
| API routes | 2 only — `/api/gsp/ewaybill` (mock GSP transport), `/api/pdf-worker` (serves the pdf.js worker asset) |
| Developer OS | Mac Mini M4 (macOS) |
| Code editor | Qoder (was Cursor) |
| History | 39 commits on `main`; MVP landed 2026-09-19, rounds ran 2026-10-05 → 2026-10-07 |

---

## Architecture Decisions

Each ADR is marked **holds**, **amended** or **superseded**. Read the amended
ones before acting on the original wording.

### ADR-001 — Technology Stack — holds
**Decision:** Next.js + Supabase + Vercel  
**Reason:** Free tier covers the product, one language (TypeScript) throughout, Supabase handles auth + database + storage.  
**Alternatives considered:** React + Node + PostgreSQL (more complex), Django + React (two languages)  
**Note:** the stack has not changed since September; only the Next major version moved (15 → 16).

### ADR-002 — Multi-tenancy Model — holds
**Decision:** Shared database, application-level isolation via `organization_id`.  
**Reason:** Simpler to implement; every query filters by `organization_id`.  
**Future:** database-level enforcement (Phase 14).

### ADR-003 — RLS Disabled / Hand-Managed During Development — amended
**Decision:** Row Level Security is off or partial on all tables.  
**Reason:** @supabase/ssr 0.12.x + the App Router session cookie produced 403s on INSERT; policies were correct but the session never reached the database.  
**Amended (Oct 2026):** policies are edited by hand in the Supabase dashboard, never in this repo. App-level `organization_id` filtering is the active isolation mechanism. This is the reason new features ship client-side (ADR-013).  
**Affected tables:** all business tables — organizations, org_members, gst_registrations, profiles, customers, vendors, products, invoices, invoice_items, purchase_bills, purchase_bill_items, expenses, payments, stock_movements, invoice_sequences, gst_return_periods, warehouses, plus everything added later (see "Data model" below).

### ADR-004 — No Direct GST Filing — holds
**Decision:** The app prepares return data; it does not file.  
**Reason:** Direct GSTN integration requires a GSP (GST Suvidha Provider) contract.  
**Amended:** this is now enforced in code by ADR-016 and ADR-017 rather than left as a future concern.

### ADR-005 — Client-Side GST Calculation — holds
**Location:** `src/lib/gst-engine.ts` — the same engine drives invoices, GSTR-1, GSTR-3B, GSTR-9, registers, the ledger and the financial statements.

### ADR-006 — Invoice Data Immutability — holds
`invoice_items` stores `item_name`, `hsn_sac`, `rate`, `gst_rate` as copies taken at creation time. Quotation, credit-note and debit-note line items follow the same rule.

### ADR-007 — Invoice Number Format — amended
**Decision:** `INV-{FY}-{0000}` (e.g. `INV-2026-27-0001`), one row per org per FY in `invoice_sequences`.  
**Amended:** quotations, credit notes and debit notes each got their own sequence table in September, and the prefix is user-configurable in Settings. Offline drafts get a temporary `OFF-` number and are renumbered on replay (ADR-015).

### ADR-008 — Financial Year (India) — amended
April → March. `getFinancialYear()` lives in `gst-engine.ts:175`.  
**Amended (Oct 2026):** `src/lib/targets.ts` is now the shared FY calendar (`fyLabel`, `fyMonths`, `monthOf`, `SEASONAL_WEIGHTS`) and every period-aware feature imports it. Trap: `iso(year, month, day)` takes a **1-based** month while `fyMonth()` returns a **0-based** index into the FY — mixing them silently shifts everything one month.

### ADR-009 — No proxy/middleware — holds
`proxy.ts` was deleted (the cookie session was rewritten server-side and broke inserts). Auth is read client-side through `@supabase/ssr`.

### ADR-010 — URL-Based ID Resolution — holds
`src/app/(app)/invoices/[id]/page.tsx:26` still reads `window.location.pathname.split('/')`.  
**Amended:** the same file now also needs the `XPageInner` + `<Suspense>` split whenever it uses `useSearchParams`, otherwise prerendering fails.

### ADR-011 — Draft Invoice Cannot Be Marked Paid — holds.

### ADR-012 — Expense GST Calculation (Tax-Inclusive) — holds
`gst_amount = total − (total / (1 + rate/100))`.

### ADR-013 — Client-Side First, No Migrations — holds (new, Oct 2026)
**Decision:** A new feature must ride on existing tables plus local storage. No `supabase/migrations`, no new columns requested from the dashboard unless the feature is impossible without one.  
**Reason:** the schema is hand-managed in the Supabase dashboard (ADR-003); a migration file in the repo would be a second source of truth that nothing applies.  
**Consequence:** features that would normally need a table (reorder plans, compliance calendars, e-way bill logs, GSTR-9 declarations) store their state per organisation in `localStorage` instead. This is what let nine competitive features ship in three days.

### ADR-014 — Two-Layer State — holds (new)
Postgres holds the financial record (documents, parties, products, payments, stock). `localStorage` holds settings, declarations, plans, logs and queues. The split is deliberate: nothing in local storage is a figure a court, a CA or the GST portal would rely on. Anything a user would grieve losing is reconstructible from documents or already offered as an export (CSV, `.ics`, JSON).  
**Rule:** every key is namespaced `taxflow:<feature>:<orgId>` and carries `{ version, updatedAt, orgId }` (see the storage table below).

### ADR-015 — One Write Path Per Document — holds (new)
`src/lib/create-invoice.ts` and `src/lib/create-bill.ts` are the only ways an invoice or bill is written. The online form, the POS counter, the offline outbox replay and the scanned-bill draft all call them, so an offline invoice cannot diverge from an online one and there is no second implementation to keep in sync. Stock moves only through the `record_stock_movement` RPC (Rule 18).

### ADR-016 — GSP Behind an Adapter, Mock Provider — holds (new)
**Decision:** `src/lib/gsp/` defines a provider interface (`types.ts`, `index.ts`) with a mock implementation (`mock.ts`) and one route (`/api/gsp/ewaybill`).  
**Reason:** there is no free government API; a real connection needs a contracted GSP.  
**Consequence:** the UI, validation and payloads are real and only the transport is simulated. Swapping in a provider touches `gsp/`, nothing else. Do not describe the submit button as live filing.

### ADR-017 — E-Invoice as Build → Download → Paste — holds (new)
The app produces NIC v1.10 JSON (`src/lib/einvoice.ts`) for the user to upload at the IRN portal, then accepts the ACK (IRN + signed QR) back. No IRP call, no fake IRN. Same shape for e-way bill: payload + a register log in local storage.

### ADR-018 — AI That Never Leaves the Browser — holds (new)
**Decision:** OCR and text extraction run in the tab — tesseract.js for images, pdf.js for PDF text. Report answering is a deterministic intent engine (`src/lib/ask.ts`, 17 intents), not a model.  
**Reason:** no server-side LLM key, no per-seat cost, and a purchase bill is the most sensitive document a small business owns.  
**Consequence:** extraction quality is bounded by the engine and is surfaced as per-field confidence. The only server-side piece is `/api/pdf-worker`, which serves the `pdf.worker.min.mjs` asset out of `node_modules` so the worker version stays locked to the bundle instead of drifting from a CDN. No document bytes are ever uploaded.

### ADR-019 — Navigation and Search Are Data in One Place — holds (new)
`src/lib/nav.ts` is the only sidebar/mobile-nav definition; `CommandPalette` and the GST hub read it. `ENTITY_SPECS` in the palette defines live record search and each entry's `?q=` deep link into a list page.  
**Traps:** a new page not in `nav.ts` is invisible; a `?q=` column list that diverges from what that page actually filters on produces a hit that lands on an empty list; icon keys must exist in `Icons.tsx` or the item renders the fallback glyph.

### ADR-020 — One Styling Kit — holds (new)
New pages use `:root` tokens + `.tf-*` utilities (`globals.css`) and the primitives in `src/components/ui.tsx` / `Icons.tsx`. Counted honestly (R2-12): **11** pages are fully on the kit, **7** import only `SearchInput` and still hand-code their header/buttons/badges, **17** in the shell plus `login`/`signup`/`setup` are pre-kit. `4-Design-System.md` §16 is the ledger and the migration order; the earlier "~16 pages on the kit" claim counted a `SearchInput` import as a migration.

### ADR-021 — Documents Are Signed Rows — holds (new)
Credit notes carry a negative taxable value and negative tax; they are summed, never `Math.abs()`-ed. This single decision is why a credit note dated in a month correctly reduces that month in GSTR-1, the registers, targets and the annual workpaper at once.

### ADR-022 — Whole-Rupee Display in Dense Grids — holds (new)
Statutory tables (GSTR-9, registers, state-wise) format with `Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })`. Paise stay in the data; only display rounds. Rounding is applied per row and totals are computed from unrounded values, so a column still adds up.

### ADR-023 — Batched Line-Item Reads — holds (new)
Fetching items for many documents goes through 500-id chunks. A single giant `in=(...)` list returned a 400 from Supabase and blanked the registers page (commit `0aba36f`).

### ADR-024 — Invoice PDFs Are Rasterised, Not Vectorised — holds (new)
`html2canvas` at `scale: 2` placed into jsPDF as `image/jpeg` at 0.94 quality. PNG capture produced 36 MB invoices; the JPEG switch is why a 20-line invoice is now a few hundred KB. Captured node is `#invoice-capture`.

---

## GST Compliance Decisions

### GCD-001 — CGST+SGST vs IGST Rule
Same state code (supplier vs place of supply) → CGST + SGST. Different state → IGST. Export and SEZ always IGST. Source: CGST Act, verified at implementation.

### GCD-002 — GST Rates in Database
`gst_rate` per product, never hard-coded. Rates supported: 0, 5, 12, 18, 28%. Changing a rate must not alter historical invoices (ADR-006).

### GCD-003 — GSTIN Validation
`/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/` — format only; no GSTN lookup.

### GCD-004 — HSN vs SAC
Single `hsn_sac` field. Reporting granularity depends on turnover — the current threshold must be verified at cbic.gov.in.

### GCD-005 — ITC Eligibility
User-controlled `itc_eligible` flag per bill/expense; Section 16 conditions are the user's call. The app advises CA verification.

### GCD-006 — Reconciliation Compares, It Does not Decide (new)
`/gst/reconciliation` classifies each 2B credit (matched, mismatched, missing in books, only in books, amount/date/rate differs). It cannot know what was actually filed — the portal statement is the user's input and the books are ours; the user picks the action.

### GCD-007 — Declared Gaps Beat Silent Ones (new)
Rule 42/43 reversals, ITCA-01 demands, Table 8 importer credit and Table 9 carry-forward are not computable from documents. Pages state this plainly instead of guessing zero (Rule 19).

### GCD-008 — GSTR-9 / 9C Is a Workpaper (new)
`/gst/gstr9` builds outward and ITC tables from documents plus **declared** 3B figures, watches the 180-day credit limit, and reconciles books vs 3B. It is a preparation tool for a CA, not a return.

### GCD-009 — Applicability Is Declared, Not Inferred (new)
E-invoice threshold, e-way bill requirement, filing profile (monthly/QRMP) and TDS obligations come from user settings, because turnover and registration state cannot be derived from documents the app has never seen.

### GCD-010 — Withholding: the section is the user's call (new)
`/tds` reads a purchase bill's amount and party but cannot know whether that spend is a contract, a commission or rent — goods-vs-service and the 194 section are chosen by the owner (per vendor, overridable per bill), and an untagged vendor stays visibly untagged. Rates and thresholds are printed for the CA to verify rather than made editable; a dateless challan is dropped rather than half-saved.

---

## Completed Sessions

### Sessions 1–8 — September 2026 (MVP)
**Built:** project setup and auth (1); organisation/profile tables plus the setup wizard and GSTIN validation (2); `constants.ts` and the customer/vendor/product masters with the sidebar shell (3); invoice tables, the GST engine, create/list/detail pages and print (4); purchase bills, expenses and ITC (5); payments with ageing buckets and record-payment modal (6); stock movements, the `record_stock_movement` RPC and the inventory page (7); GST dashboard, GSTR-1, GSTR-3B, live dashboard, 6-month chart and business reports (8).  
**Resolved:** `infinite recursion detected in policy for relation "org_members"` (policies rewritten to avoid self-reference); `new row violates row-level security policy for table "organizations"` (RLS disabled, ADR-003); `params is a Promise` (ADR-010); duplicate `/dashboard` routes (deleted `src/app/dashboard/page.tsx`).

### Session 9 — September 2026
**Built:** the six project documents (PRD, System Architecture, Development Rules, Design System, Project Tasks, Project Memory).

### Session 10 — 2026-09-27 → 09-28 (Version 1)
**Built:** logo upload (Supabase Storage `logos` table), quotations with conversion to invoice, credit notes, debit notes, each with its own sequence and PDF print.  
**Resolved:** debit note missing from the sidebar; logo upload blocked by an RLS policy on `logos`; the quotation → invoice handoff dropped line items.  
**Commits:** `ddd5988`, `beae8d4`.

### Session 11 — 2026-09-30 (mobile shell)
**Built:** responsive sidebar collapse, bottom nav, sheet menu and card views for tables. **Commit:** `4666b74`.

### Session 12 — 2026-10-02 → 10-05 (responsive rollout)
**Built:** the responsive pattern converted page by page across invoices, masters, documents, payments, reports, settings, GST.  
**Resolved:** the dashboard file was overwritten by an invoices list during the rollout and had to be restored from history (`b234aa0`); CSS-grid tables needed labelled-card mobile treatments with `data-label`; rupee figures have no break opportunity, so long amounts overflowed until each line-item split its own row.  
**Lessons:** verify `scrollWidth − clientWidth === 0` at phone width, and check a desktop width too — a `.cols > .is-right` specificity outranks the mobile `.cols > span` rule.

### Session 13 — 2026-10-05 (Round 1, features 1–4)
**Built:** GSTR-2B reconciliation (`/gst/reconciliation` + `gstr2b.ts`); e-invoice and e-way bill (`/gst/einvoice` + `einvoice.ts` NIC v1.10, GSP adapter `src/lib/gsp/` + `/api/gsp/ewaybill` mock, submit-to-GSP in the e-way bill modal); payment links and WhatsApp reminders (`/payments/links` + `payments.ts`, `upi://pay` deep links); light double-entry statements (`/accounting` + `ledger.ts`, P&L excluding GST and an always-balancing balance sheet).  
**Commits:** `46a1eb4`, `d6207e3`, `c965c4a`, `0336abb`, `7e0500f`.

### Session 14 — 2026-10-05 → 10-06 (Round 1, features 5–7)
**Built:** offline PWA (`app/manifest.ts`, `public/sw.js`, `public/offline.html`, `/offline`, `outbox.ts` — network-first navigations, offline invoice queue replayed through the real save path); barcode + POS (`barcode.ts` GS1 mod-10 across EAN-13/EAN-8/UPC-A/ITF-14/CODE-128, `BarcodeScanner.tsx`, `/pos`, `create-invoice.ts` extracted as the single write path); AI features (`/ai/scan-bill` with `bill-text.ts`, `ocr.ts` and `/api/pdf-worker`; `/ai/ask` with `ask.ts` and 17 report intents).  
**Resolved:** cancelling bills and deactivating vendors needed soft-delete handling that keeps documents intact (`7a94b59`). Barcode and OCR both degrade gracefully: keyboard-wedge scanner entry, and paste-as-text for a bill the OCR cannot read.  
**Commits:** `5752c6c`, `8fedf54`, `cbd2225`, `7a94b59`.

### Session 15 — 2026-10-06 (R2-1 → R2-4)
**Built:** Design System v1 (`:root` tokens + `.tf-*` utilities, `Icons.tsx`, `ui.tsx`, `format.ts`, `reports.ts`, rebuilt app shell and dashboard); party ledger (`/ledger` + `party-ledger.ts`, document-first payment linking, running balance, statements); compliance calendar (`/gst/calendar` + `compliance.ts`, filing-profile FY generator, late-fee estimates, `.ics` export); statutory registers (`/reports/registers` + `registers.ts`, party-wise, HSN/SAC, B2B, Rule 80(1) state-wise, e-way bill log).  
**Commits:** `63faa25`, `16257ef`, `36b3240`, `158c44b`.

### Session 16 — 2026-10-06 (R2-5 → R2-7 + hotfix)
**Built:** invoice document skins `classic` / `modern` / `minimal` in `InvoiceDocument.tsx` plus `words.ts` amount-in-words; targets and achievement (`/reports/targets` + `targets.ts`, festival-weighted split with October carrying the peak weight, prorated pace, product goals); reorder planner (`/inventory/reorder` + `reorder.ts`, demand-driven `(s, S)` policy, supplier-grouped purchase orders).  
**Resolved:** editing a product reset `current_stock` — a real data-loss bug, fixed by seeding stock only on insert and never overwriting it on update (`83d369a`); register fetch 400 from an unbounded `in=` list (ADR-023); mobile toolbar overflow; 36 MB invoice PDFs (ADR-024). **Commit:** `0aba36f`.

### Session 17 — 2026-10-07 (R2-8, R2-9)
**Built:** ⌘K command palette (`commands.ts`, `CommandPalette.tsx`, `nav.ts`, `deep-link-search.ts`) covering pages, actions and live record search, with `?q=` deep links added to bills, credit notes, debit notes and quotations; GSTR-9 / 9C annual workpaper (`/gst/gstr9` + `gstr9.ts`) with outward and ITC tables, the 180-day credit watch, 9C books-vs-3B reconciliation and CSV export.  
**Resolved:** duplicate listbox ids when several palette groups rendered at once; a deep link that searched a column the list page did not filter on; `.tf-cmd-foot` label specificity on mobile.  
**Commits:** `f3b3d49`, `95e1ee8`.

### Session 18 — 2026-10-07 (documentation sync)
**Built:** this file, plus `README.md` (replaced the create-next-app boilerplate), `1-PRD.md` (v2.0 — 8 USPs, modules 3.16–3.29, refreshed out-of-scope), `2-System-Architecture.md` (v2.0 — current stack, folder tree, data model, §12 client-side state layer, §13 offline, §14 feature map, §15 verification), `3-Development-Rules.md` (v2.0 — Rules 21–28, rewritten checklists), `4-Design-System.md` (v2.0 — full token/utility/component/icon/table/print catalog and migration status) and `5-Project-Tasks.md` (Version 1 and both rounds recorded, backlog rewritten around R2-10).  
**Method:** every statement was re-checked against the code — routes, `package.json`, `nav.ts`, `globals.css`, storage keys, commit hashes — not from recollection.

### Session 19 — 2026-10-07 (R2-10)
**Built:** bank statement matching (`/bank` + `bank-statement.ts`, `nav.ts`). The parser takes pasted or uploaded CSV/TXT from any Indian bank — delimiter chosen by modal cell width, header roles matched on wording so column order does not matter, Indian dates, `₹1,20,000.50`, `Rs. 4,500/-`, trailing dashes and parentheses, quoted narrations with embedded commas (spill merged back into the narration column), UTR de-duplication against a content-derived line id. Direction is resolved in order: split Dr./Cr. columns → signed cell → Dr/Cr indicator column → running-balance delta → narration tokens → credit default. The scorer weights amount 40 against balance due or document total, document number 30, party 18, date 12, with a recorded-payment reference worth 45 and a cap of three ranked candidates per line; tiers are exact ≥ 80, likely ≥ 58, possible ≥ 40. Unexplained lines get advisory text (interest, GST challan, salary, EMI, bank charges, expenses) instead of a blank row. Confirming writes only to `taxflow:bank:<orgId>` — the ledger is still written on the Payments page, matching the GSTR-9 workpaper stance.  
**Resolved:** a positive figure in a lone Amount column defaulting to debit whenever a balance column existed (now `readMoney`'s ordered resolution); comma-spill merging shifting every column after the narration (`splice` must remove the extra cells, not replace one); `Rs. 4,500/-` parsing to NaN because the Indian filler dash survived cleaning; the "already in your books" path being unreachable — amount + party + date cap at 70, below the 80 gate, so the gate is now the three-signal agreement plus a 45-day window; duplicated "amount" wording in the reason strings.  
**Method:** 69 assertions in a throwaway strip-types suite, then the real books (`/payments`: INV-2026-27-0005 ₹14,00,000, INV-2026-27-0001 ₹10,000 due, bill 1244432 Mohd Faizan ₹4,42,500, two September payments) driven through the browser at 341px and inside a 1440×900 same-origin iframe; the exported CSV was captured from `URL.createObjectURL` and read back rather than trusted. Verification rows were removed through the app's own Remove action.  
**Commits:** `7560987`.

### Session 20 — 2026-10-07 (R2-11)
**Built:** TDS / 194Q withholding workpaper (`/tds` + `tds.ts`, `nav.ts`, two chevron icons). The section table (194A, 194C, 194H, 194I land and plant variants, 194J professional and technical, 194M, 194Q, 194R) carries rate, threshold and whether the threshold is read against the whole amount or the excess; the base is taken out of purchase bills with GST excluded whenever it is itemised, and per-bill / per-vendor section overrides are owner choices, not guesses. Deduction falls in the earlier of credit or payment month. The deposit calendar is the 7th of the next month (March → 30 April), and interest runs at 1.5%/month where tax was deducted but not deposited and 1%/month where it was never deducted, with part-months counted; 26Q statements add the ₹100/day late-fee capped at the tax and at ₹5,00,000. PAN comes from the vendor, else from characters 3–12 of its GSTIN, else the no-PAN rate is used and flagged. Nothing is filed and no rate is treated as authoritative — the workpaper prints the rate for the owner's CA to check, and untagged spend is surfaced as a KPI and a clickable strip rather than silently dropped. Two CSV sheets (deductions, deposits); state in `taxflow:tds:<orgId>`, keyed by month so it spans FYs.  
**Resolved:** 26Q quarterly due dates computed from `fyStart` rather than the quarter's own calendar year, so FY26-27 Q4 printed "31 May 26" instead of 31 May 27 — the due year is now relative to the quarter year; a challan amount typed before its deposit date was discarded, because `setChallan` drops dateless challans and the field handler rebuilt from state instead of from the draft, fixed by merging the whole draft on every field; workpaper rows read as date-ordered in a test expectation when they are grouped section → vendor → date; `monthLabel` returns full month names ("August 2026"), not abbreviations; an untagged vendor rendering as "Nothing to withhold" (a section that was never chosen is not a section chosen as none).  
**Method:** 70 assertions in the strip-types suite, then the real books in the browser (bill 1244432 Mohd Faizan ₹4,42,500 taxable ₹3,75,000, VB-001 ₹3,000, VB-002 ₹300, the 20/9 payment) at 352px and inside a 1440×900 same-origin iframe; the challan draft order bug was only found by driving the actual inputs in the wrong order, which is the argument for driving them at all. Export bytes captured through `URL.createObjectURL`, deep link tested via ⌘K (the listener is on `document`, not `window`).  
**Commits:** `cafc86b`.

---

## Files Created (Complete List)

### Routes — 38 pages
```
src/app/
├── layout.tsx, page.tsx (→ /login), manifest.ts, globals.css, favicon.ico
├── login/  signup/  setup/
├── api/gsp/ewaybill/route.ts        ← mock GSP transport
├── api/pdf-worker/route.ts          ← version-locked pdf.js worker asset
└── (app)/                           ← shell: layout.tsx + nav.ts data
    ├── dashboard/                   pos/            offline/
    ├── invoices/{page,new,[id]}/    quotations/     customers/  vendors/  products/
    ├── bills/  expenses/  credit-notes/  debit-notes/
    ├── payments/page  payments/links/  bank/
    ├── inventory/page  inventory/reorder/
    ├── ledger/  accounting/
    ├── tds/                         ← withholding workpaper
    ├── gst/{page,gstr1,gstr3b,gstr9,reconciliation,einvoice,calendar}/
    ├── reports/{page,registers,targets}/
    ├── ai/{ask,scan-bill}/
    └── settings/
public/sw.js  public/offline.html
```

### Libraries — 28 modules in `src/lib/` + `src/lib/gsp/`
```
supabase.ts  constants.ts  gst-engine.ts  format.ts  words.ts  reports.ts
create-invoice.ts  create-bill.ts            ← the only document write paths
einvoice.ts  gstr2b.ts  gstr9.ts  compliance.ts  registers.ts  payments.ts
ledger.ts  party-ledger.ts  targets.ts  reorder.ts  barcode.ts  outbox.ts
bill-text.ts  ocr.ts  ask.ts  commands.ts  nav.ts  deep-link-search.ts
bank-statement.ts                             ← statement parser + match scorer
tds.ts                                        ← withholding sections, workpaper, deposits
gsp/{index.ts, types.ts, mock.ts}            ← provider adapter, mock transport
```
(`gst-engine.ts` also still exports the legacy `numberToWords()` that the classic
print layout uses. `words.ts` is the newer implementation. They intentionally
coexist — do not "unify" them and change a printed invoice silently.)

### Components — 6 in `src/components/`
```
ui.tsx            ← Card, SectionTitle, StatCard, DeltaPill, Badge, Tone tokens
Icons.tsx         ← stroke glyph set, key lookup with dashboard fallback
InvoiceDocument.tsx  ← classic / modern / minimal skins
CommandPalette.tsx   ← ⌘K
BarcodeScanner.tsx   ← getUserMedia + BarcodeDetector, graceful degrade
PwaRegister.tsx      ← service-worker registration
```

### Data model
MVP tables (September): `profiles`, `organizations`, `org_members`, `gst_registrations`,
`customers`, `vendors`, `products`, `invoice_sequences`, `invoices`, `invoice_items`,
`purchase_bills`, `purchase_bill_items`, `expenses`, `payments`, `warehouses`,
`stock_movements`, `gst_return_periods`.

Added after the MVP: `logos`,
`quotations` + `quotation_items` + `quotation_sequences`,
`credit_notes` + `credit_note_items` + `credit_note_sequences`,
`debit_notes` + `debit_note_items` + `debit_note_sequences`,
and columns on `products` (`sku`, `minimum_stock`, `opening_stock`).
`warehouses` is in the schema but never queried — stock is tracked per product.
Scanned bills are drafted in the browser and only reach the database when the user
saves a real purchase bill; there is no `documents` table.

Functions: `handle_new_user()`, `is_org_member(org_id)`, `is_org_owner(org_id)`,
`record_stock_movement(...)` — the only permitted way to change stock.

Schema constraints the code has to live with: `payments` has no party id (the ledger
links payments to documents first, then normalises party names, and drops receipts
pointing at cancelled or missing documents); `invoices.customer_id` nullability is
unknown, so a POS cash sale auto-creates a cash customer; `warehouses` exists but is
unused; `current_stock` is seeded from `opening_stock` on insert only.

---

## Client-Side State Keys (localStorage)

All keys are namespaced per organisation as `taxflow:<feature>:<orgId>` and store
`{ version, updatedAt, orgId, ... }`. Clearing the browser is a real user risk, so
anything here is either reconstructible from documents or already exported.

| Key | Holds | Written by |
|-----|-------|-----------|
| `taxflow:upi:` | UPI IDs and link settings | `/payments/links` |
| `taxflow:opening:` | balance-sheet opening balances | `/accounting` |
| `taxflow:outbox:` | offline invoice queue | `/offline`, the invoice form |
| `taxflow:ewb:` | e-way bill log | `/gst/einvoice` |
| `taxflow:compliance:` | per-event filing status | `/gst/calendar` |
| `taxflow:compliance-profile:` | filing profile (monthly / QRMP) | `/gst/calendar` |
| `taxflow:targets:` | annual plan and product goals | `/reports/targets` |
| `taxflow:reorder:` | policy overrides and PO history | `/inventory/reorder` |
| `taxflow:invoice-template:` | skin choice | `/settings` |
| `taxflow:gstr9:` | declared 3B figures and Table 8/9 input | `/gst/gstr9` |
| `taxflow:bank:` | imported statements and confirm/set-aside decisions | `/bank` |
| `taxflow:tds:` | section overrides, payer type and monthly challan details for withholding | `/tds` |
| `taxflow:palette-recents:` | recent ⌘K hits | `CommandPalette.tsx` |

---

## Traps That Cost Debugging Time

Recorded so the next session does not rediscover them.

1. **CSS specificity across breakpoints** — a desktop `.cols > .is-right` rule outranks the mobile `.cols > span` rule; override with equal or higher specificity, not with `!important`.
2. **Rupee strings have no break opportunity** — one figure per line on mobile, and assert `scrollWidth − clientWidth === 0` rather than eyeballing.
3. **`node --experimental-strip-types --loader /tmp/ts-loader.mjs`** registers the ESM hook; `--import` does not, and the test file then fails to parse TypeScript.
4. **Library test suites live in `/tmp`** and are not committed. Recorded counts at R2-11: gstr2b + compliance 30, registers 20, words 29, targets 38, commands 26, gstr9 35, tds 70 — rewrite them when a library changes.
5. **`1-based` vs `0-based` months** — `iso(y, m, d)` vs `fyMonth()`; off-by-one shifts a whole quarter.
6. **`Math.abs()` on a signed document** — turns a credit note into extra sales.
7. **Unbounded `in=(...)`** — Supabase 400s; chunk at 500 ids.
8. **BOM duplication** — `party-ledger.download()` already prefixes `\uFEFF`; combining it with `csvFromRows` produced a doubled marker. Ragged rows go through `csvFromRows`.
9. **`useSearchParams` on a prerendered page** — needs the `XPageInner` + `<Suspense>` split or the build fails.
10. **Duplicate listbox ids** — the palette must namespace option ids per group and per query.
11. **`?q=` column parity** — a deep link must filter on exactly the columns the list page reads, or a search hit lands on an empty list.
12. **Supabase reads are `as any[]`** with explicit `.select()` lists — the repo's accepted baseline until types are generated; compare `npx eslint` output against the pre-existing count instead of expecting zero.

---

## Verification Environment

- Dev server on `http://localhost:3000`; browser-use drives it. The panel viewport is ~371–455 CSS px, so the native mobile breakpoint is what you actually see; inspect a desktop width through a same-origin 1440×900 iframe reading `getComputedStyle` / `scrollWidth`.
- Screenshots are not informative here — DOM assertions are authoritative. When `take_screenshot` and `click` are both unavailable (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`), drive everything through `evaluate_script` with `.click()` and settle for computed style / `scrollWidth` instead of pixels.
- The ⌘K listener is attached to `document`, not `window` — dispatching the keydown on `window` does nothing.
- React controlled inputs are set through the native value setter plus `change`/`input` events; assigning `.value` alone leaves state stale.
- Test data is cleaned through the in-app Cancel / Deactivate flows, never by deleting rows in the dashboard.
- Test login credentials are for the local dev server only and must never be written into a file, source, config, fixture or commit. Do not read `.env`.

---

## Pending Decisions (Need Discussion)

| Decision | Options | Priority |
|----------|---------|---------|
| Real GSP provider | which GSP, contract, per-document cost — adapter is ready and waiting | High (blocks live e-invoice/e-way bill) |
| RLS approach | regenerate types + dashboard policies vs keep app-level isolation | High (before real customers) |
| Bank statement format coverage | paste-only vs per-bank templates; how many banks matter | Medium (R2-10 ships the generic parser; this shapes refinements) |
| Email provider for invoice delivery | Resend, SendGrid, Supabase SMTP | Medium |
| Multi-user model | org invites + RBAC roles vs single-seat | Medium |
| SaaS pricing | Free / Starter / Professional tiers, Razorpay | Low |
| Custom domain | taxflowindia.com | Low |

---

## Passwords and Credentials (Store Separately)

**DO NOT store actual credentials in any file in this repository — not here, not in
source, not in a test fixture, not in a commit message, not in `.env.local.bak`.**

Store them in the Mac Keychain, Notes, 1Password or Bitwarden:
- Supabase database password, project URL and anon key
- GitHub account credentials
- Vercel account credentials
- The local test login (usable only to sign in at `localhost:3000` for browser verification)
- Future: Razorpay API keys, GSP credentials, email provider key

---

## Quick Commands Reference

### Local development
```bash
cd ~/Desktop/taxflow-india
npm run dev
# Open: http://localhost:3000
```

### Verification before commit
```bash
npx tsc --noEmit
npm run build          # watch the route table: static / prerendered / dynamic
npx eslint <touched files>   # `next lint --file` no longer exists
```

### Pure-library tests (no browser, no app)
```bash
node --experimental-strip-types --no-warnings \
     --loader /tmp/ts-loader.mjs /tmp/<lib>-test.mjs
# --loader registers the TypeScript ESM hook; --import does not.
```

### Deploy
```bash
cd ~/Desktop/taxflow-india
git status                    # review what is staged — never `git add .`
git add <files by name>
git commit -m "$(cat <<'EOF'
Feature: short description
EOF
)"
git push                      # Vercel auto-deploys in 2–3 minutes
```

### Inspect versions
```bash
npm list @supabase/ssr next react typescript
node --version
```

---

## Next Steps (Priority Order)

1. **R2-12 — Design-system migration pass** (next up) — ~20 pre-kit pages still carry inline styles; migrate as touched, batch the rest.
2. **GSTR-4 (Composition)** workpaper for the smaller registrants.
3. **Phase 14 — Security**: generated Supabase types, tightened dashboard RLS policies, audit log, multi-account isolation test. Do this before onboarding a real customer.
4. **Real GSP integration** once a provider is chosen (ADR-016) — plus email invoices and multi-user, which need the pending decisions above.

---

## Important Reminders

1. **RLS is disabled or partial** — no real customer data before Phase 14.
2. **Nothing files a return.** Every GST page is a workpaper; the user transcribes or uploads it and verifies at gst.gov.in.
3. **GSP submission is a mock** — the adapter is real, the transport is not. Never call it live.
4. **AI runs in the browser** — no uploads, no server model, per-field confidence on every extracted value.
5. **Schema is hand-managed** — ship the feature client-side (ADR-013) unless a new column is genuinely unavoidable.
6. **Documents are signed** — credit notes reduce, they never invert.
7. **Stock changes only through `record_stock_movement`**, and a product edit must never reset `current_stock`.
8. **GST rates come from the database**, never hard-coded, and a rate change must not touch historical invoices.
9. **Profit figures are indicative**, not a certified P&L.
10. **New pages must be in `nav.ts`** or they do not exist for the user or ⌘K.
11. **Test GSTIN** — `27AABCU9603R1ZX` (valid format, not a real registration).
12. **Verify in the browser before committing**, at phone width and 1440px, with zero horizontal overflow.
