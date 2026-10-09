# TaxFlow India — Design System

**Version:** 2.0 (Design System v1, shipped 2026-10-06 in commit `63faa25`)
**Date:** October 2026

---

## 1. Design Principles

1. **Clarity over cleverness** — every element should be immediately understandable
2. **Data first** — a business owner must read a number at a glance
3. **Indian context** — ₹, lakh/crore compacting, en-IN dates, GSTN vocabulary
4. **Both widths** — desktop is the accountant's screen, the phone is the shop counter; a page is finished when both look deliberate
5. **Professional, not playful** — no emoji as interface chrome, no decoration that competes with a figure
6. **One kit** — a new page composes `ui.tsx` primitives and `.tf-*` classes; it does not hand-write a card, a button or a hex colour

---

## 2. Where Styling Lives

| Layer | File | Use for |
|-------|------|---------|
| Tokens | `src/app/globals.css` `:root` | colour, radius, shadow, sidebar width |
| Utilities | `src/app/globals.css` `.tf-*` | cards, stats, badges, buttons, inputs, grids, tables, palette |
| Primitives | `src/components/ui.tsx` | anything with props or behaviour |
| Icons | `src/components/Icons.tsx` | every glyph in the app |
| Page-scoped CSS | a `<style>` block inside the page | layout unique to that page (its own grid template, its own card shape) |

**Rule:** a page's own CSS references **tokens**, never literals. `#2563eb`, `#e2e8f0` and friends in a page are migration leftovers — remove them while you are in that file, do not add to them. (The one deliberate exception: the printable document inside `invoices/[id]` keeps its own palette — see §16.)

Legacy helper classes still in `globals.css`, still worn by the shell: `.page-container`, `.responsive-table` + `.table-header` / `.table-row[data-label]`, `.table-frame`, `.table-scroll`, `.tab-bar`, `.form-grid-3`, `.metric-grid`, `.hide-tablet`. New work uses `.tf-*`.

---

## 3. Tokens

```css
/* Surfaces */   --bg #f5f7fb · --bg-elevated #eef2f9 · --surface #ffffff · --surface-2 #f8fafc
                 --line #e5eaf2 · --line-soft #eff3f8
/* Text */       --ink #0f172a · --ink-2 #334155 · --muted #64748b · --faint #94a3b8
/* Brand */      --brand #2563eb · --brand-dark #1d4ed8 · --brand-soft #eff6ff
                 --brand-ring rgba(37,99,235,.22)
                 --brand-grad linear-gradient(135deg, #2563eb, #4f46e5 55%, #7c3aed) — the logo mark, sidebar and auth alike
/* Semantic */   --green #059669 / --green-soft · --red #dc2626 / --red-soft
                 --amber #d97706 / --amber-soft · --violet #7c3aed / --violet-soft
                 --cyan #0891b2 / --cyan-soft · --slate-soft #f1f5f9
/* Shape */      --radius-sm 8px · --radius 12px · --radius-lg 16px
                 --shadow-xs · --shadow-sm · --shadow-md · --shadow-lg
/* Layout */     --sidebar-w 244px   (200px for the 769–1024px icon rail)
```

### Semantic colour, used consistently
| Tone | Means | Where |
|------|-------|-------|
| blue | brand, primary action, active | buttons, links, selected nav |
| green | money in, healthy, complete | paid, ITC, matched, filed, above target |
| red | owed to government, error, destructive | cancelled, net payable, over-limit, delete |
| amber | needs action soon | partial, pending, due shortly, behind pace |
| violet | informational highlight | CGST/SGST columns |
| cyan | informational highlight | IGST column, e-invoicing |
| grey | neutral, inactive, historic | draft, cancelled text, notes |

`Tone` in `ui.tsx` is exactly `'blue' | 'green' | 'red' | 'amber' | 'violet' | 'cyan' | 'grey'` — badges and stat chips take a `tone`, never a colour.

### GST-specific
Output tax collected = red (money owed to the government) · ITC = green (money saved) · net payable = amber (action required) · CGST/SGST = violet · IGST = cyan.

### Status badges
`Paid` green · `Unpaid` red · `Partial` amber · `Draft` grey · `Sent` blue · `Cancelled` grey with no dot · `Filed` green · `Not started` grey.

---

## 4. Typography and Numbers

