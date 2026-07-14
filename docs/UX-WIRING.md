# UX wiring — help system + runtime badge (for the orchestrator)

Anchored patches to `index.html` and `js/app.js` that wire up `js/ui/help.js`
(❓ Help modal + first-run welcome) and the editor's runtime badge. The help
module and all CSS (`css/app.css`, "HELP & ONBOARDING" section) already ship;
these seven inserts are the only integration needed. Apply in any order —
they are independent. Every anchor below was grep-verified to occur exactly
once in its file at the time of writing.

Conventions: all patches are pure insertions (no existing line changes). Each
patch quotes the anchor verbatim; paste the snippet on a new line immediately
AFTER the anchor unless stated otherwise.

---

## index.html

### Patch 1 — "❓ Help" toolbar button (after the Challenge label)

Anchor (unique — `grep -c 'sel-challenge' index.html` → 1); quote includes the
`</label>` that closes the Challenge label, since `</label>` alone appears
three times:

```html
    <label>Challenge
      <select id="sel-challenge"><option value="">Pick a challenge…</option></select>
    </label>
```

Insert immediately after that `</label>` line:

```html
    <button id="btn-help" title="Quick start, coding guide, tutorial, and challenge help">❓ Help</button>
```

### Patch 2 — runtime badge in the editor pane's tab row

Anchor (unique — `grep -c 'id="tab-python"' index.html` → 1):

```html
        <button id="tab-python" class="tab">Python</button>
```

Insert immediately after, so the span is the LAST child of the editor pane's
`.tabs` nav (the `.runtime-badge` class uses `margin-left: auto` to sit at the
right edge without changing the row height):

```html
        <span id="runtime-badge" class="runtime-badge" title="Which Python dialect ▶ Run will use — see ❓ Help → Coding"></span>
```

---

## js/app.js

### Patch 3 — import HelpSystem

Anchor (unique — last of the import lines):

```js
import { BuilderPanel } from './ui/builder.js';
```

Insert immediately after:

```js
import { HelpSystem } from './ui/help.js';
```

### Patch 4 — instantiate after the views + wire the toolbar button

Anchor (unique — the last of the four view constructions in the
`// ---------- views ----------` section):

```js
const mapEditor = new MapEditor(view2d, engine, $('mapeditor-toolbar'));
```

Insert immediately after:

```js
const help = new HelpSystem();
$('btn-help').onclick = () => help.openHelp();
```

### Patch 5 — runtime badge updater (definition + debounced input hook)

Anchor (unique at column 0; the only other occurrence is indented inside the
examples loader, `      refreshPreview();` — match the un-indented line):

```js
refreshPreview();
```

Insert immediately after (this sits right before the
`// ---------- tabs ----------` section; `updateBadge` is a function
declaration, so the call added by Patch 6 inside `activateEditorTab` is safe
regardless of ordering):

```js
// Runtime badge: which Python dialect ▶ Run will use (see help.js "Coding" tab).
const runtimeBadge = $('runtime-badge');
function updateBadge() {
  runtimeBadge.textContent = ui.editorTab === 'blocks'
    ? 'Blocks → SPIKE 2 Python'
    : (isSpike3(pyEditor.value) ? 'SPIKE 3 · real Python' : 'SPIKE 2 · classic API');
}
let badgeTimer = 0;
pyEditor.addEventListener('input', () => {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 300);
});
```

Note: `isSpike3` is already imported at the top of app.js, and `pyEditor` is
declared above this insertion point. Programmatic `pyEditor.value` writes
(examples, challenges) don't fire `'input'`, but both paths end in
`activateEditorTab('python')`, which Patch 6 covers.

### Patch 6 — refresh the badge on editor-tab switches

Anchor (unique — inside `activateEditorTab`; the similar boot-time line reads
`if (ui.editorTab === 'blocks') …` so it can't be confused). Keep the
two-space indentation:

```js
  if (name === 'blocks') Blockly.svgResize(workspace);
```

Insert immediately after (before the `saveUi();` that follows):

```js
  updateBadge();
```

### Patch 7 — show the first-run welcome at the end of boot

Anchor (unique — the last statement of the `boot()` IIFE):

```js
  window.spikesim = { engine, view2d, view3d, workspace, challenges, getSpeed: () => speed };
```

Insert immediately after (still inside the IIFE, before its closing `})();`):

```js
  help.showWelcome(); // first-run overlay; no-ops once dismissed (spikesim.seenWelcome)
```

---

## Post-apply verification

1. `cd "D:/Marvin/06 Repos/SpikeSim" && node --input-type=module --check < js/app.js`
2. Fresh profile (or `localStorage.removeItem('spikesim.seenWelcome')` + reload):
   the welcome card appears once; "Let's go", backdrop, and ESC all dismiss it
   permanently; "Open the guide" lands on the help modal's Quick start tab.
3. `❓ Help` button opens the modal; ✕ / ESC / backdrop close it; the Tutorial
   tab fetches and renders docs/TUTORIAL.md (headings, code blocks, lists).
4. Badge: Blocks tab → `Blocks → SPIKE 2 Python`; Python tab with the default
   `from spike import …` program → `SPIKE 2 · classic API`; type
   `from hub import port` → flips to `SPIKE 3 · real Python` within ~300 ms.
   The editor tab row must not change height.
