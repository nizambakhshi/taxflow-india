# TaxFlow India — Project Memory

**Version:** 2.0  
**Date:** October 2026  
**Last Updated:** 2026-10-08  
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
| History | 70 commits on `main`; MVP landed 2026-09-19, rounds ran 2026-10-05 → 2026-10-08 |

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
`src/app/(app)/invoices/[id]/page.tsx:28` still reads `window.location.pathname.split('/')`.  
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
New pages use `:root` tokens + `.tf-*` utilities (`globals.css`) and the primitives in `src/components/ui.tsx` / `Icons.tsx`. Counted honestly (R2-12, complete): **32** pages inside the shell plus the three auth pages (`login`, `signup`, `setup`, on the shared `src/components/AuthShell.tsx`) are on the kit, and **4** (`bills`, `credit-notes`, `debit-notes`, `quotations`) import only `SearchInput` and still hand-code their header/buttons/badges. No shell page is pre-kit anymore: the pass closed with the two document pages. `4-Design-System.md` §16 is the ledger and the migration order; the pre-R2-12 "~16 pages on the kit" claim counted a `SearchInput` import as a migration.

"Fully on the kit" is about the chrome, not about a clean hex audit — `ledger` (7), `reports/targets` (9), `reports/registers` (6), `pos` (6), `ai/scan-bill` (6), `gst/calendar` (4), `gst/gstr9` (3), `inventory/reorder` (3) and `dashboard` (2) all still hold one-off tints (row hover, skeleton gradient, border next to a `--*-soft` fill, the document-type colour map). `reports`, `settings`, the auth trio (three pages plus `AuthShell`) and `invoices/new` migrated to absolute zero hex; the brand gradient those pages needed now lives in one `--brand-grad` token, shared with the sidebar mark. **The one deliberate exception is the printable document inside `invoices/[id]`:** its chrome is at zero but the classic document keeps 63 hex literals (cell tints, `#dbeafe` fills, zebra rows, red/green summary text) because that markup is a legal artefact and changing its palette is changing the artefact — do not "fix" it without a reason that survives a print test.

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

### Session 21 — 2026-10-07 (R2-12, batches 1–2)
**Built:** design-system migration pass on five list pages — `invoices` (`f0e7d58`), `expenses` (`498dbbb`), then the whole masters tier: `vendors`, `customers`, `products` (`50b190f`, plus a one-line fix in `ui.tsx`). Each page keeps its behaviour and gains the kit chrome: `PageHeader` with an eyebrow, four `StatCard`s whose fourth is the compliance gap that page causes (To collect · Not yet paid · no-identifier vendors · B2B buyers without GSTIN · lines without HSN/SAC), one `Segmented` filter row over a token-driven table, a kit modal (`*-scrim` / `*-modal` / `*-field`) that collapses to a bottom sheet on phones, and a footnote that states what the page does *not* touch. Customers also gained the deactivate/reactivate action that existed as dead code, and products show stock against its alert level.  
**Resolved:** `Segmented` rendered bare `<button>`s, so the goods/service switch inside the product `<form>` submitted the product instead of switching type (console: "Form submission canceled because the form is not connected") — the primitive now emits `type="button"`; the vendors empty state read "No no identifier vendors" once the title was built from the filter label, so each filter carries its own `noun`; a product with an alert level of 0 rendered "50 of 0 alert", now "50 in stock".  
**Method:** every page checked at the ~341–456px panel and inside a same-origin 1440×900 iframe (`getComputedStyle` for grids, `scrollWidth` for overflow), with `window.confirm` stubbed in-page so deactivation could be tested and then reverted — twice the accidental deactivation of SHREE GANESH TRADERS was undone before the tree was confirmed clean. Writes were tested through paths that cannot persist (invalid GSTIN rejected before insert, modal edits closed with Cancel), and row counts re-read afterwards. `grep -o '#[0-9a-fA-F]\{3,8\}'` per file is the "0 hex" claim; `rgba(15,23,42,0.45)` on the scrim is the one literal the kit still allows, matching `/bank` and `/expenses`.  
**Commits:** `f0e7d58`, `498dbbb`, `50b190f`.

### Session 22 — 2026-10-07 (R2-12, batch 3 — money)
**Built:** `/payments` and `/payments/links` on the kit (`e5cc103`). A rewrite rather than a recolour: `PageHeader`, four `StatCard`s, `Badge`, `Button`, `Segmented`, `EmptyState` and the shared table recipe replace the hand-coded chrome, and both files now carry zero hex literals. Receivables and payables were two near-identical tables and are now one table fed by two typed mappers (`asReceivable` / `asPayable`) into a shared `Outstanding` shape, so a third kind of outstanding document costs a mapper instead of a second table. The links page runs its reminder through the kit `Segmented` over `DEFAULT_REMINDER_TEMPLATES`, with `reminderBody()` extracted so switching tone and opening WhatsApp share one code path. Ledger after the batch: 16 pages on the kit, 4 partial, 15 pre-kit (+3 auth).  
**Resolved:** two latent data bugs that only existed because nobody read the code during a styling pass — the recorded-payments window was `.limit(20)` (any org with 21 receipts silently lost one from the summary and the list), and the "Payments This Month" card compared `getMonth()` alone, so it counted the same month of every year (`isThisMonth` now checks the year too). Both were fixed rather than migrated. Also: `alert()` on an invalid VPA became an inline notice plus opening the settings panel, and save now validates the VPA before persisting instead of failing later at link build; the history tab gained a "Settles" column that resolves `invoice_id` / `bill_id` to a document number, so a fully-paid invoice that left the outstanding lists still shows what a payment was for; `react-hooks/immutability` caught the pre-existing pattern of calling `loadInvoices` above its declaration, fixed by moving the loader above the mount effect instead of adding a dependency that would re-run it.  
**Method:** the claim "0 hex" is a `grep -o '#[0-9a-fA-F]\{3,8\}'` per file; verification is that count plus the same page measured at 344px (block rows, hidden header, `[data-label]::before` labels, two-column stats, `scrollWidth === clientWidth`) and at 1440 inside a same-origin iframe. Nothing was written to the database: the over-balance payment and the invalid VPA were exercised through their validators, and the reminder modal was left by Cancel after changing the tone and template. Restoring from a context summary can be wrong — the summary described a `fetchOutstanding` helper and a `src/lib/utils` money import that do not exist (`formatINR` comes from `@/lib/gst-engine`), so the file was read in full before rewriting.  
**Commits:** `e5cc103`.

