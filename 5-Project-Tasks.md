# TaxFlow India — Project Tasks

**Version:** 2.0  
**Date:** October 2026  
**Last Updated:** 2026-10-07  

Phases 0–12 are the original MVP build. Version 1 and the Round 1 / Round 2
competitive features are recorded further down — read those sections for what
exists now, and the Backlog for what comes next.

---

## How to use this document

- ✅ = Completed and tested
- 🔄 = In progress
- ⏳ = Planned, not started
- ❌ = Blocked or cancelled

Update this file after completing each task.

---

## PHASE 0 — Blueprint ✅

- ✅ Define product vision and target customers
- ✅ Define MVP vs Version 1 vs Version 2
- ✅ Choose technology stack (Next.js + Supabase + Vercel)
- ✅ Design database architecture
- ✅ Plan development phases
- ✅ Create 6 project documents

---

## PHASE 1 — Project Skeleton ✅

- ✅ Install Homebrew on Mac
- ✅ Install Node.js 20+ (dev machine now runs v24)
- ✅ Install Git
- ✅ Install the code editor (Cursor, now Qoder)
- ✅ Create GitHub account
- ✅ Create Supabase account and project
- ✅ Create Next.js app (taxflow-india)
- ✅ Install Supabase libraries
- ✅ Create .env.local with credentials
- ✅ Create login page
- ✅ Create signup page
- ✅ Create dashboard shell
- ✅ Test auth flow (signup → confirm → login → logout)
- ✅ Deploy to Vercel
- ✅ Test live at taxflow-india.vercel.app

---

## PHASE 2 — Business Setup ✅

### Database
- ✅ Create profiles table
- ✅ Create organizations table
- ✅ Create org_members table
- ✅ Create gst_registrations table
- ✅ Enable Row Level Security (RLS)
- ✅ Fix RLS recursion issue (disabled for now)
- ✅ Add auto-create profile trigger on signup

### Business Setup Wizard
- ✅ Step 1 — Company details form
- ✅ Step 2 — GST registration form
- ✅ GSTIN format validation
- ✅ Auto-detect state from GSTIN
- ✅ Save organization to database
- ✅ Save GST registration to database
- ✅ Redirect new users to /setup automatically
- ✅ Dashboard shows company name + GSTIN

---

## PHASE 3 — Masters ✅

### Database
- ✅ Create customers table
- ✅ Create vendors table
- ✅ Create products table

### Constants
- ✅ All 37 Indian states with GST state codes
- ✅ Business types list
- ✅ GST registration types list
- ✅ validateGSTIN() function
- ✅ getStateFromGSTIN() function

### Customers
- ✅ Customer list page
- ✅ Add customer form (modal)
- ✅ Edit customer
- ✅ GSTIN validation on form
- ✅ State dropdown
- ✅ Search by name, GSTIN, phone, email
- ✅ Customer type badge (B2B, B2C, Export, SEZ)
- ✅ Active/inactive status

### Vendors
- ✅ Vendor list page
- ✅ Add vendor form (modal)
- ✅ Edit vendor
- ✅ Search functionality

### Products
- ✅ Product list page
- ✅ Add product form (modal)
- ✅ Edit product
- ✅ Goods vs Service toggle
- ✅ HSN/SAC field
- ✅ GST rate selector (0, 5, 12, 18, 28%)
- ✅ Inventory tracking toggle
- ✅ Opening stock and minimum stock
- ✅ Filter by type (goods/services)

### Navigation
- ✅ Sidebar with all sections
- ✅ Active page highlighting
- ✅ Organization name and GSTIN in sidebar

---

## PHASE 4 — Invoicing ✅

### Database
- ✅ Create invoices table
- ✅ Create invoice_items table
- ✅ Create invoice_sequences table

### GST Engine
- ✅ determineGSTType() — same state vs interstate
- ✅ calculateLineItem() — per line tax calculation
- ✅ calculateInvoiceTotals() — invoice summary
- ✅ getFinancialYear() — India FY (April-March)
- ✅ formatINR() — Indian number format
- ✅ numberToWords() — amount in words (crores, lakhs)
- ✅ round2() — 2 decimal rounding

### Invoice Creation
- ✅ Invoice number auto-generation (INV-2026-27-0001)
- ✅ Seller details from org profile
- ✅ Customer selection with auto-fill (GSTIN, state)
- ✅ Place of supply with auto-detect
- ✅ Supply type (B2B, B2C, Export, SEZ)
- ✅ GST type indicator (CGST+SGST vs IGST)
- ✅ Reverse charge flag
- ✅ Line items with product selector
- ✅ Live GST calculation as user types
- ✅ Tax breakdown under each line item
- ✅ Discount per line item
- ✅ Invoice summary (right panel)
- ✅ Amount in words
- ✅ Notes and terms
- ✅ Save as draft
- ✅ Save as sent
- ✅ Stock auto-reduces on invoice save