Body stack: `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`. `layout.tsx` loads Geist and Geist Mono through `next/font` as `--font-geist-sans` / `--font-geist-mono`, but nothing consumes those variables yet — in practice the app renders on the system stack. Choosing explicitly (bundle Inter, or point the stack at the loaded variable) is open work, not something to patch mid-feature.

| Role | Size | Weight |
|------|------|--------|
| Page title (`h1` in `.tf-pagehead`) | 21px · 18px under 400px | 700 |
| Section title (`.tf-section-title`) | 13px | 700 |
| Eyebrow / nav group label | 10–10.5px, uppercase, `letter-spacing: .05em` | 700 |
| Stat value (`.tf-stat-value`) | 24px · 20px under 400px | 700 |
| Body | 14px | 400 |
| Table text (`.tf-td`) | 13px | 400 |
| Label (`.tf-stat-label`, form labels) | 12–13px | 500–600 |
| Badge | 11px | 600 |
| GSTIN / HSN / UTR | monospace, 11–12px | 400 |

**Numbers always get `.tf-num`** (`font-variant-numeric: tabular-nums`) so columns of amounts align. Money uses `formatINR()` (`₹1,23,456.78`); KPI tiles use `formatCompactINR()` (`₹12.3L`, `₹1.2Cr`); dates use `formatDateIN()`; deltas use `changePct()`. In dense statutory grids where paise overflow the column, format whole rupees with `new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })` — that is what lets a 10-column reconciliation fit at 1440px.

---

## 5. Utility Classes

| Class | What it gives you |
|-------|-------------------|
| `.tf-card` `.tf-card-pad` `.tf-card-hover` | surface, 1px `--line`, `--radius`, `--shadow-xs` |
| `.tf-stat` | KPI tile whose accent bar comes from a local `--accent` variable |
| `.tf-stat-value` `.tf-stat-label` `.tf-stat-sub` | the three lines of a KPI tile |
| `.tf-chip` | icon bubble in a KPI tile, tinted by `--chip-bg` / `--chip-fg` |
| `.tf-badge` + `.tf-badge-{tone}` | pill with a leading dot; `.tf-badge-plain` drops the dot |
| `.tf-btn` + `-primary` `-ghost` `-subtle` `-danger` `-sm` | 8px radius, 1px press translate, focus ring from `--brand-ring`, and a global `:disabled` state — 55% opacity, `not-allowed` cursor, no press translate |
| `.tf-input` (+ `.tf-input-wrap`, `.tf-input-icon`, `.tf-input-clear`) | full-width field, focus border `--brand`, icon and clear affordances |
| `.tf-pagehead` | page banner with title, subtitle slot and actions |
| `.tf-th` `.tf-td` `.tf-tr` | hairline rows, hover `#f9fbfe`, no bottom border on the last row |
| `.tf-g-2` `.tf-g-3` `.tf-g-4` | responsive grids (collapse at 1024 / 768 / 400) |
| `.tf-row` `.tf-row-between` `.tf-col` `.tf-wrap` | flex helpers |
| `.tf-divider` `.tf-empty` | hairline rule, empty-state block |
| `.tf-rise` | 0.35s entrance, neutralised by `prefers-reduced-motion` |
| `.tf-bar-track` `.tf-bar-fill` | progress bars |
| `.tf-cmd-*` | the whole ⌘K palette (layer, bar, input, list, section, row, kbd, foot) |

---

## 6. Components (`src/components/ui.tsx`)

