# Theme Handover: "Dark" and "Ranch" (from ContractorPOS v1.16)

Use this to give all of Peter's programs the same two looks. They should be switchable per business (or per user) in Settings.
- **Dark:** charcoal, lime green and gold. It matches the Lokaal restaurant menu.
- **Ranch:** parchment, tan, forest green and burgundy. It matches the Lokaal website and the Bid Builder.

Built and tested in ContractorPOS (Node/Express, plain HTML/CSS/JS). Nothing here depends on a framework.

---

## 1. Palettes

### Dark
| Role | Color | Used for |
|---|---|---|
| Page background | `#121418` | body |
| Top bar | `#17191e` (bottom border `#2a2e36`) | header/nav |
| Panel | `#1d2027` | panels, modals, tables, cards on the page |
| Panel (alt) | `#1b1e24` | columns, secondary panels |
| Card | `#22262e` | cards inside panels |
| Input background | `#16181d`, border `#353a44`, placeholder `#6f7580` | inputs, selects, textareas |
| Button | `#2a2e36`, text `#f1f2f4` | normal buttons |
| Line / border | `#2e323b` / `#30353f` | dividers, table lines |
| Text | `#f1f2f4` | main text |
| Muted text | `#9aa0aa` | secondary text |
| **Lime** (highlight) | `#7cc04a` (text on dark: `#8fd16a`) | selected tab/chip (outline), links, prices, progress bars |
| Lime tint | `#1f2a17` | background of selected chip/tab (lime border + lime text) |
| **Gold** (headings) | `#d9a93a` | section headings (uppercase, letter-spaced), table header text |
| Table header background | `#191b20` | `th` |
| Danger / money owed | `#ef5350` (bright `#ff5a5a` on cards) | errors, delete, balance owed |
| Primary button | business accent color (default green `#1f8f4e`), white text | main action |

Status tints (Dark): info `#182a3f`/`#9cc8ff`, warning `#3a2f12`/`#f0d27a`, purple `#2b2040`/`#d6b4ff`, orange `#3a2a12`/`#f0b46a`, success `#1f3a24`/`#8fe3a5`, error row `#3a1f1f`/`#ff8a80`.

### Ranch
| Role | Color | Used for |
|---|---|---|
| Page background | `#efe5cf` | body |
| Top bar | gradient `#e7d4ac` → `#d9c093`, bottom border `#c4a874`, text `#2b2010` | header/nav |
| Panel | `#fbf7ee` (alt `#f7f0e1`) | panels, cards on the page |
| Card | `#fffaf0` | cards inside panels |
| Modal | `#f4ecdb` | dialogs |
| Input | white `#ffffff`, border `#cdbb98` | inputs |
| Button | `#ece2cc` (or `#fbf7ee` with border `#cdbb98`), text `#2b2417` | normal buttons |
| Line / border | `#d8c9a8` / `#dccdb0` | dividers |
| Tan accents | `#ead9b6`, `#f3ead6`, `#e6dcc6` | subheaders, chips, quiet fills |
| Text | `#2b2417` | main text |
| Muted text | `#7a6a50` | secondary text |
| **Forest green** | `#2f5a2a` | primary buttons, table headers (white text), focus ring, links, "Project Total" box |
| **Burgundy** | `#7f3b33` | section headings, page titles, selected nav tab (pill, cream text `#f6ead6`), app name, flags, delete icons, error messages |
| Money owed | `#8b2e24` | balance owed, "Owe $…" |
| Burgundy tint | `#f3dcd6`, border `#d9a99f` | warning tags ("Moved back") |
| Table rows | white / stripe `#f7f0e1` (or `#faf6ec`); selected `#fde7b0` | tables |
| Hills (footer art) | `#c9ad7f`, `#a98a5c`; barn/windmill `#7f3b33` | decorative footer |
| Toast | `#2b2417` (errors: burgundy) | pop-up messages |

**Rule of thumb for Ranch:** green means "do this" (action buttons, headers). Burgundy means "pay attention" (headings, money owed, warnings, delete). Tan and parchment are the background.

---

## 2. How the switch works

1. **Store the choice:** a `theme` column on the business (`'dark'` or `'ranch'`). In ContractorPOS, old businesses read `NULL` as Dark and new ones default to Ranch:
   ```sql
   ALTER TABLE businesses ADD COLUMN IF NOT EXISTS theme TEXT;
   ALTER TABLE businesses ALTER COLUMN theme SET DEFAULT 'ranch';
   ```
   The settings save route accepts `theme` and only allows `'dark'` or `'ranch'`. The "who am I" route (`/api/me`) returns it.