### Invoice List
- ✅ List all invoices
- ✅ Invoice number, customer, date, amount, status
- ✅ Payment status badge
- ✅ Click to open detail

### Invoice Detail
- ✅ Full invoice view (print-ready)
- ✅ TAX INVOICE header
- ✅ Seller and buyer details
- ✅ Line items table with CGST/SGST/IGST columns
- ✅ Totals section
- ✅ Amount in words
- ✅ Notes and terms
- ✅ Authorised signatory section
- ✅ Mark as Paid button (sent invoices only)
- ✅ Cancel invoice
- ✅ Print / PDF button
- ✅ Print styles (hides navigation)

---

## PHASE 5 — Purchases ✅

### Database
- ✅ Create purchase_bills table
- ✅ Create purchase_bill_items table
- ✅ Create expenses table

### Purchase Bills
- ✅ Bill list with ITC summary cards
- ✅ Add bill form (modal)
- ✅ Vendor selection with auto-fill
- ✅ GST calculation (same engine as invoices)
- ✅ ITC eligible toggle
- ✅ ITC amount shown in list
- ✅ Mark bill as paid
- ✅ Stock auto-increases on bill save

### Expenses
- ✅ Expense list with summary cards
- ✅ Add expense form
- ✅ 16 expense categories
- ✅ GST calculation (tax-inclusive — backs out GST from total)
- ✅ ITC eligible flag
- ✅ Payment mode selection
- ✅ Vendor linking (optional)

---

## PHASE 6 — Payments ✅

### Database
- ✅ Create payments table

### Payments Page
- ✅ Summary cards (receivable, payable, overdue, this month)
- ✅ Receivables tab with ageing
- ✅ Payables tab with ageing
- ✅ Ageing buckets (current, 30d, 60d, 90d+)
- ✅ Record payment modal
- ✅ Full payment recording
- ✅ Partial payment recording
- ✅ Payment mode and reference number
- ✅ Invoice/bill updates to paid/partial automatically
- ✅ Paid invoices removed from receivables list
- ✅ Recent payments section
- ✅ Payments added to sidebar

---

## PHASE 7 — Inventory ✅

### Database
- ✅ Create stock_movements table
- ✅ Create warehouses table
- ✅ Add last_stock_update to products
- ✅ Create record_stock_movement() database function

### Inventory Page
- ✅ Summary cards (tracked products, stock value, low stock, out of stock)
- ✅ Stock levels tab
- ✅ Low stock filter
- ✅ Out of stock filter
- ✅ Search products
- ✅ Stock level per product with color coding
- ✅ Manual add stock
- ✅ Manual remove stock
- ✅ Stock preview before confirming
- ✅ Minimum stock alert
- ✅ Stock movements tab
- ✅ Filter movements by product
- ✅ Movement type badges
- ✅ Auto-reduce on invoice save
- ✅ Auto-increase on purchase bill save
- ✅ Inventory added to sidebar

---

## PHASE 8 — GST Reports ✅

### Database
- ✅ Create gst_return_periods table

### GST Dashboard
- ✅ Period selector (last 6 months)
- ✅ Output tax section (total sales, taxable, CGST, SGST, IGST)
- ✅ ITC section (purchases, CGST, SGST, IGST ITC)
- ✅ Net payable card (green if zero, red if payable)
- ✅ Return filing status tracker
- ✅ Update return status (dropdown)
- ✅ Links to GSTR-1 and GSTR-3B

### GSTR-1
- ✅ Period selector
- ✅ Summary cards (invoices, taxable, tax, total)
- ✅ B2B tab (with GSTIN column)
- ✅ B2C tab
- ✅ Export/SEZ tab
- ✅ HSN Summary tab (qty, value, tax by HSN code)
- ✅ Totals row in B2B
- ✅ Export to CSV
- ✅ GST compliance warning

### GSTR-3B
- ✅ Period selector
- ✅ Section 3.1 (outward supplies: B2B, B2C, export, nil)
- ✅ Section 4 (ITC available: IGST, CGST, SGST)
- ✅ Section 6.1 (net tax payable: tax − ITC)
- ✅ CGST/SGST/IGST columns
- ✅ Total row
- ✅ Export to CSV
- ✅ GST compliance warning

---

## PHASE 12 — Reports & Dashboard ✅

### Live Dashboard
- ✅ Real sales, purchases, expenses for current month
- ✅ GST summary (collected, ITC, payable)
- ✅ Outstanding receivables and payables
- ✅ Overdue receivables
- ✅ 6-month sales bar chart
- ✅ GST return status widget
- ✅ Recent invoices (last 5, clickable)
- ✅ Empty state if no invoices

### Reports Page
- ✅ Period selector (month, last month, quarter, FY)
- ✅ Sales tab
  - ✅ Summary cards (total, taxable, tax, count)
  - ✅ Sales by customer (ranked)
  - ✅ Sales by product (ranked)
  - ✅ Sales by state