| Component | Key props | Use it for |
|-----------|-----------|-----------|
| `Card` | `pad`, `hover`, `className`, `style` | any surface block |
| `SectionTitle` | `icon`, `action` | heading inside a card with a right-hand control |
| `StatCard` | `label`, `value`, `sub`, `icon`, `tone`, `delta`, `deltaSuffix`, `href`, `delay` | KPI tile; numbers compact automatically, `href` makes the tile a link, `delay` staggers the entrance |
| `DeltaPill` | `delta` | ±% chip (dead-band at ±0.05 so noise reads flat) |
| `Badge` | `tone`, `dot` | status |
| `Button` | `variant`, `size`, `icon`, `iconRight`, `href`, `type`, `disabled` | actions; `href` renders a `Link`, `type="submit"` inside forms, `disabled` renders the dimmed state |
| `PageHeader` | `title`, `subtitle`, `eyebrow`, `actions`, `right` | top of every page |
| `SearchInput` | `value`, `onChange`, `placeholder`, `ariaLabel` | list filtering — the shared box every palette-landable list uses |
| `EmptyState` | `icon`, `title`, `message`, `action` | zero data, with a way out |
| `Segmented` | `options`, `value`, `onChange` | 2–4 way switch (tabs, template choice); every kit control renders `type="button"`, because a bare `<button>` inside a form submits it — the goods/service switch in the product modal used to save the product |
| `StatRow` | `label`, `value`, `strong`, `tone` | two-column figure rows inside a card |
| `ProgressBar` | `value`, `max`, `color`, `height` | progress fill — the OCR read bar, the Ask series bars |
| `BarChart` | `data: ({label, value, sublabel?})[]`, `height`, `color`, `format` | monthly series |
| `StackedBar` | `segments: ({label, value, color})[]`, `height` | GST split, mix-over-time |

Inside the kit: props are typed inline, CSS custom properties go through a small `vars()` helper so TypeScript stops fighting, and tone→colour is looked up in one `TONE_COLORS` map. Nothing in `ui.tsx` fetches data or knows what an invoice is.

### AuthShell (`src/components/AuthShell.tsx`)

The shared chrome for `login`, `signup` and `setup`: the brand mark on `--brand-grad`, the wordmark, one `tf-card` (400px, `setup` asks for 600) and the `.auth-*` form styling — fields, error box, completion mark; `setup` adds its own `.su-*` scoped block for the step dots and GSTIN hints. Standalone full-height wrapper, no sidebar. A new auth surface extends this, not a fourth copy of the card.

---

## 7. Icons (`src/components/Icons.tsx`)

One stroke set: `viewBox 0 0 24 24`, `fill: none`, `stroke: currentColor`, default `strokeWidth` 1.7, `aria-hidden`. `<Icon name size strokeWidth className style />`; an unknown name falls back to `dashboard` instead of crashing.

Available keys: `dashboard cloud invoice pos clipboard credit-note debit-note cart wallet link users factory box store landmark upload file-check compare zap chart scale scan chat settings plus swap arrow-right arrow-up arrow-down trend download printer search clock alert check x calendar percent target building logout menu sparkles bell filter book`

New nav icons go here. `nav.ts` stores the key as a string, so a typo degrades to the fallback — check the rendered sidebar, not just the build.

The list above is the original set; the registry is now **69 glyphs** and `Icons.tsx` is the source of truth. Added since: `chevron-down` `chevron-right` (R2-11's expandable tables), `truck` `edit` (R2-14 B1), `bag` `clipboard-check` (R2-14 B2), `hash` `undo` `shield` (R2-15 B2), `warehouse` `list` (R2-17 B1), `repeat` `pause` `play` (R2-18), `globe` (R2-19), `layers` `tag` (R2-21), `tally` (R2-22 — two ledgers facing each other with arrows both ways), `briefcase` (R2-23 — the case a job is carried in, with the latch where the hours are kept), `recipe` (R2-24 — the measure jar a run is mixed in: a fill line and a graduation rather than a coin, because a recipe stores *quantities* and every rupee on its card is read from the catalogue), `ship` (R2-25 — the consignment itself on the water: hull, cargo house, mast. The export register uses it because that register is about goods that physically left India, not about a rupee figure), `'doc-check'` (R2-25 — the RFD-11A acknowledgement: a document that only counts once it carries the portal's tick. **A key with a dash must be quoted**, otherwise it parses as subtraction and the build fails with TS1005). **A wrong name cannot fail the build**: the map is typed `Record<string, ReactNode>`, so `keyof typeof P` collapses to `string` and every typo renders the `dashboard` fallback silently — audit `icon="…"` values against the registry by script, not by eye. (The counting regex is `/^  '?([a-z0-9-]+)'?:\s/gm` — unquoted it misses every dashed key, which is how an earlier audit reported three glyphs short. It finds 70 lines because a `name: string` prop in the component interface below matches the same shape; subtract that one and the registry is 69.)

---

## 8. App Shell

