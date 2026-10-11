# TaxFlow India

GST billing, invoicing and compliance for Indian businesses (₹2–20 crore) — cloud, no downloads, no per-seat pricing.

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Supabase (Postgres + Auth, browser client) · Tailwind v4 tokens + a small custom design system in `src/app/globals.css`.

**Status:** Round 1 (7 competitive features), Round 2 through R2-37, and Round 3 through R3-2b (R3-1 — the append-only audit trail and financial period locks; R3-2 — the branch & document-series register and honest opening balances; R3-2b — the manual journal register, folded into the statements and guarded by the same seal) are shipped — 64 pages and 53 pure domain libraries (67 routes). See `5-Project-Tasks.md` for the backlog, `1-PRD.md` for scope and `7-Competitor-Comparison.md` for where the product stands against Tally, Zoho Books, Vyapar, myBillBook, Busy, Marg, ClearTax and Refrens.

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

Pure libraries under `src/lib` are tested with a TypeScript loader, not a test runner:

```bash
node --experimental-strip-types --no-warnings --import /tmp/jr-register.mjs /tmp/<lib>-test.mjs
```

(`jr-register.mjs` registers the `resolve()` hook that maps `@/lib/…` onto `src/lib/…`; the suites themselves live in `/tmp` and are not committed, which is why each round records its own assertion counts in `5-Project-Tasks.md`.)

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

**Day-to-day:** business setup, customers, vendors, products, sales invoices (B2B/B2C/Export/SEZ), purchase bills, expenses, payments, quotations, credit/debit notes, delivery challans with the Rule 55 reason handling, sales and purchase orders that convert into a real invoice or a real bill, inventory with stock movements, batch/expiry lots drawn FEFO by the invoice itself, one-row-per-unit serial numbers with warranty derived from the latest sale, a godown register where a transfer is a lot split, a recipe book where a recipe stores quantities and minutes — parts priced from the product master, the time priced from dated shop-rate rows in force on each run's own day, with a dash and a reason where a rate is missing — and a build draws them from named lots — FEFO proposed, overrulable by hand — through the same stock RPC, lands the finished units as their own lot, gives the units back to the lots they came from when the run is cancelled, and — since R2-35 — lets a serialled component's draw name the actual numbered units: the oldest on the shelf proposed first, overrulable chip by chip, the register refusing a pick set that does not cover the drawn quantity to the unit, each pick issued as the register's own event with its job number, and a cancel writing each unit back on the shelf with an event of its own, with a demand tab that names the component stopping today's run, recurring invoice schedules that bill into the financial year they belonged to, foreign-currency deals kept beside the rupee books, settings.

**GST:** dashboard, GSTR-1 and GSTR-3B workpapers, GSTR-2B ↔ books reconciliation, e-invoice (IRN) + e-way bill payloads, GSTR-9/9C annual workpaper, GSTR-4/CMP-08 composition workpaper, job-work register with the section 143 return clock and the four ITC-04 grids, an export register that runs both clocks on every consignment that left India — the letter of undertaking that keeps the supply zero-rated and the FEMA window the proceeds have to arrive inside, with the refund limitation and the advance-dispatch deadline beside them and the source disagreement left visible rather than resolved silently, compliance calendar with late-fee estimates (it reads the export watch list from the register instead of keeping its own dates), statutory registers (party-wise, HSN/SAC, B2B, state-wise, e-way bill, order flow).

**Money:** party ledger & statements of account, P&L and balance sheet derived from documents, cost centres and departments that split an invoice, bill or expense by share — the percentage is what is stored, the rupees are re-read from the documents on every load, so amending a bill re-splits every centre by itself, projects & time — hours logged against a job with the whole invoices and bills that belong to it attached by id, rupees re-read from the books on every load so nothing here can rot, unbilled months priced and watched against the 30-day invoice window rule 47 asks for (a date, a rule and a link — never a tax figure), "billed" recorded as a reference to paper raised elsewhere rather than a document this page creates, and — since R2-36 — an hour that names whose hours they were: the person is picked from the payroll register, the hour is costed at what their hour cost in exactly the entry's own month (the rows cross as data; the projects library imports no payroll code), and the reading prints "after named hours" beside contribution — marked partial while hours remain unnamed or unpriced, never folded in, and — since R2-37 — a timesheet that draws from the kept day book: a person-month of marks arrives as proposed rows (a present day at the register's own hours a day, half a mark as half, every other mark refused with the register's own sentence, a day already on the project un-tickable), and only your tick writes — through the same entry validator the manual form uses, with the drawn row naming the person so it is costed the moment it lands, receivables/payables ageing, bank statement matching (any bank's layout, scored against open documents with the reasons shown), TDS & 194Q withholding workpaper read out of the purchase bills with deposit calendar and interest, UPI payment links and WhatsApp reminders, a dated FX rate ledger with realised and unrealised exposure beside the rupee books, targets with festival-weighted pacing, demand-driven reorder suggestions, a payroll & salary register that stores each person's pay structure and their exceptions but keeps no rupee — every month re-walks the financial year for its own take-home (section-192 annualisation, the PF wage ceiling read by the month's last day so ₹15,000 becomes ₹25,000 on 17-09-2026, the ESI band, professional tax capped at ₹2,500 with a dash and a reason wherever a state's rate is not verifiable), takes the shop's own attendance sheet as a paste rather than a table — a summary column or a day grid, read for one figure only, with every match, every refused line and every person the sheet forgot printed for approval before a month row is touched — and, since R2-34, **keeps the days** in a day book on the same page: the month ruled with dates, one mark per person per day tapped or pasted, held as evidence that carries no rupee until the shop pulls it into the month through the month form's own validation, with a blank day counted nowhere and a page refused by the *kind* of the line that could not be placed rather than by the wording of its reason — and prints what an hour actually cost on its own Cost tab — a figure `/projects` now reads as a costed hour whenever a timesheet row names the person it belongs to, printed beside contribution rather than folded into it. That register now also ends as **paper**: `/payroll/payslip` lays one person's month, or the whole month, out as an A4 slip whose every rupee is laid out from the engine's own reading, so a slip cannot disagree with the screen it came from — *net payable* rather than paid, a dash and a named sentence beside a letterhead code nobody typed, no figures at all for a month the register refuses, the exceptions printed in a strip on this side of the paper, and one PDF of a sheet per person for the month.