- ✅ Purchases tab
  - ✅ Summary cards
  - ✅ Purchases by vendor (with ITC)
- ✅ GST Summary tab
  - ✅ Output vs ITC vs Net payable grid
  - ✅ CGST/SGST/IGST breakdown
- ✅ Profit Overview tab
  - ✅ Revenue, purchases, expenses
  - ✅ Gross profit and net profit
  - ✅ Profit margin percentage
  - ✅ Disclaimer note
- ✅ CSV export on all tabs

---

## VERSION 1 — Shipped ✅

### Settings Page ✅
- ✅ Invoice number prefix (change INV to custom)
- ✅ Company logo upload (Supabase Storage, `logos` table)
- ✅ Bank account details (for invoice footer)
- ✅ Default payment terms
- ✅ Financial year selection
- ✅ Invoice template selection (three skins, per organisation)

### Quotations ✅
- ✅ Create quotation, list and detail view
- ✅ Convert quotation to invoice
- ✅ Own sequence per FY, PDF print

### Credit Notes ✅
- ✅ Create credit note against an invoice, list, own sequence
- ✅ Folded into GSTR-1 / GSTR-3B / registers / targets as signed rows (CDRN reflected in the annual workpaper)

### Debit Notes ✅
- ✅ Create debit note, list, own sequence, feeds the ledger and registers

### Mobile responsive shell ✅ (September–October 2026)
- ✅ Sidebar, bottom nav, sheet menu, card views at 375 / 768 / 1024 / 1440

### Email Invoices ⏳
- ⏳ Email invoice PDF to customer, templates, send log

### Multi-User ⏳
- ⏳ Invite user by email, role selection (owner / accountant / staff), RBAC, remove user

---

## ROUND 1 — Competitive Features (2026-10-05) ✅

Features ranked against Tally, Zoho, Vyapar, myBillBook, Marg, Busy, Refrens, Clear, CaptainBiz and Swipez. All shipped client-side, no schema change.

- ✅ **1. GSTR-2B ↔ books ITC reconciliation** — `/gst/reconciliation` + `src/lib/gstr2b.ts`
- ✅ **2. E-invoice (IRN) + e-way bill** — `/gst/einvoice` + `src/lib/einvoice.ts` (NIC v1.10 JSON, build → download → paste ACK), GSP adapter layer `src/lib/gsp/*` + `/api/gsp/ewaybill` (mock provider)
- ✅ **3. Payment links + WhatsApp reminders** — `/payments/links` + `src/lib/payments.ts` (`upi://pay` deep links, `wa.me` reminders, three tones)
- ✅ **4. Light double-entry** — `/accounting` + `src/lib/ledger.ts` (P&L excluding GST, always-balancing balance sheet, localStorage opening balances)
- ✅ **5. Offline PWA** — `/offline`, `app/manifest.ts`, `public/sw.js`, `public/offline.html`, `src/lib/outbox.ts` (temporary OFF- numbers replayed through the real save path)
- ✅ **6. Barcode scan + POS** — `/pos`, `src/lib/barcode.ts` (GS1 mod-10, EAN-13/EAN-8/UPC-A/ITF-14/CODE-128), `src/components/BarcodeScanner.tsx`, `src/lib/create-invoice.ts` extracted as the single invoice write path
- ✅ **7. AI features** — `/ai/scan-bill` (`bill-text.ts`, `ocr.ts`: tesseract.js + pdf.js via `/api/pdf-worker`, GST cross-validation with per-field confidence) and `/ai/ask` (`ask.ts`: 17 intents, FY-period parsing, party/product/HSN filters). Deterministic and in-browser; `src/lib/create-bill.ts` is the shared bill write path

---

## ROUND 2 — Depth and Craft (2026-10-06 → 2026-10-07) ✅