- **Sidebar** (`--sidebar-w` 244px): logo, organisation block with the **GSTIN chip** in monospace, a `⌘K` affordance, *New Invoice* primary action, nav grouped by section with an active indicator, footer row (help / logout).
- **769–1024px:** the sidebar becomes an **icon-only rail** (`--sidebar-w: 200px`), labels hidden.
- **≤768px:** sidebar hidden; `mobile-topbar` (menu, search, new invoice), a slide-up **sheet** listing every section with the GSTIN under the business name, and a 4-item **bottom nav** (`BOTTOM_NAV` in `nav.ts`) plus *More*.
- Touch targets are ≥40px under 768px (`button, a, select, input { min-height: 40px }`), checkboxes excepted.
- Navigation lives in `src/lib/nav.ts`, which both the shell and the palette read. **A new page that is not in `nav.ts` is invisible.**
- The shell also renders the offline banner and mounts `CommandPalette` and `PwaRegister`.

---

## 9. Command Palette

`.tf-cmd-layer` (backdrop) → `.tf-cmd` panel → `.tf-cmd-bar` with `.tf-cmd-input` → grouped `.tf-cmd-list` with `.tf-cmd-section` headers and `.tf-cmd-row` items (`.is-active` for the cursor), `.tf-cmd-icon`, `.tf-cmd-label` / `.tf-cmd-sub` / `.tf-cmd-tag`, `.tf-cmd-kbd` hints in `.tf-cmd-foot`.

Accessibility: `combobox` / `listbox` / `option` roles with `aria-selected`, `aria-activedescendant`, `↑`/`↓`/`Enter`/`Escape`, focus returned on close. A record that is both a search hit and a recent must render **once** (`groupBySection` dedupes by href) or two rows share an option id.

Mobile gotcha: the footer hint needs the two-class selector `.tf-cmd-layer .tf-cmd-foot span` — `.tf-cmd-foot span` outranks `.tf-cmd-foot-hint`, so a single class will not win.

---

## 10. Tables

**Desktop:** `.table-frame` (rounded 1px border, white) → `.table-scroll` (horizontal scroll, momentum) → grid rows using `.tf-th` / `.tf-td` / `.tf-tr`, amounts right-aligned with `.tf-num`. Wide statutory grids set an explicit `min-width` on the inner element (the GSTR-9 body uses 1060px) and let the wrapper scroll rather than crushing columns.

**Mobile:** rows become cards. Each cell carries `data-label` and the media query renders it:

```css
@media (max-width: 768px) {
  .mt-head { display: none !important; }
  .mt-cols { grid-template-columns: 1fr !important; }
  .mt-cols > span.is-right {
    display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  }
  .mt-cols > span::before { content: attr(data-label); /* small-caps label column */ }
  .mt-cols > .mt-label::before { content: none; }   /* label cells opt out */
}
```

Four traps that cost real debugging time:

1. **Specificity.** The desktop rule `.mt-cols > .is-right { white-space: nowrap }` outranks a mobile rule written as `.mt-cols > span { white-space: normal }`. Match or exceed the desktop selector in the override (`.mt-cols > span.is-right`).
2. **Rupees do not wrap.** `₹13,04,500` has no break opportunity, so two amount columns at `1fr 1fr` overflow a phone whatever `white-space` says. Put **one figure per line** on mobile and verify with `scrollWidth − clientWidth === 0` on every `.table-scroll`.
3. **A totals row has no column to name.** If the foot cells reuse the header's `data-label`, the mobile card reads `Invoice no. — Total · 5 invoices`. Give the lead foot cell an empty `data-label` (or the `.is-lead` opt-out above) and hide the blank padding cells with `display: none`, or they stack up as empty lines.
4. **`.table-frame` disappears on mobile, by design.** The global media query makes the frame transparent with no border and no radius, because it assumes `.responsive-table` has already turned its own rows into cards. A page using the *grid* recipe (`.tf-tr` rows, its own column classes) gets an unframed float of bare rows on a phone. Every grid-recipe page must card its own rows inside the mobile block — `border: 1px solid var(--line)`, `border-radius: var(--radius)`, `background: var(--surface)`, `margin: 0 0 10px`, `:last-child { margin-bottom: 0 }`. `gst/gstr1` was the first to prove the recipe; `gst/einvoice` and `gst/reconciliation` reuse it.