2. **Settings:** a select called "Look of the program" with the options "Ranch: parchment & green" and "Dark". After saving, reload the page.
3. **Apply it:** put the theme on the `<html>` element and remember it, so the page doesn't flash the wrong look while loading:
   ```js
   // top of the shared JS file, runs immediately
   try { document.documentElement.dataset.theme = localStorage.getItem('cp_theme') || 'dark'; } catch (e) {}
   // after /api/me loads
   function applyTheme(business) {
     document.documentElement.dataset.theme = (business && business.theme) || 'dark';
     try { localStorage.setItem('cp_theme', document.documentElement.dataset.theme); } catch (e) {}
   }
   ```
4. **Only the app screens:** add `class="cp"` to `<body>` on the main working screens only. Leave it off customer pages, receipts, invoices and statements, so those stay plain white.
5. **Printing:** wrap the Dark rules in `@media screen { … }` so printouts are always black on white.
6. **CSS tip:** write the theme's general rules with `:where(...)`, which makes them easy to override. Then specific buttons (status chips, colored tags) keep their own colors. Write the rules that must win, like special screens, with plain `html[data-theme=ranch] .thing`.

---

## 3. Drop-in stylesheet (`theme.css`)

Rename the class names to match each program (`.topbar`, `.panel`, `.card`, `table.list`, `.modal`, `#toast`, `.pill`, `.owed`, `.flag`). It assumes the base CSS uses variables: `--bg --panel --ink --muted --line --top --danger --accent`.

```css
/* ===== RANCH ===== */
html[data-theme=ranch]:has(> body.cp) { background: #efe5cf; }
html[data-theme=ranch] body.cp {
  --bg: #efe5cf; --panel: #fbf7ee; --card: #fffaf0; --ink: #2b2417; --muted: #7a6a50; --line: #dccdb0;
  --top: #2f5a2a; --green: #2f5a2a; --burg: #7f3b33; --owed: #8b2e24; --danger: #8b2e24;
  background: var(--bg); color: var(--ink);
}
:where(html[data-theme=ranch] body.cp) a { color: var(--green); }
:where(html[data-theme=ranch] body.cp) button { background: #ece2cc; color: #2b2417; }
:where(html[data-theme=ranch] body.cp) button.primary { background: var(--green); color: #fff; }
:where(html[data-theme=ranch] body.cp) button.danger { background: var(--danger); color: #fff; }
:where(html[data-theme=ranch] body.cp) input, :where(html[data-theme=ranch] body.cp) select, :where(html[data-theme=ranch] body.cp) textarea { background: #fff; color: #2b2417; border-color: #cdbb98; }
:where(html[data-theme=ranch] body.cp) input:focus, :where(html[data-theme=ranch] body.cp) select:focus { outline-color: var(--green); }
:where(html[data-theme=ranch] body.cp) .topbar { background: linear-gradient(180deg, #e7d4ac, #d9c093); color: #2b2010; border-bottom: 1px solid #c4a874; }
:where(html[data-theme=ranch] body.cp) .topbar a { color: #2b2010; }
:where(html[data-theme=ranch] body.cp) .topbar a.active { background: var(--burg); color: #f6ead6; border-radius: 99px; padding: 8px 14px; }
:where(html[data-theme=ranch] body.cp) .topbar .brand, :where(html[data-theme=ranch] body.cp) h2, :where(html[data-theme=ranch] body.cp) .section-title { color: var(--burg); }
:where(html[data-theme=ranch] body.cp) .panel, :where(html[data-theme=ranch] body.cp) .card { background: var(--panel); border: 1px solid #ddd0b3; box-shadow: 0 1px 2px rgba(80,60,20,.08); }
:where(html[data-theme=ranch] body.cp) table.list { background: var(--panel); border: 1px solid #d8c9a8; }
:where(html[data-theme=ranch] body.cp) table.list th { background: var(--green); color: #fff; }
:where(html[data-theme=ranch] body.cp) table.list tbody tr:nth-child(even) td { background: #f7f0e1; }
:where(html[data-theme=ranch] body.cp) .pill { background: #ead9b6; color: #3a2c17; }
:where(html[data-theme=ranch] body.cp) .modal { background: #f4ecdb; color: #2b2417; }
:where(html[data-theme=ranch] body.cp) .owed { color: var(--owed); font-weight: 800; }
:where(html[data-theme=ranch] body.cp) .flag, :where(html[data-theme=ranch] body.cp) .badge { background: var(--burg); color: #fff; }
:where(html[data-theme=ranch] body.cp) #toast { background: #2b2417; color: #fff; }
:where(html[data-theme=ranch] body.cp) #toast.bad { background: var(--burg); }

/* ===== DARK (screen only; printing stays black on white) ===== */
@media screen {
  html[data-theme=dark]:has(> body.cp) { background: #121418; }
  html[data-theme=dark] body.cp {
    --bg: #121418; --panel: #1d2027; --card: #22262e; --ink: #f1f2f4; --muted: #9aa0aa; --line: #2e323b;
    --top: #17191e; --danger: #ef5350; --lime: #7cc04a; --gold: #d9a93a;
    background: var(--bg); color: var(--ink);
  }
  :where(html[data-theme=dark] body.cp) a { color: var(--lime); }
  :where(html[data-theme=dark] body.cp) button { background: #2a2e36; color: #f1f2f4; }
  :where(html[data-theme=dark] body.cp) button.primary { background: var(--accent, #1f8f4e); color: #fff; }
  :where(html[data-theme=dark] body.cp) button.danger { background: var(--danger); color: #fff; }
  :where(html[data-theme=dark] body.cp) input, :where(html[data-theme=dark] body.cp) select, :where(html[data-theme=dark] body.cp) textarea { background: #16181d; color: #f1f2f4; border-color: #353a44; }
  :where(html[data-theme=dark] body.cp) input::placeholder { color: #6f7580; }
  :where(html[data-theme=dark] body.cp) .topbar { background: #17191e; border-bottom: 1px solid #2a2e36; color: #fff; }
  :where(html[data-theme=dark] body.cp) .topbar .brand-sub { color: var(--lime); }
  :where(html[data-theme=dark] body.cp) .topbar a.active, :where(html[data-theme=dark] body.cp) .tab.on, :where(html[data-theme=dark] body.cp) .chip.on {
    background: #1f2a17; color: var(--lime); box-shadow: inset 0 0 0 1.5px var(--lime); }
  :where(html[data-theme=dark] body.cp) .section-title { color: var(--gold); text-transform: uppercase; letter-spacing: .08em; }
  :where(html[data-theme=dark] body.cp) .panel, :where(html[data-theme=dark] body.cp) .card { background: var(--panel); border: 1px solid #2a2e36; border-radius: 14px; }
  :where(html[data-theme=dark] body.cp) table.list { background: var(--panel); border: 1px solid #2a2e36; }
  :where(html[data-theme=dark] body.cp) table.list th { background: #191b20; color: var(--gold); letter-spacing: .08em; }
  :where(html[data-theme=dark] body.cp) .pill { background: #2a2e36; color: #e6e8ec; }
  :where(html[data-theme=dark] body.cp) .modal { background: #1d2027; color: #f1f2f4; border: 1px solid #2e323b; }
  :where(html[data-theme=dark] body.cp) .price { color: var(--lime); font-weight: 800; }
  :where(html[data-theme=dark] body.cp) .owed { color: #ff5a5a; font-weight: 800; }
  :where(html[data-theme=dark] body.cp) #toast { background: #2a2e36; }
  :where(html[data-theme=dark] body.cp) #toast.bad { background: var(--danger); }
}
```