- ✅ **R2-1 Design system v1** (`63faa25`) — tokens + `.tf-*` in `globals.css`, `Icons.tsx`, `ui.tsx`, `format.ts`, `reports.ts`; app shell and dashboard rebuilt
- ✅ **R2-2 Party ledger** (`16257ef`) — `/ledger` + `party-ledger.ts`; document-first payment linking
- ✅ **R2-3 Compliance calendar** (`36b3240`) — `/gst/calendar` + `compliance.ts`; filing-profile FY generator, late-fee estimates, `.ics`
- ✅ **R2-4 Statutory registers** (`158c44b`) — `/reports/registers` + `registers.ts`; party-wise, HSN/SAC, B2B, Rule 80(1) state-wise, e-way bill log
- ✅ **R2-5 Invoice document templates** (`a928653`) — `InvoiceDocument.tsx` (`modern`, `minimal` over the classic sheet), `words.ts`
- ✅ **R2-6 Targets and achievement** (`bd176c4`) — `/reports/targets` + `targets.ts`; festival-weighted split, prorated pace, product goals
- ✅ **R2-7 Reorder planner** (`83d369a`) — `/inventory/reorder` + `reorder.ts`; (s, S) policy, supplier-grouped POs; fixed the `current_stock` data-loss bug
- ✅ **R2-8 ⌘K command palette** (`f3b3d49`) — `commands.ts`, `CommandPalette.tsx`, `nav.ts`, `deep-link-search.ts`; `?q=` search added to bills, credit notes, debit notes, quotations
- ✅ **Hotfix pass** (`0aba36f`) — register line-item fetch 400, mobile toolbar overflow, 36 MB invoice PDFs
- ✅ **R2-9 GSTR-9 / 9C annual workpaper** (`95e1ee8`) — `/gst/gstr9` + `gstr9.ts`; outward and ITC tables, 180-day credit watch, 9C books-vs-3B reconciliation, CSV export
- ✅ **R2-10 Bank statement import + auto-match** (`7560987`) — `/bank` + `bank-statement.ts`; delimiter/header/date/amount detection for pasted or uploaded statements, direction resolved from split Dr./Cr. columns, cell sign, Dr/Cr indicator or running-balance delta, UTR de-duplication, weighted scoring (amount 40 · document number 30 · party 18 · date 12, recorded-payment reference 45) with exact/likely/possible tiers, confirm / set aside / undo, advisory text for unexplained lines, CSV export, storage in `taxflow:bank:<orgId>`
- ✅ **R2-11 TDS / 194Q withholding workpaper** (`cafc86b`) — `/tds` + `tds.ts`; section table (194A, 194C, 194H, 194I land/plant, 194J professional/technical, 194M, 194Q, 194R) with whole-vs-excess threshold modes, base read out of purchase bills with GST excluded when itemised, deduction month on the earlier of credit or payment, deposit calendar (7th of the next month, March → 30 April), 1.5%/1% monthly interest and 26Q late-fee ₹100/day capped at the tax and ₹5,00,000, PAN from the vendor or its GSTIN else the no-PAN rate, untagged spend surfaced instead of guessed, quarterly 26Q statements, two CSV sheets, storage in `taxflow:tds:<orgId>`

---

## ROUND 2 — Backlog ⏳