CSV export uses `download()` in `party-ledger.ts`, which already prefixes a UTF-8 BOM — a library that prefixes one too produces a double BOM. Ragged rows need `csvFromRows` (quoted fields, `{{` unescaping) because a plain `join(',')` cannot represent a JSON payload column. When a figure has more than two decimals because you split it (expense GST across CGST and SGST), write it through the same formatter the screen uses — `Math.round(v * 100) / 100` disagrees with `Intl` on an exact half-paisa and the file then contradicts the page.

---

## 11. Forms

Two-column grids for most forms, three for address rows, collapsing to one column under 768px. Every field: `<label>` above (13px, 500, `--ink-2`) + `.tf-input`. Read-only values sit on `--surface-2`. Inline validation uses `--red` on `--red-soft`; GSTIN fields validate the format, not just the length. List pages use `SearchInput`, and their filter columns must mirror `ENTITY_SPECS.orColumns` in `commands.ts` — otherwise a palette hit lands on an empty list.

Buttons: `primary` for the page's one real action, `ghost` for secondary, `subtle` inside a card, `danger` for destructive. Every async action has a loading state and a disabled button while in flight.

---

## 12. Modals, Alerts, Empty States

Modal: fixed inset backdrop `rgba(15,23,42,.45)`, centred panel at `--radius-lg`, `padding: 1.5rem`, `max-width` 580–820px by content, `max-height: 90vh` with internal scroll.

Alerts: tinted soft background + stronger border + matching darker text (e.g. `#b45309` on `--amber-soft`). Info = "this is how it works", warning = "watch out", error = "this failed", success = "saved".

Empty state: `EmptyState` with an icon, a "No X yet" heading, one line about what to do, and an action. Never an empty table under a scrollbar.

---

## 13. Motion

Entrance `.tf-rise` (0.35s, `cubic-bezier(.22,1,.36,1)`), KPI tiles staggered by `delay`. `tf-grow` animates bar fills, `tf-pulse-ring` the online/offline dot. Both `prefers-reduced-motion` blocks neutralise them. Nothing animates a number the user is reading.

---

## 14. Invoice and Document Design

Three skins over identical data, chosen per organisation and stored in `taxflow:invoice-template:<orgId>`; the default is **`classic`** so nobody woke up to a different document:

| Skin | Character |
|------|-----------|
| `classic` | ruled Tally-style ledger sheet accountants recognise (rendered by the invoice page with the legacy `numberToWords`) |
| `modern` | colour band header, soft table, bold total block (`src/components/InvoiceDocument.tsx`) |
| `minimal` | quiet white document for services and consultants (same file) |

`modern` and `minimal` use `src/lib/words.ts` for the amount in words.

Print: `@media print` hides `.desktop-sidebar`, `.mobile-topbar`, `.mobile-bottom-nav`, `.tf-cmd-layer`, `#action-bar`, `#cancel-banner` and zeroes `.main-content` margins; documents keep their own `no-print` chrome. PDF export rasterises `#invoice-capture` with `html2canvas` at **`scale: 2`** (≈215 DPI at printed width) and JPEG quality 0.94, sliced per page — higher scales multiply the file size roughly 16× for no printed gain, which is what produced 36 MB invoices.

A document is a document: no card shadows, no rounded corners, print-safe colours, tabular numerals, ₹ and Indian grouping always literal (never compacted).

---

## 15. Breakpoints

| Range | Behaviour |
|-------|-----------|
| ≥1025px | full shell, 244px sidebar, multi-column grids |
| 769–1024px | icon rail (200px), `.tf-g-4`/`.tf-g-3` → 2 columns, `.hide-tablet` columns dropped, `.page-container` padding 1.25rem |
| ≤768px | no sidebar, topbar + bottom nav + sheet, grids → 1 (`.tf-g-4` → 2), tables → labelled cards, 40px touch targets |
| ≤400px | `.tf-g-4` → 1, pagehead padding and stat value shrink, `.tf-row-between` wraps |
| print | document only (see §14) |

**Verification:** check every new layout at a real phone width and at 1440px. The browser panel used for verification is ~371–455 CSS px, so it renders the mobile breakpoint natively; inspect the desktop layout by injecting a same-origin iframe at 1440×900 and reading `getComputedStyle` / `scrollWidth` from inside it.

---

## 16. Migration Status (R2-12)

Counted from the code, not from intention: a page is only "on the kit" when its header, buttons, badges and empty state are the primitives — importing `SearchInput` alone does not count.