### Session 23 — 2026-10-07 (R2-12, batch 4 — money tier closed)
**Built:** `/accounting` and `/offline` on the kit (`f2b0d85`), which closes the money tier. Ledger: 18 pages on the kit, 4 partial, 13 pre-kit (+3 auth). The statements page keeps `computeProfitLoss` / `computeBalanceSheet` exactly as they are and puts the derived numbers in four `StatCard`s (revenue, net profit with its margin, total assets with its split, and the size of the unmapped-money plug), a `Segmented` for statement and period, and the statement itself as token-driven lines rather than a styled `<div>` tree; the opening-balances fields moved out of a `numField()` helper into a data array so the four fields share one markup path. `/offline` turned its status strip into four cards (queued here, value waiting, failed, connection) and its invoice cards into the shared table recipe, with the sync button in the header instead of a coloured bar.  
**Resolved:** three things the old markup was hiding. The balance sheet printed an unconditional green "✓ Assets = Liab. + Funds" — the equality holds *by construction*, because `balancingReserve` is computed as `ownersFunds − openingCapital − retainedEarnings`, so the check reported nothing; it now states the plug amount and turns amber while any unmapped movement sits in it. `/offline`'s "Syncing…" button asked for `<Icon name="sync">`, and `Icons.tsx` ends with `{P[name] ?? P.dashboard}` — an unknown name renders the **dashboard** grid rather than failing, so a missing icon is invisible unless you go looking for it. And discarding a queued invoice deleted it with no confirmation, which is the loss of an unsynced financial document; it now asks, with the temporary number in the question. `react-hooks/set-state-in-effect` also rejected two effects that set state synchronously: the `?queued=1` flag became a derived value instead of state-plus-effect, and `navigator.onLine` moved into the `useState` initialiser (SSR-guarded) rather than being set inside the listener effect.  
**Method:** styling verification is a hex count plus pixels, but these pages needed numbers too — the balance sheet was read at the real books and the two sides checked by hand (assets ₹14,20,452 − liabilities ₹5,34,111 = owner's funds ₹8,86,341, with the ₹27,480 plug matching the new card). The offline queue row layout could not be verified against real data because nothing was queued, so one synthetic entry was written to `taxflow:outbox:<orgId>`, measured at 355px and at 1440, and the key restored to its exact prior value (`[]`) afterwards; the discard guard was tested on that synthetic entry with `window.confirm` stubbed to `false` first, then to `true`. No network write was possible at any point: "Sync now" was never clicked, and it is disabled whenever the queue is empty.  
**Commits:** `f2b0d85`.

### Session 24 — 2026-10-07 (R2-12, batch 5 — GST return tier)
**Built:** the `gst` hub, `gstr1` and `gstr3b` on the kit (`0a97632`). Ledger: 21 pages on the kit, 4 partial, 10 pre-kit (+3 auth). The hub reads one period through `Promise.all` of three narrowed queries and *returns* the figures, so mount resolves identity in one effect and the fetch runs in a second — the old page fetched twice on mount. GSTR-1 moved to a column-definition model (`Column<Row>[]` per tab, one generic `ReportTable`) so the screen, the totals row and the CSV all come from the same list of heads; HSN gained the cess column it was already aggregating. GSTR-3B is now a head-wise model — `{ outward: { other, zeroRated, nilExempt }, itc, payable, utilised, carried, cash }` — with `settle(payable, credit)` per head, so the return states what a real 3B states: which credit was used and which carried forward.  
**Resolved:** nine things the old markup was hiding, all of them arithmetic rather than CSS. 3B added all outward IGST to row (a) **and** export tax again to row (b), so the sections did not sum; row (c) was hard-coded zero even though nil-rated invoices exist in the books; "ITC to be used" printed the entire credit, which makes `payable − ITC ≠ net` the moment one head is over-credited, and IGST credit was silently being allowed against CGST. The hub wrote `financial_year` from *today* rather than from the selected period, and printed GSTR-1/3B due dates inside the tax month ("11 Aug") while the filing month is the next one — `compliance.ts` already knew this. Both CSVs were `join(',')`, so a single customer name with a comma shifted every later column; they now go through `csvFromRows` + `download`. The hub fetched `orgStateCode` and never showed it. Fixing these was only possible because the rebuilt screens had to *state* the invariant — a table whose rows must add up is a test.  
**Method:** each page was re-checked numerically against the books at Sept 2026 (6 invoices, 3 ITC-eligible bills): taxable ₹13,04,800 + tax ₹1,59,846 = ₹14,64,646, and per head `4,770 − 54 = 4,716` and `77,538 − 34,090.72 = 43,447.29` — the credit really is `160.715 × 2 + 33,930`, so the paisa only closes after rounding. The CSV was captured by stubbing `URL.createObjectURL` and the anchor `click`, so the file itself was read rather than assumed; that capture is what exposed a half-paisa disagreement between `Math.round` and `Intl`, now routed through the same formatter the screen uses. Layout measured at 355px (every figure on its own line, zero clipped cells) and inside a same-origin 1440×900 iframe (`docDX 0`, 9-column HSN grid unclipped). No Postgres writes: the status dropdowns were never changed.  
**Commits:** `0a97632`.

### Session 25 — 2026-10-08 (R2-12, batch 6 — the GST tier closes)
**Built:** `/gst/reconciliation` and `/gst/einvoice` on the kit, which empties the GST tier — the last large block of pre-kit markup in the app. Ledger: 23 pages on the kit, 4 partial, 8 pre-kit (+3 auth). Reconciliation is now a `Column<Row>[]` model over four buckets, with one `ReconTable` feeding the screen and the CSV, five `StatCard`s, an alert that surfaces cess the portal offered and the books never claimed, and a `.rc-note-box` handing the user to `/gst/gstr3b`. `/gst/einvoice` reads the latest 300 documents in one batched query, derives `ready / fix / draft` buckets, and puts every NIC payload behind three modals — inspect (what fails and why, before you build), JSON viewer, e-way-bill form. `gstr2b.ts` lost its private duplicate CSV writer: both libraries now export *data*, and `csvFromRows` + `download` are the only writers in the app.  
**Resolved:** three compliance bugs in `einvoice.ts` found by reading, not by testing. **Place of supply `01` was being treated as an export** — only `99` is outside India, so a Jammu & Kashmir supply left the app with `Country: "OTHER COUNTRY"`, the six-digit pincode dropped, and `InvoiceType: EXP` where NIC wants `RGC`. **`ReverseCharge` was emitted inconsistently** — NIC requires it whenever the buyer is unregistered, and it should only appear on a registered-buyer invoice when the supply actually is on reverse charge; the old code guessed from the invoice type alone. **A bill of supply was labelled `INV`** — the `documentType` union had no `BIL`, and the validation guard was `!== 'INV' → require a reference invoice`, so a composition seller's bill of supply was rejected for missing an invoice it never had and could only exist as one. Traps #21–#23 record the first, second and third of these (the third being `StatCard`, whose numeric `value` runs through `formatCompactINR`, so a count passed as a number renders `₹12`). Also typed the whole portal-JSON boundary in `gstr2b.ts` (`PortalRow`, `jsonPath`, `asRows`) instead of `any`, and narrowed the e-invoice Supabase reads.  
**Method:** `tsc` 0, `eslint` 0 errors on the four touched files (3 accepted `exhaustive-deps` warnings naming `router`/`supabase`/the loader), `npm run build` 0 with both routes prerendered `○`, and 46/46 assertions in `/tmp/gst-b6-test.mjs` over the 2B parser, the four buckets, the totals, and the three e-invoice fixes — including the ones that pin J&K as domestic and `BIL` as standalone. A static class cross-check (every `className` token against the page's own `<style>` plus `globals.css`, and every scoped rule back against JSX) found no undefined class and no dead rule; the only bare tokens are the `page-container ef` / `rc` scoping hooks that `gh`, `r1`, `r3b`, `g9`, `bm` and `tds` already use. Reading the mobile CSS caught trap #4 before it shipped: `.table-frame` goes transparent under 768px, so `/gst/einvoice` cards its own rows with the `gstr1` recipe, while reconciliation needs none because each bucket is already inside a `Card`.  
**Outstanding — the next session must do this:** the *visual* pass never ran. The Supabase dev session expired mid-batch and the `(app)` layout bounces every GST route back to `/login`, so nothing was measured in a browser: upload a sample 2B CSV *and* JSON, exercise all four buckets plus the export, open the inspect / IRN JSON / e-way-bill modals, check the console, and measure both pages at ~355px and inside a same-origin 1440×900 `#probe` iframe asserting `scrollWidth − clientWidth === 0`. The login password is deliberately not recorded and `.env` must not be read, so this needs the user to sign in at `localhost:3000`. Fix forward from the commit below if the pass finds anything.  
**Commits:** `dd7d449`.

### Session 26 — 2026-10-08 (R2-13 GSTR-4 / CMP-08)
**Built:** the composition-scheme workpaper — `src/lib/gstr4.ts` (744 lines) + `/gst/gstr4` (628 lines), written *on* the kit rather than migrated onto it, which takes the ledger to 24 pages. Four tabs over one `Segmented`: overview (aggregate turnover, the slab test, eligibility verdict), CMP-08 (three quarters against deposits the owner declares), deemed debit (the 2.5% reversal in lieu of ITC), risks (the documents that end the scheme). Turnover is split by the HSN/SAC on each *line*, not by the rate on the invoice, because the slab follows the goods/service mix; the ₹1.5 crore / ₹50 lakh limits swap to ₹75L / ₹25L for the ten Notification 17/2020 states, and a service provider's goods leg is capped at 10% of turnover and ₹50 lakh. Nothing is filed and no rate is editable — portal-only gaps are labelled as portal-only. Also fixed the calendar, which generated GSTR-4 a year late and pointed CMP-08 at `/gst/gstr3b`; the GST hub went to four cards and `nav.ts` gained the entry, which the ⌘K palette picks up for free.  
**Resolved:** trap #24 — non-GST supplies were excluded from slab turnover in one place and counted in two others, so a quarter's taxable value, its implied percentage and the exempt figure disagreed with each other; the rule moved into `gstr4.ts` (`isNonGst`, `exemptTurnover`) and the page's duplicate local helper was deleted. Then four things the compiler and the linter caught on a fresh file: the typed Supabase client **parses** `.select()` strings, so a `credit_note_id as invoice_id` alias is a TS2352 at build time, not at runtime; `react-hooks/purity` rejects `Date.now()` during render, so "days until due" reads a `useState(() => new Date())` snapshot like `/tds` already does; `<Icon name="info">` does not exist (silent dashboard glyph — trap #16 again, on a page I had just written); and there is no `--slate` token, only `--slate-soft`. The duplicated localStorage writer in the page was replaced by the library's own `saveFy`.  
**Method:** the browser pass still could not run — the Supabase session is expired and the `(app)` layout bounces `/gst/gstr4` to `/login` — so verification was static and is recorded as such in the commit message: `tsc` 0, `eslint` 0 errors, `npm run build` 0 with the route present in both `prerender-manifest.json` and `routes-manifest.json`, 53/53 assertions in `/tmp/gstr4-test.mjs`, plus `/tmp/gst-b7-audit.cjs` cross-checking every `className` token, icon name and `var(--*)` against the kit for both GST pages. Six of those assertions failed first and **all six were my fixture maths, not the code** (a 0.6% slab written as 6%, a declared-gross variance legitimately moving CGST+SGST too, `assert.equal` on an object, a ragged CSV row, and a "special state" fixture that never actually crossed its ₹25 lakh slab) — which is the argument for writing the expected numbers by hand before running anything.  
**Commits:** `da672a2`.

### Session 27 — 2026-10-08 (GST 2.0 rate table + competitor scan)
**Built:** `src/lib/gst-rates.ts` — the one list every rate picker now imports (0 · 0.25 · 3 · 5 · 12 · 18 · 28 · 40). Eight pickers had each restated `[0,5,12,18,28]` inline, so after GST 2.0 (56th Council, effective 22 Sep 2025 — 12% and 28% removed, 40% demerit slab introduced) the app could not bill a demerit-rate item at all. The legacy rates stay in the list on purpose: a credit note against a pre-reform invoice has to repeat the original rate. Same rule check, three smaller things: the e-invoice page states the 30-day IRN window above ₹10 crore turnover and what missing it costs the buyer, the HSN register carries the GSTR-1 Table 12 digit rule, and the compliance calendar gained the 31 March CMP-02 opt-in for non-composition filers. Plus `7-Competitor-Comparison.md` — the source-grounded scan of TallyPrime, Zoho Books, Vyapar, myBillBook, Busy, Marg, ClearTax and Refrens (CaptainBiz and Swipez unreachable, excluded rather than guessed), with the ranked gap list that now feeds the next round.  
**Resolved:** trap #25. `bill-text.ts` deliberately keeps its own copy of the rate list — it *detects* the rate printed on a supplier bill within a 0.75-point tolerance, where 0.25% is indistinguishable from rounding noise on a no-tax row — and both files now say so, so the difference is a documented decision rather than the drift that caused this session.  
**Method:** `tsc` 0; `eslint` 0 on the two libraries and the new module, with the touched pages carrying only their pre-existing baseline (96 `no-explicit-any` across nine pre-kit files, none added); `npm run build` 0 with the route table unchanged; 22/22 assertions in `/tmp/gst-rates-test.mjs` over the rate set and the calendar for all three filing profiles (CMP-02 exactly once, due 2027-03-31, absent for a composition dealer, four CMP-08 quarters, no GSTR-1/3B under composition). The browser pass did not run — the Supabase dev session is still expired, same as sessions 25 and 26.  
**Commits:** `c663f78` (competitor doc), `5d92515` (the fix).

### Session 28 — 2026-10-08 (R2-12, batch 7 — counter and AI)
**Built:** `pos`, `inventory`, `ai/ask` and `ai/scan-bill` on the kit (`adb8f83`) — B7's four pages, all business logic preserved verbatim (the OCR pipeline and GST recalc effect in scan-bill, the vendor/product matchers, the `record_stock_movement` RPC in inventory, the cart and charge flow in POS). POS went from 64 hex literals in the old palette to 6, inventory from 124 to 4, AI pages 3 and 6 — every survivor is in the accepted §16 categories (readable text on a `--*-soft` fill, a border tint beside one). Ledger: **28 pages on the kit, 4 partial, 4 pre-kit** (+3 auth); the remaining shell pages are `reports`, `settings` and the two document pages.

**Found and fixed a kit gap:** `.tf-btn` had no `:disabled` styling anywhere — the old POS expressed it inline (`opacity: 0.5`), so migrating would have silently dropped the cue on every page that disables a button. One global rule in `globals.css` (`.tf-btn:disabled { opacity: .55; cursor: not-allowed; transform: none }`) covers every kit page. While there, §6's stale prop rows (`Button`, `PageHeader`, `EmptyState`, `ProgressBar`, `BarChart`/`StackedBar`) were corrected against the actual signatures.

**Method:** `tsc` 0; `eslint` on all four files identical to their per-file HEAD baselines (pos/inventory: same pre-existing anys, ref-during-render and unused-symbol entries; AI pages: 12 errors + 1 warning before and after — the `setState`-in-effect at the draft-recalc effect is verbatim original code); `npm run build` 0 with the route table unchanged. Browser pass still blocked by the expired Supabase dev session (since session 25).

**Commits:** `adb8f83`.

---

### Session 29 — 2026-10-08 (R2-12, batch 8 — reports and settings)
**Built:** `reports` and `settings` on the kit (`1d5b521`) — the last two non-document pages inside the shell, 484+/650−. Logic preserved verbatim: the four report builders with their exact aggregations (by customer/product/state, vendor ITC, GST output-vs-ITC, P&L derivation), the period switch, the CSV export; and in settings the `organizations(*)` load, logo upload/remove against the storage bucket, and the save round-trip with its saved-flag timeout. Both pages land at **absolute zero hex** — reports went 82 → 0, settings 54 → 0, the first pages in the pass with no strays at all.

**Method:** `tsc` 0; `eslint` current 33 problems vs HEAD baseline 36 — the delta is exactly the deliberate cleanups (the `(card as any).isPercent` cast died with the profit cards block, and the unused `start, end` destructure in the CSV export went; reports anys 25, settings anys 3). The pre-existing declaration-order error and the `img` warning are the verbatim originals. `npm run build` 45/45 with routes unchanged.

**Ledger:** **30 pages on the kit, 4 partial, 2 pre-kit** (+3 auth). Every tier except the two document pages is closed; the remaining order is auth first, then `invoices/new` and `invoices/[id]` last, because a printed document is a legal artefact. Browser pass still blocked by the expired Supabase dev session.

**Commits:** `1d5b521`.

---

### Session 30 — 2026-10-08 (R2-12, batch 9 — the auth trio)
**Built:** `login`, `signup` and `setup` on a new shared `src/components/AuthShell.tsx` (`d6e1a86`) — the first pages whose chrome is a component rather than a per-page recipe. The shell carries the brand mark, the card (400px; setup asks for 600) and the `.auth-*` form styling (fields, error box, completion mark); setup adds scoped `.su-*` styles for the wizard step dots — which now show a check instead of "1" once a step is done — and the GSTIN valid/error hints. All logic verbatim: the sign-in/sign-up calls, the org insert + `org_members` owner row, the GSTIN check with state auto-detect, and the skip path. The trio and the shell all land at **absolute zero hex** (18, 25 and 38 literals in the old pages → 0).

**Kit change:** the logo gradient lived as an inline literal in the sidebar's `BrandMark`; it is now `--brand-grad` in `:root` and both the sidebar and every auth mark read it — one definition, and the only hex left in that area.

**Method:** `tsc` 0; `eslint` 3 problems across the three pages vs HEAD baseline 7, and the delta of four is all explainable: the unused `useRouter` in signup went, two unescaped-apostrophe errors were fixed with `&apos;` following the `accounting`/`tds` convention, and "Let's set up your business" is no longer a JSX text node but a `subtitle` attribute. What remains is verbatim: the two pre-existing `catch (err: any)` entries and the `exhaustive-deps` warning, all on setup. `npm run build` 45/45.

**Ledger:** **33 pages on the kit** (30 in the shell + the 3 auth pages), 4 partial, 2 pre-kit. Only `invoices/new` and `invoices/[id]` remain, deliberately last. Browser pass still blocked by the expired Supabase dev session.

**Commits:** `d6e1a86`.

---

### Session 31 — 2026-10-08 (R2-12, batch 10 — the documents, and the pass closes)
**Built:** `invoices/new` and `invoices/[id]` onto the kit (`b933bea`) — the last two pre-kit pages, migrated chrome-only, which is the whole design of this batch. Everything a person touches before the paper moved: action bar, buttons, alerts, fields, the line-item editor, the summary; everything that *is* the paper stayed byte for byte: the classic `#invoice-document` layout, the `#invoice-capture` wrapper with its 24px baked-in print margin, the `@media print` stylesheet and the jsPDF slice pipeline. A printed document is a legal artefact — a styling change to it is a change to the artefact. `invoices/new` went 58 hex literals to 0 (PageHeader, Cards, `.ni-field`/`tf-input` fields, the `.ni-note is-local/is-inter` GST indicator via color-mix, the `line-items-head`/`line-item-row` mobile recipe kept, summary as `.ni-tot-*`); `invoices/[id]` has zero hex in its chrome — buttons are kit `Button`s (ghost/primary/danger with `check`/`download`/`printer`/`x` icons), the bar and cancelled banner run on tokens, and the `✓` `⬇` `🖨️` `⏳` `⚠️` glyphs are gone.

**Also:** the shell's one remaining chrome emoji followed — the offline strip's `📶` became the kit `alert` icon (`a9c9e45`).

**Method:** `tsc` 0; `eslint` parity on both pages (10 and 9 problems, identical rule sets vs HEAD — the anys, the set-state-in-effect error and the document `<img>` warning are the verbatim originals); hex audit: `invoices/new` 0, `invoices/[id]` 63 with every literal inside the document/PDF/print zones; `npm run build` 45/45, routes unchanged. The B10 commit message was amended once to correct its own hex arithmetic (58/84 → 0/63) before it ever left the machine.

**Ledger:** **32 pages on the kit, 4 partial, 0 pre-kit** (+3 auth). R2-12 is complete — ten batches, closed with the documents as planned. Browser pass still blocked by the expired Supabase dev session.

**Commits:** `b933bea`, `a9c9e45`.

### Session 32 — 2026-10-08 (R2-14 B1 — delivery challans + order-flow engine)
**Built:** `src/lib/orderflow.ts` (`f982aed`) — one localStorage document engine for three kinds (`challan`, `sales_order`, `purchase_order`), one store per kind per org (`taxflow:challan|sorder|porder:<orgId>`, ADR-013: no new tables). Numbering is high-water per `kind:fy` — `peekNumber` previews for the editor without allocating, `takeNumber` never reuses a number after a delete and recovers the watermark from the documents themselves. Totals run through the GST engine per line; `ADVANCE` walks draft → active → closed with kind-appropriate labels (challan: "Mark dispatched" / "Mark delivered"). `/challans` is the register + create/edit editor: party select fills GSTIN, place of supply and supply type; the reason field carries the Rule 55(4) six-month note; products fill HSN, unit, rate, GST and cess. `/challans/[id]` is the printable document — entirely token-drawn (0 hex; `var(--faint)` rules, `var(--brand-soft)` fills), "not a tax invoice" stated on the sheet, and printable at A4 with 15mm margins. Conversion to invoice runs through `createInvoice`: the real INV number is allocated, a `customers` row is created on the fly when the party was free-typed (`invoices.customer_id` never null), and the challan is marked `converted` with `converted_to_id` / `converted_to_number`. `pdf-export.ts` extracted from `invoices/[id]` so both documents share the slice pipeline; new `truck`/`edit` icons; `Delivery Challans` in the Sales nav.

**Traps recorded:**
- `challans/[id]` uses `useParams()`, not the `window.location.pathname`-splitting effect `invoices/[id]` carries. The old pattern trips the React-compiler "setState synchronously within an effect" lint error; the new page has no such debt and `invoices/[id]` keeps its legacy pattern untouched.
- The `?edit=<id>` deep link is handled *inside* the async load effect, not a second effect — a second effect calling `openEditor` declared below it trips "Cannot access variable before it is declared".
- `buildInvoicePayload` resolves state codes to names via `stateNameFor()` — matching what `invoices/new` sends. Without it the converted invoice would print a bare state code where the document layout expects a name.
- The full invoice payload must never carry `invoice_number` — `createInvoice` allocates and stamps it.
- Line-item grids on new pages use the global `.line-item-row` recipe; the mobile stacking rules in `globals.css` carry `!important`, so page-scoped grid styles cannot break the ≤768px layout.

**Method:** 89 assertions in `/tmp/orderflow-test.mjs` (numbering, store tolerance, totals, validation, status table, conversion payload, helpers); `tsc` 0; eslint zero on every new file except `challans/[id]`'s 3 problems — the deliberate same-shape parity with the `invoices/[id]` accepted baseline — and `invoices/[id]` verified back at baseline parity after its PDF refactor; `npm run build` 46/46 with `○ /challans` and `ƒ /challans/[id]` in the route table.

**Ledger:** **34 pages on the kit, 4 partial, 0 pre-kit** (+3 auth). R2-14 B1 closes the delivery-challan half of competitor gap #2; B2 (sales + purchase orders on the same engine) is next. Browser pass still blocked by the expired Supabase dev session.

**Commit:** `f982aed`.

### Session 33 — 2026-10-08 (R2-14 B2 — sales orders + purchase orders)
**Built:** the engine's other two kinds mounted (`b851818`) — one shared register (`OrderRegister.tsx`) and one shared printable document (`OrderDocument.tsx`) behind four thin route wrappers (`/sales-orders`, `/purchase-orders`, each with an `[id]` document), rather than refactoring the just-shipped challans pages: challans stays the sibling implementation and the two new kinds share their own pair. Every per-kind string — eyebrow, party label (Customer / Vendor), status labels, stats, empty states, footer — lives in one `COPY: Record<OrderKind, KindCopy>` table instead of being branched at each use site. Statuses: SO confirm → close ("Confirm order" / "Mark fulfilled"), PO place → receive ("Mark placed" / "Mark received"). Party master switches `customers` ↔ `vendors`; a product line on a PO prices from `purchase_price ?? selling_price`, on an SO from `selling_price`. Conversions ride the real write paths: SO → invoice through `createInvoice` (lazy `customers` row when the party was free-typed), PO → bill through `createPurchaseBill`. Because a purchase bill's number is the **vendor's own** — it is what GSTR-2B matches against — the PO conversion does not invent one: it opens a small modal asking "Vendor bill no. + bill date", and `buildBillPayload` (new, in `orderflow.ts`) refuses a blank number and flags `itc_eligible` on the bill and every item. New `bag` / `clipboard-check` icons; both new nav entries (`Sales Orders` in Sales, `Purchase Orders` first in Purchases). All four pages written on the kit; both printable documents token-drawn (0 hex), same anatomy as the challan with SO/PO signature blocks and "not a tax invoice".

**Traps recorded:**
- A purchase bill's number is the vendor's own, not ours to allocate — the PO cannot become a bill without it. Any auto-generated "bill number" would contradict GSTR-2B matching. The conversion asks, and the library throws if unasked.
- The shared-component pattern for two near-identical kinds: keep one `COPY` table keyed by kind; the dead-ternary smell (`kind === 'x' ? 'orders' : 'orders'`) shows up when copy is branched per use site instead — both instances were removed before commit.
- Modal convention holds: the bill-number modal does **not** close on scrim click — a typed vendor bill number must not vanish on a stray tap (same rule as every editor modal).

**Method:** 22 new assertions in `/tmp/orderflow-test.mjs` (111 total — vendor fields, POS name resolution, ITC flags, both throw paths, `is_reverse_charge: false`, `status: 'active'`, trimmed bill number); `tsc` 0; eslint clean on every new file except the single accepted `no-img-element` warning on `OrderDocument.tsx` (same baseline as the other document pages); `npm run build` 48/48 static with all four routes in the table (`○ /sales-orders`, `ƒ /sales-orders/[id]`, `○ /purchase-orders`, `ƒ /purchase-orders/[id]`).

**Ledger:** **38 pages on the kit, 4 partial, 0 pre-kit** (+3 auth). R2-14 B2 closes competitor gap #2 entirely — challans, orders and both conversion paths; B3 (registers/palette integration for the round) is the remainder. Browser pass still blocked by the expired Supabase dev session.

**Commit:** `b851818`.

### Session 34 — 2026-10-08 (R2-14 B3 — order flow in the registers + palette)
**Built:** the order book joined both discovery surfaces (`94b3c1c`). `/reports/registers` gained a sixth tab, **Order flow** — `orderFlowRows` (new in `registers.ts`) maps every non-cancelled document from `loadAllDocs(orgId)` (new in `orderflow.ts`: the three stores merged through `sortDocs`) into one row shape: number, kind label, party + GSTIN, status label, converted-to number, value and the document's own href. The tab reuses the whole register machinery unchanged — period presets and the filter box apply locally (the docs are localStorage), column sort and CSV run through the same `Col` list, the foot carries a Register total on value, and mobile cards label themselves from `data-label`. The ⌘K palette now searches the three local stores **synchronously** — `orderRecordCommands(orgId, query)` returns plain record commands under Challans / Sales orders / Purchase orders groups with no round-trip, no debounce and no loader row — which forced the entity split in `commands.ts`: `RecordEntity` (the eight Supabase-backed kinds; the async loop and its pending set stay on `SUPABASE_RECORD_ORDER`) vs `OrderEntity` (the three locals), with `EntityKind = RecordEntity | OrderEntity` for display grouping only. Three palette actions ("New challan / New sales order / New purchase order") deep-link `?new=1`, and both editors learned that param with state set inline inside the async load; `isKnownHref` gained the three `/<entity>/` detail prefixes so a palette-opened order survives the recents replay.

**Fixed in passing:** the ranker could not match a hyphenated query typed as one token — `INV-2024-001` scored zero while `INV 2024` matched, because `queryTokens` stripped separators from the query but compared them against the raw label. It now splits on every non-alphanumeric, so each word must still hit a field (`INV-2024-001`, `DC-2026-27`, `SO-0001` all match) while GSTIN fragments like `27aabcv` are unchanged.

**Traps recorded:**
- `orderRecordCommands` is a **candidate generator**, not a filtered result set — it mirrors the Supabase pre-fetch contract (server filters candidates, `rankCommands` decides) and leaves query filtering to the ranker, because phrase-matching would break token queries like `dc 0002` against `DC-2026-27-0002` (hyphens are not spaces). The first test draft asserted filtered semantics and failed; the contract is now tested as it is.
- The palette's async effect and its pending set must both switch on `SUPABASE_RECORD_ORDER` — pointing them at `RECORD_ORDER` would leave the spinner waiting on three entities that never resolve a fetch.
- `?new=1` handling goes inside the load effect with inlined `setModalDoc(...)` sets; calling `openCreate()` from there trips the repo's React-compiler lint ("Cannot access variable before it is declared").
- `orFilter` was narrowed to `RecordEntity` — it indexes `ENTITY_SPECS`, which has no order entries; widening at the palette call site is what the split exists to prevent.

**Method:** the two `/tmp` suites wiped by the OS were recreated — `/tmp/commands-test.mjs` (34 assertions: entity-registry order, `isKnownHref` prefixes, the candidate contract, party / GSTIN / converted-to / amount search through the ranker, recents round-trip via `pushRecent` + `loadRecents`) and `/tmp/registers-test.mjs` (21 assertions: `loadAllDocs` merge, ordering and the SSR guard, cancellation, label maps, href building, value = `docValue`). `orderflow-test` 111 and `gst-rates` 22 still green. `tsc` 0; eslint clean on every touched core file — `registers/page.tsx` (52 `no-explicit-any`) and `CommandPalette.tsx` (3 `set-state-in-effect`) carry only pre-existing findings, checked against HEAD. `npm run build` clean, 48/48 static.

**Ledger:** R2-14 is **complete** — B1 `f982aed`, B2 `b851818`, B3 `94b3c1c` — competitor gap #2 closed end-to-end, and the order book is now as searchable as the statutory registers. Browser pass still blocked by the expired Supabase dev session.

**Commit:** `94b3c1c`.

### Session 35 — 2026-10-08 (R2-15 B1 — batch & expiry register, FEFO consumption)
**Built:** `src/lib/batches.ts` (`9b7a4c6`) — the first half of competitor gap #3, and the schema decision that gated the round resolved in favour of ADR-013: a batch is owner bookkeeping (the statutory paper — invoice, e-way bill — never carries the lot), so lots live in `taxflow:batches:<orgId>` and their movements in `taxflow:batchmoves:<orgId>`, no new tables. A movement is signed — a sale leaves negative, a return comes back positive — and every view (In / Out / Left / Value) is derived from the two stores, never stored. Expiry runs against the whole day printed on the pack: `daysLeft` 0 is "Expires today" (critical), not already-expired; tiers are expired / ≤30 (`EXPIRY_CRITICAL_DAYS`) / ≤90 (`EXPIRY_SOON_DAYS`) / ok / no-expiry, with the day difference taken at UTC noon so no client timezone can shift a lot across midnight. FEFO draws expired lots first by design — the register records what physically happened and the page warns (red badge, expired-take lines in the allocator preview) rather than blocking a dispatch that is already on the road; dated lots queue ahead of undated ones by receipt age; **each receipt is its own lot** — the same batch number delivered twice is two rows, never merged, because the register's job is to answer "which receipt is left". `allocateFefo` is the preview; `recordSale` appends the real moves and is quiet by design — it returns `null` when nothing is drawable and never throws, and it draws against a running working list so two lines of the same product in one invoice cannot double-draw a lot. Validation keeps the counts honest: the received quantity cannot be edited below what has left the lot (`out − back`).

**Wired:** `/inventory/batches` on the kit (0 hex) — six views (On the shelf default / expired / ≤ 30 days / 31–90 days / Sold out / all), four stat cards (lots on the shelf, stock value, expiring in 30 days, expired), per-row expiry badge with days text, and three modals: the editor (live expiry hint as you type the dates), the **FEFO allocator** (pick preview with cover/shortfall and expired-take warnings before anything is written), and adjust (Leaves / Returns). CSV export of the visible rows. The real consumption hook is one call in `create-invoice.ts` after the stock-movement loop — so the invoice form, the POS counter and offline replay all draw lots down FEFO through the single write path without knowing the register exists. Nav entry under Masters ("Batches & Expiry"); a ⌘K "Add batch" action deep-links `?new=1`.

**Traps recorded:**
- One receipt is one lot. Merging two deliveries of the same batch number would destroy the answer to "which receipt is left" — the exact question expiry-first rotation exists to answer.
- The last day printed on the pack is a usable day. `daysLeft 0` reads "Expires today" and only a negative figure says expired; the difference runs at UTC noon so no timezone can flip a lot across midnight.
- Expired lots are drawn, not skipped. Blocking would make the register contradict the physical world it records; the allocator preview names the expired take and the badge carries the warning. The register records, the human decides.
- `recordSale` must never throw — a broken store returns `null` and the invoice save must not depend on the register. The running move list (not the store) is what a second line of the same product reads, or one invoice would double-draw its first lot.
- The edit floor is `out − back`. The message owns the arithmetic — "8 units have left this lot (3 returned) — the received count cannot go below 5" — because a returns-aware floor is not a number a shopkeeper should have to reconstruct from the register.

**Method:** 77 assertions in `/tmp/batches-test.mjs` (day-boundary table including 0/±30/90/91, storage tolerance + SSR guard, FEFO ordering, allocateFefo expired-first / shortfall / no-op, recordSale cross-lot and two-line drawdown and every null case, the returns-aware floor, summary buckets, CSV shape); `orderflow-test` 111, `commands-test` 34 and `gst-rates` 22 still green; `tsc` 0; eslint clean on every new file — `create-invoice.ts` keeps only its 2 pre-existing findings, re-proven against HEAD via `git show HEAD:… | npx eslint --stdin`; `npm run build` 49/49 with `○ /inventory/batches` in the route table.

**Ledger:** **39 pages on the kit, 4 partial, 0 pre-kit** (+3 auth). R2-15 B1 opens competitor gap #3 — batch/expiry done; serials (same localStorage pattern) and multi-godown (needs real columns → the Phase 14 schema window) remain. Browser pass still blocked by the expired Supabase dev session.

**Commit:** `9b7a4c6`.

### Routes — 47 pages
```
src/app/
├── layout.tsx, page.tsx (→ /login), manifest.ts, globals.css, favicon.ico
├── login/  signup/  setup/
├── api/gsp/ewaybill/route.ts        ← mock GSP transport
├── api/pdf-worker/route.ts          ← version-locked pdf.js worker asset
└── (app)/                           ← shell: layout.tsx + nav.ts data
    ├── dashboard/                   pos/            offline/
    ├── invoices/{page,new,[id]}/    quotations/     customers/  vendors/  products/
    ├── challans/{page,[id]}/        ← delivery challan register + printable document
    ├── sales-orders/{page,[id]}/    purchase-orders/{page,[id]}/  ← order register + document (R2-14 B2)
    ├── bills/  expenses/  credit-notes/  debit-notes/
    ├── payments/page  payments/links/  bank/
    ├── inventory/{page,reorder,batches}/  ← reorder planner + batch/expiry register (R2-15 B1)
    ├── ledger/  accounting/
    ├── tds/                         ← withholding workpaper
    ├── gst/{page,gstr1,gstr3b,gstr9,gstr4,reconciliation,einvoice,calendar}/
    ├── reports/{page,registers,targets}/
    ├── ai/{ask,scan-bill}/
    └── settings/
public/sw.js  public/offline.html
```

### Libraries — 33 modules in `src/lib/` + `src/lib/gsp/`
```
supabase.ts  constants.ts  gst-engine.ts  format.ts  words.ts  reports.ts
gst-rates.ts                                 ← the one GST rate table every picker imports
create-invoice.ts  create-bill.ts            ← the only document write paths
einvoice.ts  gstr2b.ts  gstr9.ts  compliance.ts  registers.ts  payments.ts
ledger.ts  party-ledger.ts  targets.ts  reorder.ts  barcode.ts  outbox.ts
bill-text.ts  ocr.ts  ask.ts  commands.ts  nav.ts  deep-link-search.ts
bank-statement.ts                             ← statement parser + match scorer
tds.ts                                        ← withholding sections, workpaper, deposits
gstr4.ts                                      ← composition slabs, CMP-08 quarters, deemed debit
orderflow.ts                                  ← challans / sales orders / purchase orders (localStorage)
batches.ts                                    ← lots, FEFO drawdown, expiry watch (localStorage)
pdf-export.ts                                 ← shared html2canvas → jsPDF slice pipeline
gsp/{index.ts, types.ts, mock.ts}            ← provider adapter, mock transport
```
(`gst-engine.ts` also still exports the legacy `numberToWords()` that the classic
print layout uses. `words.ts` is the newer implementation. They intentionally
coexist — do not "unify" them and change a printed invoice silently.)

### Components — 8 in `src/components/`
```
ui.tsx               ← Card, SectionTitle, StatCard, DeltaPill, Badge, Tone tokens
Icons.tsx            ← stroke glyph set, key lookup with dashboard fallback
InvoiceDocument.tsx  ← classic / modern / minimal skins
CommandPalette.tsx   ← ⌘K
BarcodeScanner.tsx   ← getUserMedia + BarcodeDetector, graceful degrade
PwaRegister.tsx      ← service-worker registration
OrderRegister.tsx    ← shared register + editor for sales/purchase orders (kind-keyed COPY table)
OrderDocument.tsx    ← shared printable order document, SO/PO branches inside
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
| `taxflow:gstr4:` | declared CMP-08 deposits and stock-transfer value for the year | `/gst/gstr4` |
| `taxflow:challan:` · `taxflow:sorder:` · `taxflow:porder:` | order-flow documents + numbering per kind (`challan` / `sales_order` / `purchase_order`) | `/challans`, `/sales-orders`, `/purchase-orders` |
| `taxflow:batches:` · `taxflow:batchmoves:` | batch lots and their signed movements (FEFO drawdown) | `/inventory/batches`, `create-invoice.ts` |
| `taxflow:palette-recents:` | recent ⌘K hits | `CommandPalette.tsx` |

---

## Traps That Cost Debugging Time

Recorded so the next session does not rediscover them.

1. **CSS specificity across breakpoints** — a desktop `.cols > .is-right` rule outranks the mobile `.cols > span` rule; override with equal or higher specificity, not with `!important`.
2. **Rupee strings have no break opportunity** — one figure per line on mobile, and assert `scrollWidth − clientWidth === 0` rather than eyeballing.
3. **`node --experimental-strip-types --loader /tmp/ts-loader.mjs`** registers the ESM hook; `--import` does not, and the test file then fails to parse TypeScript.
4. **Library test suites live in `/tmp`** and are not committed. Recorded counts at R2-11: gstr2b + compliance 30, registers 20, words 29, targets 38, commands 26, gstr9 35, tds 70; batch 6 added 46 over the 2B reconciliation and e-invoice builders, R2-13 another 53 over `gstr4.ts` — rewrite them when a library changes. `/tmp` gets wiped mid-project (it happened once here, taking the loader with it), so `ts-loader.mjs` may need recreating before a suite can run at all; it was rebuilt on 2026-10-08, when `/tmp/gst-rates-test.mjs` added 22 assertions over the rate table and the calendar.
5. **`1-based` vs `0-based` months** — `iso(y, m, d)` vs `fyMonth()`; off-by-one shifts a whole quarter.
6. **`Math.abs()` on a signed document** — turns a credit note into extra sales.
7. **Unbounded `in=(...)`** — Supabase 400s; chunk at 500 ids.
8. **BOM duplication** — `party-ledger.download()` already prefixes `\uFEFF`; combining it with `csvFromRows` produced a doubled marker. Ragged rows go through `csvFromRows`.
9. **`useSearchParams` on a prerendered page** — needs the `XPageInner` + `<Suspense>` split or the build fails.
10. **Duplicate listbox ids** — the palette must namespace option ids per group and per query.
11. **`?q=` column parity** — a deep link must filter on exactly the columns the list page reads, or a search hit lands on an empty list.
12. **Supabase reads are `as any[]`** with explicit `.select()` lists — the repo's accepted baseline until types are generated; compare `npx eslint` output against the pre-existing count instead of expecting zero.
13. **A `<button>` with no `type` inside a form submits it** — the kit's `Segmented` did exactly that in the product modal, so switching goods→service saved the product. Any control that can live inside a `<form>` renders `type="button"`.
14. **`evaluate_script` can read the DOM a render behind a click** — a status cell read right after `.click()` showed the old value twice during R2-12. Re-query in a later call, or read the derived stats as well as the row.
15. **A styling migration is a code review** — rewriting `/payments` surfaced a `.limit(20)` history window and a `getMonth()`-only "this month" card that counted the same month every year. Read the logic while replacing the chrome; fix what you find instead of preserving it.
16. **`<Icon>` swallows an unknown name** — `Icons.tsx` ends with `{P[name] ?? P.dashboard}`, so a typo or a name that was never added renders the *dashboard* grid, not an error and not a blank box. `/offline`'s "Syncing…" button was quietly doing this. Grep the name against the map when adding an icon.
17. **`Intl` currency output already carries the symbol** — `new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })` returns `₹1,20,000`, so a hand-written `₹` prefix in the same line renders `₹₹1,20,000`. Prefix only the minus sign.
18. **A totals row inherits its header's label** — on the mobile card layout every cell renders `attr(data-label)`, so a foot row built the same way reads `Invoice no. — Total · 5 invoices` above the amounts. The lead foot cell needs an empty `data-label` (or `.is-lead::before { content: none }`) and the blank filler cells need `display: none`.
19. **`Math.round` and `Intl` disagree on an exact half-paisa** — `34090.715` renders `34,090.72` through `Intl` but `34090.71` via `Math.round(v * 100) / 100`, because the double is really `…7149999`. Any derived figure you split in two (`expense GST ÷ 2` per head) has to leave the app through the **same formatter the screen uses**, or the CSV contradicts the page the CA is reading.
20. **A rebuilt screen is a test of the old one** — the R2-12 GST pass found more arithmetic bugs than styling ones (IGST counted in two sections, the whole credit printed as "ITC utilised", nil-rated supplies hard-coded to zero, `financial_year` from today, due dates in the wrong month). Wherever the new markup forces two figures to add up, check that they do before trusting either.
21. **Place of supply `01` is Jammu & Kashmir, not an export** — only `99` ("Other Countries") is outside India. `einvoice.ts` was treating `01` as foreign, so a J&K supply built as `Country: "OTHER COUNTRY"` with the six-digit pincode dropped and `InvoiceType: EXP` instead of `RGC`. Any POS comparison in this codebase is `=== '99'` and nothing else.
22. **A document-type union that only knows INV/CRN/DBN mislabels a bill of supply** — a composition-registered seller (`RR`/`RSRG`) issues a *bill of supply*, which NIC carries as `BIL`. Worse: the validation guard was `documentType !== 'INV' → require a reference invoice/number/date`, so a bill of supply was rejected for missing a document it never had. Only **notes** (CRN/DBN) point back at an invoice; `BIL` is a standalone document.
23. **`StatCard` renders a numeric `value` through `formatCompactINR`** — so a count passed as a number prints `₹12`, not `12`. Pass every non-money value as a string (`` value={`${ready.length}` ``) and leave the prop numeric only for rupee figures.
24. **A rule applied in one caller but not in the function that owns it** — GSTR-4 excluded non-GST supplies from slab turnover while `quarterlyLiability` and the liability sum still counted them, so the same quarter read ₹1,40,000 on one card and ₹1,70,000 on another, and the page's own local "exempt" helper quietly re-added them. The page had a *second* implementation of the rule. Filter inside the function that owns it (`isNonGst` in `gstr4.ts`), export the derived figure (`exemptTurnover`), and never let a page recompute what the library already knows.
25. **A legal rate is a domain rule and cannot live in eight places** — GST 2.0 removed the 12% and 28% slabs and introduced 40% (22 Sep 2025), and eight pickers still offered `[0,5,12,18,28]`, so the app could not bill a demerit-rate item at all. Legal lists belong in one module (`src/lib/gst-rates.ts`) and callers import them. The one deliberate exception is `bill-text.ts`: it *detects* a rate printed on a supplier bill inside a 0.75-point tolerance, where 0.25% cannot be told apart from rounding noise on a no-tax row, so its list omits 0.25% and says why. Different jobs, documented — not drift.

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

1. **R2-15 — gap #3, batch/expiry + serial tracking, multi-godown — is open, with the batch/expiry half shipped.** B1 (`9b7a4c6`) added the batch & expiry register with FEFO consumption wired into `create-invoice.ts`; the schema decision closed on ADR-013 — a batch is owner bookkeeping, the statutory paper never carries the lot, so no tables were needed for this half. What remains of the gap: **serials** (same localStorage pattern — likely R2-15 B2), and **multi-godown**, which does need real columns and therefore waits for the Phase 14 schema window instead of being faked. Then gaps #4–#12 by rank. R2-14 is complete (B1 `f982aed`, B2 `b851818`, B3 `94b3c1c` — gap #2 closed end-to-end), and R2-12's design-system pass is complete — 4 lists (`bills`, `credit-notes`, `debit-notes`, `quotations`) still hand-code their chrome and get migrated when next touched.
2. **The unfinished browser pass** — GST batch 6 (`dd7d449`) and `gst/gstr4` (`da672a2`) were verified statically only; the Supabase dev session is expired, so nothing was measured at 355px or 1440px. Needs the user to sign in at `localhost:3000`.
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
8. **GST rates come from the database**, never hard-coded, and a rate change must not touch historical invoices. The only static list is the picker in `src/lib/gst-rates.ts` — add a rate there when a notification changes one, and check `bill-text.ts`'s detection list at the same time.
9. **Profit figures are indicative**, not a certified P&L.
10. **New pages must be in `nav.ts`** or they do not exist for the user or ⌘K.
11. **Test GSTIN** — `27AABCU9603R1ZX` (valid format, not a real registration).
12. **Verify in the browser before committing**, at phone width and 1440px, with zero horizontal overflow.