- ✅ **R2-12 Design-system migration pass** (complete, 10 batches) — counted from the code: **47** pages inside the shell — **43 fully on the kit**, **4 partly** (`bills`, `credit-notes`, `debit-notes`, `quotations` still hand-code their chrome) — plus the **3 auth pages** on the shared `AuthShell`. Migrated: `invoices` (list), `expenses`, masters (`vendors`, `customers`, `products`), money (`payments`, `payments/links`, `accounting`, `offline`), GST (`gst` hub, `gstr1`, `gstr3b`, `gstr9`, `gstr4`, `calendar`, `reconciliation`, `einvoice`), counter and AI (`pos`, `inventory`, `ai/ask`, `ai/scan-bill`), `reports`, `settings` (first at absolute zero hex), the auth trio (`login`, `signup`, `setup` on `AuthShell`, new `--brand-grad` token), and last the two document pages — `invoices/new` 58 → 0 hex, `invoices/[id]` chrome to 0 with the printable document left untouched by design (`b933bea`). R2-14 then added six pages, written on the kit rather than migrated: `challans` + `challans/[id]` (the printable challan is token-drawn, 0 hex) and the order pages — `sales-orders` + `sales-orders/[id]`, `purchase-orders` + `purchase-orders/[id]` — whose printable documents are token-drawn the same way. R2-15 B1 added `inventory/batches`, written on the kit the same way, and B2 `inventory/serials`. R2-16 B1 added the public `portal` page — the share-link statement of account — written on the kit outside the shell, counted like the auth surfaces. R2-17 B1 added `inventory/godowns`, written on the kit inside the shell. R2-18 B1 added `recurring` — the recurring-invoice register — written on the kit inside the shell. R2-19 B1 added `fx` — the foreign-currency register — written on the kit inside the shell. `4-Design-System.md` §16 is the ledger.
- ✅ **R2-13 GSTR-4 / CMP-08 composition workpaper** — `/gst/gstr4` + `src/lib/gstr4.ts` (53 assertions). Turnover split by the HSN/SAC on each line, the slab test with the ten Notification 17/2020 states, CMP-08 quarters against declared deposits, the 2.5% deemed debit, and the documents that bar the scheme. Also fixes the calendar: GSTR-4 was generated a year late and CMP-08 linked to GSTR-3B.
- ✅ **R2-14 B1 Delivery challans + order-flow engine** (`f982aed`) — `/challans` register + create/edit editor and `/challans/[id]` printable document over `src/lib/orderflow.ts`: one localStorage store per kind (`challan` / `sales_order` / `purchase_order`, `taxflow:challan\|sorder\|porder:<orgId>`, ADR-013), `DC-<FY>-NNNN` high-water numbering never reused (per kind, per FY, recoverable from the docs), engine-computed totals, the status table draft → in transit → delivered, Rule 55(4) reason handling with the six-month note, and conversion through `createInvoice` — allocating the real INV number, creating a `customers` row on the fly for free-typed parties, and marking the challan `converted`. Shared `pdf-export.ts` extracted from `invoices/[id]`; new `truck`/`edit` icons; both pages written on the kit (0 hex). 89 unit assertions in `/tmp/orderflow-test.mjs`. B2 (sales/purchase orders) next.
- ✅ **R2-14 B2 Sales orders + purchase orders** (`b851818`) — the engine's other two kinds mounted: one shared register (`OrderRegister.tsx`) and one shared printable document (`OrderDocument.tsx`) behind four thin route wrappers (`/sales-orders`, `/purchase-orders`, both `[id]` documents), with every per-kind string — party label, statuses, stats, copy — in one COPY table. Statuses: confirm → close (SO) and place → receive (PO). Conversions write through the real paths: SO → invoice via `createInvoice` (lazy `customers` row for free-typed parties), PO → bill via `createPurchaseBill` — and because a purchase bill's number is the *vendor's own* (the thing GSTR-2B matches), the conversion asks for "Vendor bill no. + date" in a small modal instead of inventing one; `buildBillPayload` refuses a blank number and flags ITC on bill and items. New `bag`/`clipboard-check` icons; 22 new assertions (111 total). All four pages written on the kit; documents token-drawn (0 hex).
- ✅ **R2-14 B3 Order flow in the registers + palette** (`94b3c1c`) — the round closes. `/reports/registers` gains a sixth tab, **Order flow**: `orderFlowRows` over `loadAllDocs` shows every non-cancelled challan / sales order / purchase order newest-first, filtered by the same period presets and filter box (locally — the docs are localStorage), sorted and CSV-exported through the existing register machinery, with a Register total on value; rows link to the document itself and statuses read `KIND_META.statusLabels`. The ⌘K palette searches the three stores **synchronously** (`orderRecordCommands` — no round-trip, no debounce, no loader) as record commands under Challans / Sales orders / Purchase orders groups; three new actions deep-link `?new=1` into the editors; `isKnownHref` accepts the three detail prefixes so palette-opened orders survive the recents replay. Also fixed the ranker: hyphenated single-token queries (`INV-2024-001`, `DC-2026-27`) now match — previously only `INV 2024` did. 55 new assertions across `/tmp/commands-test.mjs` (34) and `/tmp/registers-test.mjs` (21).
- ✅ **R2-15 B1 Batch & expiry register with FEFO consumption** (`9b7a4c6`) — `/inventory/batches` + `src/lib/batches.ts`: lots (product, batch no, mfg/expiry, received qty, cost, vendor) in `taxflow:batches:<orgId>` plus signed movements in `taxflow:batchmoves:<orgId>` (ADR-013 — a batch is owner bookkeeping; the statutory paper never carries the lot). Expiry is computed against the day printed on the pack — `daysLeft` 0 = "Expires today" (critical) — in tiers expired / ≤30 / ≤90 / ok / no-expiry. The FEFO allocator (`allocateFefo`) previews draws expired-first and warns without blocking; `recordSale` consumes lots automatically from `create-invoice.ts` — so the invoice form, POS counter and offline replay all draw FEFO — quiet by design (returns `null`, never throws, running list so two lines of one product cannot double-draw). Edit floor `out − back`: the received count cannot drop below what has left the lot. Six views, four stat cards, adjust (leaves/returns), delete, CSV; 77 assertions in `/tmp/batches-test.mjs`.
- ✅ **R2-15 B2 Serial-number register with derived warranty** (`e2a94d4`) — `/inventory/serials` + `src/lib/serials.ts`: one row per physical unit in `taxflow:serials:<orgId>` plus an append-only event log in `taxflow:serialevents:<orgId>` (ADR-013 again — an invoice line records a quantity, never *which* unit left). A serial is an identity, not a quantity: the same number never enters twice (case-insensitive, register-wide), a return restocks the existing row instead of forking its history, status is derived from the **latest recorded** event (corrections are new events, never edits of the past), and the warranty window is derived from the **latest** sale through a day-clamped `addMonths` (31 Jan + 1 → 28/29 Feb). Delete is refused once a unit has moved (`deleteUnit` → `null`; scrap is the honest exit) and identity freezes on history. Deliberately no automatic hook, unlike FEFO: nothing in an invoice can name the physical unit, so units attach to bills through the Issue action carrying the invoice number. Five views, four stat cards, bulk Receive (one serial per line, live collision preview), editor with locked identity, Movement modal (Issued/Returned/Scrapped) + confirm Restock, CSV; 84 assertions in `/tmp/serials-test.mjs`. Multi-godown was the last piece of gap #3 and turned out *not* to need the schema — it closed in R2-17 B1 on the same localStorage pattern.
- ✅ **R2-16 B1 Customer portal — the statement travels inside its own link** (`ccea4d5`) — `/portal` (public, no auth, no shell, noindex) + `src/lib/portal.ts` + a **Portal link** action on every customer in `/ledger`. The schema decision: there is no schema — the share link **is** the document. The payload is the same `buildStatement()` output the ledger shows (numbers agree by construction), JSON → `deflate-raw` → base64url with a `1.` version prefix, carried in the URL **fragment** (`/portal#d=…`) — a fragment never reaches the server, so nothing is stored, nothing is revocable, and no server route is needed. The 120-document cap (`PORTAL_MAX_DOCS`) **folds** the dropped rows' net into the opening balance so the arithmetic stays closed; the UPI VPA is baked at share time — `payLinkFor`/`payAllLink` build deep links from the stored VPA and the row's own due amount (a settled row or missing VPA yields a text note, never a dead pay chip). `decodePortal` returns typed refusals (not-a-link / damaged / wrong version) instead of throwing. The page has four phases (decoding shimmer / empty / error / ok) with a brand-gradient hero, per-row pay chips and the ledger's own `.responsive-table` anatomy; the share modal offers copy, WhatsApp (closing figure in the message) and open-preview. 82 assertions in `/tmp/portal-test.mjs`; `tsc` 0; build 51/51 with `○ /portal`.
- ✅ **R2-17 B1 Godowns — a batch learns the place it is kept in** (`8188d46`) — `/inventory/godowns` + `src/lib/godowns.ts`: the last third of competitor gap #3 (**multi-godown**), closed client-side under ADR-013 exactly as batch/expiry and serials were — `warehouses` still sits unqueried in the schema, the registry lives in `taxflow:godowns:<orgId>`. Two decisions: **unplaced is not nowhere** — a virtual `Main` godown seeds every blank/unknown `godown_id`, renameable but never archivable (guarded in `archiveGodown` *and* the `loadGodowns` merge); and **a transfer is a split, not a shipment** — the destination gets a new lot carrying the source identity and the source takes one negative `kind:'transfer'` move, so R2-15 B1's `left = qty + back − out` invariant and FEFO sorting never move. `godownStock` derives per-place units/value/expiry/critical (an `unplaced` count lands only on Main); `planTransfer`/`validateTransfer` refuse bad lots/quantities/destinations; `transferHistory` reads the negative transfer moves back out of the `→ X` note. `lotFilter` reaches the allocator as a predicate on `allocateFefo(..., where?)` — `batches.ts` never imports `godowns.ts`, and the automatic invoice drawdown stays global. The page is on the kit: place cards with value-share bars + FEFO drilldown, four stat cards, a `Segmented` view filter, a Move-stock modal with a "what gets written" preview gated on `validateTransfer.ok`, a stock-moves table + CSV. `batches.ts` gained `Batch.godown_id`, `kind:'transfer'`, `newBatch(receivedDate)` and the Godown CSV column (19 wide); `/inventory/batches` gained a `?godown=` deep link, a Godown column, an editor field and a "Draw from" narrowing. Nav "Godowns" + ⌘K "Add godown" + `warehouse`/`list` glyphs. Honest v1 boundary: per-place figures cover registered lots only — `products.current_stock` has no per-godown column, so that rollup waits for Phase 14. 97 assertions in `/tmp/godowns-test.mjs`; `tsc` 0; eslint 0 on all seven touched files; build 52/52 (50 pages + 2 api) with `○ /inventory/godowns`.
- ✅ **R2-18 B1 Recurring invoices — a schedule accrues, opening the app bills it** (`3fbea60`) — `/recurring` + `src/lib/recurring.ts`: competitor gap **#9** closed client-side under ADR-013 (`taxflow:rec:<orgId>`). A schedule is a bill template (reuses `FlowLine` lines, copied in) + a cadence (daily → yearly with an `interval` multiplier) + an end rule (`never | count | date`) + `due_in_days` payment terms anchored on `anchor_date`. The load-bearing decision: **due dates are never stored** — `buildCalendar` expands the rule over a 400-day horizon and `dueDates` intersects it with today, so a missed March period is still waiting in April, and raising it dates the invoice on its own scheduled day. Because `createInvoice` reads the financial year off `invoice_date`, that back-dated bill is numbered in `INV-<FY>-NNNN` and lands in the return period it belonged to — the GST-correct thing a cloud auto-invoice usually is not (the UI warns when it falls in an already-filed period). Month arithmetic is anchor-relative and clamped (Jan 31 → Feb 28 → Mar 31, no drift) and every step runs on `Date.UTC` so a timezone cannot move a bill into another FY; `parseISO` refuses a day beyond its month (a test caught `2026-02-30` being accepted). Occurrences are addressed **by date, not by click order** — `latestOccurrence` reduces on the date, so a catch-up run that bills December before January still reports the right last bill, and `recordOccurrence` refuses duplicates, off-cadence dates and anything past the end rule. Catch-up raises every due period through the real path (`scheduleTotals` → `buildSchedulePayload` → `createInvoice`: real sequence number, `record_stock_movement`, FEFO `recordSale`) and falls back to `queueOfflineInvoice` when the network refuses mid-save. Honest v1 boundary, printed on the page: nothing bills itself while TaxFlow is closed — there is no server posting at midnight, so the schedule *accrues*. UI: five views (due / upcoming / paused / completed / all), four stat cards, per-schedule due piles worth in rupees, an editor whose line items compute on the real GST engine (`determineGSTType` + `calculateLineItem` + `calculateInvoiceTotals` in one memo), a "generate for period" sheet listing each date with its FY, the trail of raised bills, CSV export, pause/resume, and delete refused once a schedule has billed (serial-register precedent — pause instead). Nav entry under Sales, ⌘K "New recurring invoice" → `/recurring?new=1`, new `repeat`/`pause`/`play` glyphs. 183 assertions in `/tmp/recurring-test.mjs` + 7 new in `/tmp/commands-test.mjs` (49); `tsc` 0; eslint 0 on every touched file; build 53/53 with `○ /recurring`.
- ✅ **R2-19 B1 Foreign-currency deals — the bill stays rupees, the currency lives beside it** (`a7fd1b1`) — `/fx` + `src/lib/fx.ts`: competitor gap **#8** (Zoho Professional), closed client-side under ADR-013 in `taxflow:fx:<orgId>`, recorded as **ADR-026**. The schema fact that decides everything: `invoices` has **no currency column** and the 29 statutory columns are frozen, so the FX layer declares the currency and joins to the books **by invoice number** — the rupee record the GST return reads is never touched or converted. Rule 45 (CGST Rules) fixes the shape of a rate: value in INR at the rate notified for that day (RBI reference rate on the invoice date; FEDI for exports), so a rate is a **dated row with a source stamp** (`manual` | `feed`) and `rateFor()` returns `null` rather than inventing a number when nothing has been recorded. Three rupee numbers are kept apart and never averaged: the rate used, the rate the books *imply* (`grand_total ÷ foreign_value`), and today's rate — the disagreement between them is the finding. Realised = Σ(`receipt INR − receipt foreign × booked rate`); unrealised = `outstanding foreign × (today − booked)`, and a currency with no recorded rate yields **no revalued figure rather than a zero one** (`fxSummary` nulls it — a ₹0 exposure reads as settled). `validateRate` catches the commonest real mistake, an **inverted quote**: a swing check misses it (0.012 against ₹83 is 99.98% *below* the last row, never "more than a doubling"), so the test is the `max/min > 2` ratio between the two, whichever way round the error sits. Rates pull one currency at a time from the ECB reference feed via Frankfurter (no key, CORS `*`) — one request per code because inverting a 5-s.f. INR-base quote loses precision (0.01038 USD/INR → ₹96.34 against the published ₹96.78) — and AED/SAR/KWD/QAR/OMR, which that feed does not publish, are reported `missing`, never zero. UI on the kit (0 hex): four stat cards, the **three-rate strip** per deal card, a `Segmented` view filter (needs a look / outstanding / received / all), the deal editor with a live implied-rate readback, the remittance modal, the rate ledger with per-currency history + an inline add, the feed report strip, and CSV for both ledgers. Boundary printed on the page, in the same one-writer spirit as `/bank`: **this page does not receive money** — recording a remittance here never receipts the invoice, that happens at `/payments`. Nav "Foreign Currency" under Money, ⌘K "New foreign-currency deal" → `/fx?new=1`, new `globe` glyph. 153 assertions in `/tmp/fx-test.mjs` (registry + formatting, storage round-trip/dedupe, `rateFor` carry-forward and aging, `validateRate` incl. the reciprocal catch, entries/`entryFromInvoice`, receipts + realised math, derived exposure incl. the null-revaluation rule, the advice the page must show, sorting/rollup, the feed parser incl. unpublished codes, both CSV shapes); `tsc` 0; eslint 0 on every touched file — `fx.ts`, `fx/page.tsx`, `nav.ts`, `commands.ts`, `Icons.tsx`; build ✓ 54/54 (52 pages + 2 api) with `○ /fx` and no warnings. Interactive UI still unverified — the Supabase dev session is expired (task #84).
- ✅ **GST 2.0 rule-drift pass** (`5d92515`) — from `7-Competitor-Comparison.md` §9: `src/lib/gst-rates.ts` became the single rate table (0 · 0.25 · 3 · 5 · 12 · 18 · 28 · 40) imported by all eight pickers, the e-invoice page now states the 30-day IRN window above ₹10 crore, the HSN register carries the Table 12 digit rule, and the calendar offers the 31 March CMP-02 opt-in to non-composition filers.
- ⏳ TDS/TCS return filing (26Q/24Q upload, 206C collection)
- ⏳ Real GSP submission for e-invoice / e-way bill (blocked: no free government API; needs a contracted provider)