**Fully on the kit — 49 pages inside the shell, plus the three auth surfaces and the public `portal` page.** `dashboard`, `invoices`, `invoices/new`, `invoices/[id]`, `expenses`, `vendors`, `customers`, `products`, `payments`, `payments/links`, `ledger`, `accounting`, `offline`, `gst` hub, `gst/gstr1`, `gst/gstr3b`, `gst/calendar`, `gst/gstr9`, `gst/gstr4`, `gst/reconciliation`, `gst/einvoice`, `inventory/reorder`, `reports/registers`, `reports/targets`, `bank`, `tds`, the counter and AI block: `pos`, `inventory`, `ai/ask`, `ai/scan-bill`, and `reports`, `settings`, and — post-pass, written on the kit rather than migrated — `challans` and `challans/[id]` (R2-14 B1), then the four order pages: `sales-orders`, `sales-orders/[id]`, `purchase-orders`, `purchase-orders/[id]` (R2-14 B2, shared `OrderRegister` / `OrderDocument`), then `inventory/batches` (R2-15 B1 — the batch/expiry register, written on the kit), then `inventory/serials` (R2-15 B2 — the serial-number register, written on the kit), then `inventory/godowns` (R2-17 B1 — the godown register, per-place batch stock and transfers-as-splits, written on the kit), then `recurring` (R2-18 B1 — the recurring-invoice register: schedule cards with derived due piles, a line-item editor that computes on the real GST engine, and the catch-up run, written on the kit), then `fx` (R2-19 B1 — the foreign-currency register: deal cards with the three-rate strip, a rate ledger with per-currency history, a remittance modal and an ECB-feed report strip, written on the kit with 0 hex), then `gst/job-work` (R2-20 B1 — the job-work register and the ITC-04 workpaper: movement cards whose left border *is* the section 143 clock, a clock band that says the statute's sentence rather than "overdue", the four grids plus the HSN summary, and the job-worker register, written on the kit with 0 hex), then `cost-centres` (R2-21 B1 — the cost-centre register: centre cards carrying revenue and spending share bars, a documents table whose split chips print each part's rupees, a bulk-assign bar, and a split modal whose preview is the same engine call the register renders, written on the kit with 0 hex), then `tally` (R2-22 — the bridge desk: a drop/paste card whose plan is a separate state from the paste box, four stat cards over a per-row plan that prints reasons, derivations and flags, an export desk that counts the rupees before the file exists, and an import log, written on the kit with **0 colour literals of any kind** — no hex, no `rgba`), then `projects` (R2-23 — the project and time register: project cards carrying billed/spend bars over hours, unbilled and contribution rows, a timesheet whose window badge is the engine's own `WATCH_META`, an unbilled register grouped per project-month with the rule 47 date printed beside each row, a documents tab that attaches whole rows by id, three CSV exports and a footer that names the browser key it lives in — written on the kit with **0 hex**, the same claim `cost-centres` makes: one token audit script later and the twelve hex literals the first draft carried were replaced by `var(--green)` / `var(--amber)` / `var(--red)` over their `-soft` grounds, and the only raw colour left is the modal scrim `rgba(15,23,42,.45)` that every register page shares), then `inventory/recipes` (R2-24 — the recipe book and build log: recipe cards whose cost-per-unit and margin are rolled up from the product master on every load, a "Can make now" figure with the limiting component named under it, a parts row that shows per-unit / drawn / on-shelf side by side, a build log that prints the variance instead of smoothing it, a materials board that folds open sales orders into one merged shortage list and explodes a made sub-assembly down to its bought-in leaves (`MAX_EXPLODE_DEPTH = 12`, greedy by design, with `findCycle()` refusing a loop long before the depth is reached), and a where-used rail that answers the reverse question one hop at a time — which recipes draw this part, what has already been consumed against it, whether the shelf could still cover them — written on the kit with **0 hex**, 21 `var()`s all resolving against `:root`, and the same two shared `rgba` recipes: the scrim and the notice-close hover), then `gst/exports` (R2-25 — the export register: file cards whose left border is the FEMA realisation clock, a watch list that names the missing paper rather than a tax figure, an LUT editor scoped per registration per year, four tabs over five CSVs, and a realisation strip that prints an FX receipt's rupees while saying *not counted* for a credit typed here — written on the kit with **0 hex**, 151 `var()`s over 23 tokens all resolving against `:root`, and only the two shared `rgba` recipes: the scrim and the notice-close hover), then the public `portal` page (R2-16 B1 — the share-link statement of account, on the kit outside the shell, counted like the auth surfaces). `login`, `signup` and `setup` followed on the shared `AuthShell` — the first pages whose chrome came from a component rather than a per-page recipe. The pass closed with the documents in B10 — `gst/gstr4` was written on the kit rather than migrated, which is how the ledger moves from here: a new page has no legacy palette to inherit, so it starts on the kit by default.

