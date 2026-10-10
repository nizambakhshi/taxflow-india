# TaxFlow India

GST billing, invoicing and compliance for Indian businesses (₹2–20 crore) — cloud, no downloads, no per-seat pricing.

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Supabase (Postgres + Auth, browser client) · Tailwind v4 tokens + a small custom design system in `src/app/globals.css`.

**Status:** Round 1 (7 competitive features) and Round 2 through R2-29 are shipped — 59 pages and 47 pure domain libraries. See `5-Project-Tasks.md` for the backlog, `1-PRD.md` for scope and `7-Competitor-Comparison.md` for where the product stands against Tally, Zoho Books, Vyapar, myBillBook, Busy, Marg, ClearTax and Refrens.

---

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

Environment (`.env.local`, never committed):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key used by the browser client |

Supabase schema and RLS policies are hand-managed in the Supabase dashboard — there are no migration files in this repo, and the working default is to ship a feature **client-side** (existing tables + `localStorage`) rather than change the schema. See `3-Development-Rules.md` Rule 21.

Checks before committing:

```bash
npx tsc --noEmit
npm run build
npx eslint <files you touched>   # `next lint --file` no longer exists in this Next build
```

Pure libraries under `src/lib` are tested with the TS loader, not a test runner:

```bash
node --experimental-strip-types --no-warnings --loader /tmp/ts-loader.mjs /tmp/<lib>-test.mjs
```

## Documentation

| File | What it holds |
|---|---|
| `1-PRD.md` | Product scope, versions, feature requirements, non-functional rules |
| `2-System-Architecture.md` | Routes, folder map, data model, GST engine, client-side state layer |
| `3-Development-Rules.md` | The conventions a change must follow |
| `4-Design-System.md` | Theme tokens, `.tf-*` utilities, `ui.tsx` primitives, icon set, responsive rules |
| `5-Project-Tasks.md` | Phase-by-phase build history and current backlog |
| `6-Project-Memory.md` | Decision records (ADRs / GCDs) and session log |
| `7-Competitor-Comparison.md` | Feature matrix against eight vendors, source-linked, plus the ranked gap list |

## What the app does

**Day-to-day:** business setup, customers, vendors, products, sales invoices (B2B/B2C/Export/SEZ), purchase bills, expenses, payments, quotations, credit/debit notes, delivery challans with the Rule 55 reason handling, sales and purchase orders that convert into a real invoice or a real bill, inventory with stock movements, batch/expiry lots drawn FEFO by the invoice itself, one-row-per-unit serial numbers with warranty derived from the latest sale, a godown register where a transfer is a lot split, a recipe book where a recipe stores quantities and minutes — parts priced from the product master, the time priced from dated shop-rate rows in force on each run's own day, with a dash and a reason where a rate is missing — and a build draws them from named lots — FEFO proposed, overrulable by hand — through the same stock RPC, lands the finished units as their own lot, and gives the units back to the lots they came from when the run is cancelled, with a demand tab that names the component stopping today's run, recurring invoice schedules that bill into the financial year they belonged to, foreign-currency deals kept beside the rupee books, settings.

**GST:** dashboard, GSTR-1 and GSTR-3B workpapers, GSTR-2B ↔ books reconciliation, e-invoice (IRN) + e-way bill payloads, GSTR-9/9C annual workpaper, GSTR-4/CMP-08 composition workpaper, job-work register with the section 143 return clock and the four ITC-04 grids, an export register that runs both clocks on every consignment that left India — the letter of undertaking that keeps the supply zero-rated and the FEMA window the proceeds have to arrive inside, with the refund limitation and the advance-dispatch deadline beside them and the source disagreement left visible rather than resolved silently, compliance calendar with late-fee estimates (it reads the export watch list from the register instead of keeping its own dates), statutory registers (party-wise, HSN/SAC, B2B, state-wise, e-way bill, order flow).

**Money:** party ledger & statements of account, P&L and balance sheet derived from documents, cost centres and departments that split an invoice, bill or expense by share — the percentage is what is stored, the rupees are re-read from the documents on every load, so amending a bill re-splits every centre by itself, projects & time — hours logged against a job with the whole invoices and bills that belong to it attached by id, rupees re-read from the books on every load so nothing here can rot, unbilled months priced and watched against the 30-day invoice window rule 47 asks for (a date, a rule and a link — never a tax figure), and "billed" recorded as a reference to paper raised elsewhere rather than a document this page creates, receivables/payables ageing, bank statement matching (any bank's layout, scored against open documents with the reasons shown), TDS & 194Q withholding workpaper read out of the purchase bills with deposit calendar and interest, UPI payment links and WhatsApp reminders, a dated FX rate ledger with realised and unrealised exposure beside the rupee books, targets with festival-weighted pacing, demand-driven reorder suggestions.

**At the counter and on the move:** POS screen with camera barcode scanning, installable PWA shell with an offline invoice outbox that replays through the normal save path, ⌘K command palette over pages, actions and live records, and customer statements that travel inside their own share link — the whole statement is encoded in the URL fragment, so nothing is stored server-side and there is nothing to revoke.

**Moving between books:** `/tally` reads a Tally .xml export in the browser and shows a plan — every voucher mapped to an invoice, bill, or credit/debit note against the document it names, each line matched to a product and party, with blocked documents named and reasons printed before a single row is written. Export goes the other way: a proper Tally XML envelope built from real invoices, labelled with what it contains and what it doesn't. Nothing leaves the device; the import log tells you exactly what ran and when.

**AI-ish, deliberately offline:** supplier bill scan (OCR/PDF → structured line items, cross-checked against GST arithmetic) and natural-language reporting over the user's own books. Both run entirely in the browser — no bill is uploaded anywhere, and every figure traces back to the rows it came from.

## Repository layout

```
src/app/            routes (App Router), api/gsp + api/pdf-worker, globals.css
src/components/     AuthShell, BarcodeScanner, CommandPalette, Icons, InvoiceDocument, OrderDocument, OrderRegister, PwaRegister, ui
src/lib/            pure domain libraries (GST engine, registers, GSTR-9, POS, AI, …)
public/             sw.js, offline.html, manifest assets, icons
```