---

## PHASE 14 — Security ⏳

- ⏳ Fix Supabase RLS for @supabase/ssr 0.12.x
- ⏳ Re-enable / tighten RLS on all tables (policies are hand-managed in the dashboard)
- ⏳ Test organization isolation with multiple accounts
- ⏳ Add audit log table + viewer
- ⏳ Rate limiting if any server route is added beyond `/api/gsp` and `/api/pdf-worker`
- ⏳ Generated Supabase types to retire the `as any[]` baseline

---

## PHASE 13 — SaaS Subscriptions ⏳

- ⏳ Define plan tiers (Free, Starter, Professional)
- ⏳ Create plans and features table
- ⏳ Usage tracking (invoices per month)
- ⏳ Plan limits enforcement
- ⏳ Razorpay integration
- ⏳ Subscription management page
- ⏳ Upgrade/downgrade flow
- ⏳ Trial period
- ⏳ Invoice for subscription payment

---

## VERSION 2 — Future ⏳

Shipped: ✅ e-invoice IRN payload builder · ✅ e-way bill payload + register · ✅ GSTR-9/9C workpaper · ✅ GSTR-4 / CMP-08 composition workpaper · ✅ bank statement matching · ✅ TDS / 194Q withholding workpaper · ✅ WhatsApp reminders · ✅ payment links · ✅ OCR bill scanning · ✅ installable PWA (a web-first "mobile app") · ✅ delivery challans + order-flow engine (R2-14 B1) · ✅ sales + purchase orders (R2-14 B2) · ✅ order flow in the statutory registers + ⌘K palette (R2-14 B3) · ✅ batch & expiry register with FEFO drawdown (R2-15 B1) · ✅ serial-number register with derived warranty (R2-15 B2) · ✅ customer portal — statement share links (R2-16 B1) · ✅ multi-godown — client-side godown registry, transfers as lot splits (R2-17 B1) · ✅ recurring invoices — accruing schedules that bill into the FY they belonged to (R2-18 B1) · ✅ multi-currency — a dated rate ledger beside the rupee books, FIRC-ready remittances (R2-19 B1)