---

## 4. Look-and-feel rules (both themes)

- **Headings:** section headings are short, uppercase and letter-spaced (`.04–.12em`). They're gold in Dark and burgundy in Ranch. Page titles are burgundy in Ranch and white in Dark.
- **Selected tab or filter:** Dark uses lime outline, lime text and a dark green tint. Ranch uses a solid burgundy pill (top bar) or solid green.
- **Main action button:** green in both themes, white text. One main button per area.
- **Money:** amounts are lined up with `font-variant-numeric: tabular-nums`. Money owed is red (Dark) or burgundy (Ranch). Paid in full is green.
- **Rounded corners:** cards 10–14px, chips 7px, pills 99px.
- **User-chosen colors stay:** if a program lets users color things, like job board columns, the theme doesn't override those colors.
- **Some screens are always parchment:** the Bid Builder in ContractorPOS uses the Ranch look in both themes, with its tan header, green table header, burgundy title and a barn/windmill footer. A screen like that can do the same.
- **Printing:** receipts, invoices, statements and reports always print black on white.

---

## 5. Check after adding to a program

1. Switch Settings → Look of the program → **Ranch**. Check each main screen, dialogs, tables and pop-up messages.
2. Switch to **Dark** and check the same.
3. Print a receipt or report in each theme. It should be black on white.
4. Open a customer-facing page, like a receipt link or quote link. It should be plain white in both.
5. Look for stray old colors, like navy or bright white panels in Dark. Search the CSS for hard-coded colors and give them theme versions.

---

## 6. Starter prompt for another chat

> I want this program to have the same two looks as my other programs, **Dark** and **Ranch**. The theme handover is attached (`THEME-HANDOVER.md`). Use its exact colors and its switch: a `theme` setting saved per business, `data-theme` on `<html>`, `class="cp"` on the main screens only, and Dark limited to the screen so printing stays black on white. Add "Look of the program" to Settings. Keep customer-facing pages and printouts plain white. Then check every screen in both themes and send me screenshots. Give me the changed files one at a time with line counts, and tell me which go in `public`.