"On the kit" means the chrome — header, buttons, badges, empty states, tables. It does not mean literally zero hex: a hex audit still finds 2–9 strays on most of these pages (`reports/targets` 9, `ledger` 7, `pos` 6, `reports/registers` 6, `ai/scan-bill` 6, `gst/einvoice` 5, `inventory` 4, `gst/calendar` 4, `gst/gstr9` 3, `gst/gstr4` 3, `inventory/reorder` 3, `ai/ask` 3, `dashboard` 2, `gst/reconciliation` 2) — they are all the same kind of thing — a row-hover tint, the skeleton shimmer gradient, a border tint next to a `--*-soft` fill, the document-type colour map in `ledger`, and the four readable *text* shades an alert needs on top of a `--*-soft` fill (`#0e7490 #b45309 #b91c1c #15803d`) — i.e. one-off shades with no token equivalent, not the old palette. `reports` and `settings` were the first two pages to migrate to absolute zero, then the auth trio (three pages plus `AuthShell`), then `invoices/new` — 58 literals to 0. **`invoices/[id]` is a deliberate exception**: its chrome is at zero but the printable document keeps 63 literals (`th()`/`td()` cell tints, the `#dbeafe` section fills, the `#f9fafb` zebra rows, the red/green summary text) — the document is a legal artefact, and changing its palette is changing the artefact, so the bytes were left exactly as they were. When counting strays on that page, subtract the document. `challans/[id]` is the counter-example: a fresh printed artefact drawn entirely with tokens (var(--faint) rules, var(--brand-soft) fills) and `print-color-adjust: exact`, so both new pages audit at 0 hex — and the two order documents (`sales-orders/[id]`, `purchase-orders/[id]`, sharing `OrderDocument.tsx`) follow the same rule, 0 hex throughout.

**Partly on the kit — 4 pages.** `bills`, `credit-notes`, `debit-notes`, `quotations`. They use `SearchInput` and the shared table classes, but still hand-code the page header, buttons, badges and modal chrome with Tailwind-slate hex.

**Pre-kit — none.** The last two pages inside the shell, `invoices/new` and `invoices/[id]`, migrated in B10. The document pages sat at the end of the order for the reason in the next paragraph. The arithmetic is now 49 + 4 = 53 pages inside the shell — plus the 3 auth surfaces, the root redirect and the public `portal` outside it, which is every `page.tsx` in `src/app` (58 files, 53 of them under `(app)`). `gst/job-work` (R2-20 B1), `cost-centres` (R2-21 B1), `inventory/recipes` (R2-24) and `gst/exports` (R2-25) each audit at 0 hex: their only literals are the `rgba(15, 23, 42, 0.45)` scrim and the `rgba(0,0,0,0.05)` notice-close hover, both established recipes shared with the pages before them, not palette values.

Migration order — R2-12 complete: ~~masters~~ (done — one recipe, three pages) → ~~money~~ (`payments`, `payments/links`, `accounting`, `offline` — the whole tier) → ~~GST returns~~ (`gst` hub, `gstr1`, `gstr3b`) → ~~the rest of GST~~ (`reconciliation`, `einvoice` — the whole tier) → ~~counter and AI~~ (`pos`, `inventory`, `ai/*` — done) → ~~reports and settings~~ (`reports`, `settings` — done, the first two at absolute zero hex) → ~~auth pages~~ (`login`, `signup`, `setup` on the shared `AuthShell` — done, all at zero) → ~~documents last~~ (`invoices/new`, `invoices/[id]` — done, chrome only, because a printed document is the one surface where a styling change is a change to a legal artefact).

**Migrate a page when you touch it**; do not introduce new hex literals into a page that is still on the old markup — use tokens even inside it.