**In control (R3-1):** `/audit` is an append-only register of the decisions a shop makes about its closed periods — every period sealed, every seal released, every write a seal stopped, and every note lands as a numbered event, and the page can honestly say the trail is *unbroken* because the `seq` numbers run 1..n with no gap, duplicate or reorder (a checksum over the trail, not a signature — it proves a hand-edit happened, it cannot name the keyboard that did it). A **period seal** closes a GST period that has fully ended, and a document dated inside a standing seal is refused at the door that asks it: today `/invoices/new` asks — the moment the invoice date lands in a sealed month a red lock banner appears under the field, the save is refused with the seal's own sentence, and the attempt is written back to the register as a *Write refused* event, so the edit that never happened is still on the record; every other path is printed by name, not implied. Releasing a seal keeps it (released, never deleted) and demands a reason, because a silent unlock is exactly what an auditor looks for. The register holds no rupee, lives in this browser (ADR-013), travels only inside the books vault, and files nothing to the portal.

**At the desk (R3-2):** `/business` answers *where* the shop issues from and *what its numbers wear* — and nothing else. A **branch** is a full registration: its own 15-character GSTIN and the state code that GSTIN starts with, refused as a pair when they disagree, because place of supply and the CGST/SGST split read that pair. The invoice form offers an *Issuing branch* that swaps the printed header and stamps the notes with `[branch CODE]`; the print page reads the stamp back, and a branch deleted after its papers leaves the page naming a fallback rather than silently substituting. Deleting a branch whose name is still stamped on documents is refused — history does not go out of business; deactivate it instead — and the head office cannot close or vanish until the head is handed over. A **document series** dresses the five kinds this app numbers (tax invoice, quotation, delivery challan, sales and purchase orders): prefix up to eight characters, count padded 1–8 digits wide, the financial year optionally inside the number — and *only the shape is the shop's*. The counters stayed where they were (the Supabase `invoice_sequences` row for invoices; each order register's own high-water walk for the rest, which reads every shape a kind has worn, so nothing gets numbered twice and an untouched shop sees no change at all). Change a shape mid-year and papers already issued keep the shape they were born with. Two series with one prefix are refused — they would issue the same number twice. This register holds no rupee: the **opening balances** it replaces live on the Financial statements page, which since this round grows bank, receivable and payable lines and an *as-of* day the books were picked up — a balance sheet drawn before that day shows the documents it has, not an opening it was not yet standing on, and a payment grows cash without pretending to reduce an opening receivable it cannot name. The primary registration in Settings still signs the statutory pages (GSTR-1, e-invoicing); a branch here is what your paper prints. The register lives in this browser (ADR-013) at `taxflow:setup:<orgId>` and travels inside the books vault.

**By hand (R3-2b):** `/journal` is where a rupee that is real, lawful and has no paper behind it gets a name. Everything else here is written *backwards* from a document — an invoice makes revenue, a bill makes a payable, a payment moves cash — and a journal entry is written *forwards*: depreciation is ₹40,000 this year, the loan arrived but no bill did, the owner took money out of the till, a GST notice has raised a liability no bill carries. A **head** is the shop's own word for a line of the statements and it declares which of the fifteen lines its rupee moves — that declaration is the only place the debit/credit convention lives, so a fold cannot get an income leg backwards; an **entry** is at least two legs; and nothing reaches a statement that has not been **posted**, which is only allowed when the two sides agree to the paisa (every sum in the register runs in paise, so a float tail cannot decide whether an entry balances). A head cannot be debited and credited in the same entry; a closed head is not offered a new rupee; a leg of ₹0 says nothing. A posted entry is **reversed, never edited or deleted** — the mirror re-summonses each leg from the original with its side flipped, so a correction cannot drift from what it answers, both halves stay on the register, and the pair nets to nothing while remaining visible. And because every posting balanced on the way in, an entry **renames money and provably cannot move the derived "Capital account (derived)" plug** — that arithmetic is read off the rows the sheet is actually holding and printed beside the figures (`/accounting` names it, `/ai/ask` prints the same caveat rather than folding judgement into document totals). Numbers wear `/business`'s sixth series shape and are counted by this register alone; a draft takes no number, so deleting one cannot punch a hole in a series an auditor reads. **The seal is the second door here**: an entry dated inside a standing period seal is refused before its legs are even read, and the *attempt* lands on the audit trail. It files nothing — no return reads a journal row — it settles no bill, and it does not reach the bank; there is no chart of accounts, no account codes and no trial balance, only the shop's own named movements beside the derived paper. The register lives in this browser (ADR-013) at `taxflow:journal:<orgId>` and travels inside the books vault.

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