Remaining: ⏳ TDS/TCS return filing (26Q/24Q upload, 206C collection) · ⏳ GSTR-4/3B actual submission (needs a contracted GSP) · ⏳ customer portal accounts beyond share links (R2-16 B1 is v1) · ⏳ native mobile app · ⏳ accountant portal · ⏳ API access · ⏳ payroll

---

## Known Issues / Bugs

| Issue | Status | Notes |
|-------|--------|-------|
| RLS disabled / partial | Pending Phase 14 | App-level `organization_id` isolation active |
| @supabase/ssr 0.12.x proxy/middleware | Pending | Fixed by disabling RLS temporarily |
| `as any[]` on every Supabase read | Baseline | No generated types; eslint `no-explicit-any` errors are pre-existing |
| 4 pages partly on the kit | Debt | R2-12 pass complete: 34 shell pages + 3 auth fully migrated, `bills`/`credit-notes`/`debit-notes`/`quotations` still hand-code their chrome. `invoices/[id]`'s printable document is a deliberate hex exception. `4-Design-System.md` §16 is the ledger |
| Font stack declares Inter, `next/font` loads Geist | Cosmetic | Nothing consumes `--font-geist-sans`; renders on the system stack |
| GSP submission is a mock | Blocked | No free government API; adapter ready for a real provider |
| Two amount-in-words implementations | Intentional | Legacy `numberToWords` still drives the classic print layout |

---

## Testing Checklist (run before each deploy)

- [ ] Can signup a new user
- [ ] Email confirmation works
- [ ] Can login and logout
- [ ] New user redirected to /setup
- [ ] Business setup saves correctly
- [ ] Can add customer, vendor, product
- [ ] Can create invoice with GST calculation
- [ ] CGST+SGST for same state, IGST for different state
- [ ] Invoice saves and shows in list; detail opens, prints and exports a sane-size PDF
- [ ] Quotation → invoice conversion keeps the numbers
- [ ] Credit note reduces the month it is dated in (registers, targets, GSTR-1)
- [ ] Can add purchase bill and expense; bill scan produces a valid draft
- [ ] Payment recording works; ledger balance sign is right
- [ ] Stock moves on invoice and on bill; a product edit does not reset `current_stock`
- [ ] GST dashboard, GSTR-1, GSTR-3B, GSTR-9 and registers reconcile to a hand-check
- [ ] 2B reconciliation classifies the seeded mismatches
- [ ] E-invoice JSON validates against the NIC shape
- [ ] Compliance calendar matches the filing profile; `.ics` imports
- [ ] Targets pace and reorder suggestions recompute after a new invoice
- [ ] POS: barcode scan, cash sale settles, stock moves
- [ ] Offline: airplane-mode invoice replays with a real INV number on reconnect
- [ ] ⌘K: pages, actions and live records; a hit never lands on an empty list
- [ ] Dashboard shows real metrics
- [ ] Every page above is checked at 375–455px **and** 1440px with zero horizontal overflow
