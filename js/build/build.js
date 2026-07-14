/**
 * build.js — AGENT-BUILD Stage-2 feature: the "Build Shop".
 *
 * A putting-things-together vehicle builder. Exports `init(ctx)`, self-injects
 * all of its UI (a full-stage overlay panel + a scoped <style>) and registers a
 * 'build' mode via ctx.registerMode. The existing #mode-build toolbar button
 * already calls ctx.setMode('build'); onEnter shows the panel, onExit hides it,
 * so the Build UI is only visible in build mode and never touches Drive.
 *
 * Flow: pick a base (Race Car / Robot / Slot Car) → drag parts from the palette
 * onto the chassis grid (they snap to cells; click a placed cell to remove) →
 * watch live stats (top speed / accel / grip / weight) + a mini preview update →
 * "Drive it" instantiates the built spec via ctx.loadVehicleSpec and switches to
 * drive mode. Builds save/load to localStorage under 'spikesim.builds'.
 *
 * All part maths lives in the pure, testable parts.js; this file is DOM + wiring.
 * Nothing here throws into the frame loop (Build registers no frame hooks) and
 * no user action can produce a NaN spec (parts.js clamps every tunable).
 */

import {
  BASES, baseConfig, baseList, gridSize, partById,
  paletteGroups, buildSpec, computeStats,
} from './parts.js';

const STORE_KEY = 'spikesim.builds';

/* ------------------------------------------------------------------ */
/* Scoped styles (self-injected; reuses the sandbox CSS variables)      */
/* ------------------------------------------------------------------ */

const STYLE = `
.bld-panel {
  position: absolute; inset: 0; z-index: 4;
  display: flex; flex-direction: column;
  background: radial-gradient(120% 120% at 50% 0%, #191c24, #101218 70%);
  color: var(--text);
  font-family: inherit;
}
.bld-panel.hidden { display: none !important; }

.bld-head {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 14px;
  background: linear-gradient(180deg, #1f232d, var(--panel));
  border-bottom: 1px solid var(--border);
}
.bld-title { font-weight: 800; letter-spacing: 0.3px; }
.bld-title .bld-accent {
  background: linear-gradient(90deg, var(--accent), #ffe27a);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.bld-bases { display: flex; gap: 4px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 3px; }
.bld-base-btn {
  border: 0; background: transparent; color: var(--muted);
  padding: 7px 12px; border-radius: 7px; font-size: 13px; font-weight: 700;
  display: flex; align-items: center; gap: 6px; transition: background .12s, color .12s;
}
.bld-base-btn:hover { color: var(--text); }
.bld-base-btn.active { background: var(--panel-2); color: var(--accent); box-shadow: inset 0 0 0 1px var(--border-2); }
.bld-base-btn .ic { font-size: 16px; }

.bld-name {
  background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 7px 10px; font-size: 13px; font-weight: 600; width: 130px;
}
.bld-name:focus { outline: none; border-color: var(--accent-dim); }
.bld-color { width: 34px; height: 34px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); padding: 2px; cursor: pointer; }
.bld-spacer { flex: 1 1 auto; }
.bld-saved {
  background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 7px 8px; font-size: 12px; max-width: 150px;
}

.bld-body { flex: 1 1 auto; min-height: 0; display: flex; gap: 12px; padding: 12px; overflow: auto; }

/* Palette */
.bld-palette { flex: 0 0 210px; display: flex; flex-direction: column; gap: 10px; overflow: auto; padding-right: 2px; }
.bld-cat-label { font-size: 10.5px; font-weight: 800; letter-spacing: 0.6px; text-transform: uppercase; color: var(--muted); margin: 2px 0 -2px; }
.bld-cat { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.bld-chip {
  display: flex; align-items: center; gap: 7px; text-align: left;
  border: 1px solid var(--border); background: var(--panel-2); border-radius: 9px;
  padding: 7px 8px; cursor: grab; transition: background .1s, border-color .1s, transform .05s;
}
.bld-chip:hover { background: var(--panel-3); border-color: var(--border-2); }
.bld-chip:active { cursor: grabbing; transform: scale(0.97); }
.bld-chip.pending { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.bld-chip .ic { font-size: 18px; line-height: 1; }
.bld-chip .nm { font-size: 11px; font-weight: 700; line-height: 1.15; }
.bld-chip .bg { font-size: 9px; font-weight: 800; color: var(--accent); }

/* Center: grid + preview */
.bld-center { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.bld-hint { font-size: 12px; color: var(--muted); }
.bld-grid-wrap {
  background: linear-gradient(180deg, #20242f, #191c24);
  border: 1px solid var(--border); border-radius: 14px; padding: 16px;
  box-shadow: var(--shadow);
}
.bld-grid { display: grid; gap: 7px; }
.bld-cell {
  width: 62px; height: 62px; border-radius: 10px;
  border: 1px dashed var(--border-2); background: rgba(255,255,255,0.02);
  display: flex; align-items: center; justify-content: center; position: relative;
  font-size: 26px; line-height: 1; transition: background .1s, border-color .1s, transform .05s;
}
.bld-cell.over { border-color: var(--accent); background: rgba(245,197,24,0.12); }
.bld-cell.filled { border-style: solid; border-color: var(--border-2); background: var(--panel-2); cursor: pointer; }
.bld-cell.filled:hover { border-color: var(--danger); }
.bld-cell .badge { position: absolute; top: 3px; right: 5px; font-size: 8px; font-weight: 800; color: var(--accent); }
.bld-cell .rm { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; color: var(--danger); background: rgba(20,22,28,0.55); border-radius: 10px; }
.bld-cell.filled:hover .rm { display: flex; }
.bld-preview { width: 100%; max-width: 440px; height: 176px; border: 1px solid var(--border); border-radius: 12px; background: radial-gradient(120% 140% at 50% 30%, #23262f, #14161c 75%); display: block; }

/* Stats */
.bld-stats { flex: 0 0 236px; display: flex; flex-direction: column; gap: 12px; }
.bld-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
.bld-card h3 { margin: 0 0 12px; font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--muted); }
.bld-stat { margin-bottom: 12px; }
.bld-stat:last-child { margin-bottom: 0; }
.bld-stat-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
.bld-stat-name { font-size: 12px; font-weight: 700; color: var(--text); }
.bld-stat-val { font-size: 12px; font-weight: 800; color: var(--accent); font-variant-numeric: tabular-nums; }
.bld-bar { height: 8px; border-radius: 5px; background: var(--panel-3); overflow: hidden; }
.bld-bar > i { display: block; height: 100%; width: 0; border-radius: 5px; background: linear-gradient(90deg, var(--accent-dim), var(--accent), #ffe27a); transition: width .18s ease; }
.bld-bar.wt > i { background: linear-gradient(90deg, #4a6ea8, #7aa2d8); }

.bld-actions { display: flex; flex-direction: column; gap: 8px; }
.bld-drive {
  border: 0; border-radius: 11px; padding: 14px; font-size: 15px; font-weight: 800; letter-spacing: 0.3px;
  color: #191207; background: linear-gradient(180deg, #ffe27a, var(--accent));
  box-shadow: 0 6px 16px rgba(245,197,24,0.22); transition: transform .06s, box-shadow .12s;
}
.bld-drive:hover { box-shadow: 0 8px 20px rgba(245,197,24,0.32); }
.bld-drive:active { transform: translateY(1px); }
.bld-row { display: flex; gap: 8px; }
.bld-btn {
  flex: 1 1 auto; border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
  border-radius: 9px; padding: 9px; font-size: 12px; font-weight: 700; transition: background .1s, border-color .1s;
}
.bld-btn:hover { background: var(--panel-3); border-color: var(--border-2); }
.bld-btn.danger:hover { border-color: var(--danger); color: #f3a99e; }

@media (max-width: 900px) {
  .bld-body { flex-wrap: wrap; }
  .bld-palette { flex-basis: 100%; }
  .bld-stats { flex-basis: 100%; }
}
`;

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Create an element with optional class, text and attributes.
 * @param {string} tag
 * @param {string} [cls]
 * @param {object} [props]
 * @returns {HTMLElement}
 */
function el(tag, cls, props) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (props) Object.assign(e, props);
  return e;
}

/** Read the saved-builds store (never throws). @returns {object} */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (_e) {
    return {};
  }
}

/** Persist the saved-builds store (never throws). @param {object} obj */
function saveStore(obj) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); } catch (_e) { /* quota / private mode */ }
}

/** Format a weight in kg for display (grams under 1 kg). */
function fmtWeight(kg) {
  if (!Number.isFinite(kg)) return '—';
  if (kg < 1) return `${Math.round(kg * 1000)} g`;
  return `${kg < 10 ? kg.toFixed(1) : Math.round(kg)} kg`;
}

/* ------------------------------------------------------------------ */
/* Feature init                                                         */
/* ------------------------------------------------------------------ */

/**
 * Initialise the Build feature. Called once by the sandbox orchestrator.
 * @param {object} ctx the Stage-2 extension context (see docs/SANDBOX.md)
 */
export function init(ctx) {
  if (!ctx || !ctx.stage) return;

  // Inject scoped styles once.
  if (!document.getElementById('bld-styles')) {
    const style = el('style');
    style.id = 'bld-styles';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  /* ---------------- State ---------------- */
  // Per-base placements so switching bases keeps each build. `cells` maps a grid
  // cell index → part id. name/color are per base too.
  /** @type {Record<string, {name:string, color:string, cells:Record<number,string>}>} */
  const builds = {};
  for (const b of baseList()) {
    builds[b.type] = { name: baseConfig(b.type).label, color: b.color, cells: {} };
  }
  const state = {
    base: 'racecar',
    pending: /** @type {string|null} */ (null), // click-to-place fallback selection
  };
  const cur = () => builds[state.base];

  /* ---------------- Build the panel DOM ---------------- */
  const panel = el('div', 'bld-panel hidden');

  // Header ------------------------------------------------------------
  const head = el('div', 'bld-head');
  const title = el('div', 'bld-title');
  title.innerHTML = '🔧 <span class="bld-accent">Build Shop</span>';

  const bases = el('div', 'bld-bases');
  /** @type {Record<string,HTMLElement>} */
  const baseBtns = {};
  for (const b of baseList()) {
    const btn = el('button', 'bld-base-btn', { type: 'button', title: `Build a ${b.label}` });
    btn.innerHTML = `<span class="ic">${b.icon}</span><span>${b.label}</span>`;
    btn.addEventListener('click', () => setBase(b.type));
    baseBtns[b.type] = btn;
    bases.appendChild(btn);
  }

  const nameInput = el('input', 'bld-name', { type: 'text', title: 'Name this build', maxLength: 24, placeholder: 'Name…' });
  nameInput.addEventListener('input', () => { cur().name = nameInput.value; });

  const colorInput = el('input', 'bld-color', { type: 'color', title: 'Paint colour' });
  colorInput.addEventListener('input', () => { cur().color = colorInput.value; refresh(); });

  const spacer = el('div', 'bld-spacer');

  const savedSel = el('select', 'bld-saved', { title: 'Saved builds' });
  savedSel.addEventListener('change', () => { if (savedSel.value) doLoad(savedSel.value); });

  head.append(title, bases, nameInput, colorInput, spacer, savedSel);

  // Body: palette | center | stats -----------------------------------
  const body = el('div', 'bld-body');

  // Palette
  const palette = el('div', 'bld-palette');
  for (const group of paletteGroups()) {
    const lab = el('div', 'bld-cat-label');
    lab.dataset.cat = group.category;
    lab.textContent = group.label;
    const grid = el('div', 'bld-cat');
    for (const part of group.parts) grid.appendChild(makeChip(part));
    palette.append(lab, grid);
  }

  // Center: hint + grid + preview
  const center = el('div', 'bld-center');
  const hint = el('div', 'bld-hint', { textContent: 'Drag parts onto the chassis — or click a part then a cell. Click a placed part to remove it.' });
  const gridWrap = el('div', 'bld-grid-wrap');
  const grid = el('div', 'bld-grid');
  gridWrap.appendChild(grid);
  const preview = el('canvas', 'bld-preview');
  preview.width = 440; preview.height = 176;
  center.append(hint, gridWrap, preview);

  // Stats card
  const stats = el('div', 'bld-stats');
  const statCard = el('div', 'bld-card');
  statCard.innerHTML = '<h3>Stats</h3>';
  const statDefs = [
    { key: 'topSpeed', name: 'Top Speed' },
    { key: 'accel', name: 'Acceleration' },
    { key: 'grip', name: 'Grip' },
    { key: 'weight', name: 'Weight' },
  ];
  /** @type {Record<string,{val:HTMLElement,fill:HTMLElement}>} */
  const statEls = {};
  for (const s of statDefs) {
    const row = el('div', 'bld-stat');
    const top = el('div', 'bld-stat-top');
    const nm = el('span', 'bld-stat-name', { textContent: s.name });
    const val = el('span', 'bld-stat-val', { textContent: '—' });
    top.append(nm, val);
    const bar = el('div', `bld-bar${s.key === 'weight' ? ' wt' : ''}`);
    const fill = el('i');
    bar.appendChild(fill);
    row.append(top, bar);
    statCard.appendChild(row);
    statEls[s.key] = { val, fill };
  }

  const actions = el('div', 'bld-actions');
  const driveBtn = el('button', 'bld-drive', { type: 'button', textContent: '🏁 Drive it' });
  driveBtn.addEventListener('click', doDrive);
  const rowBtns = el('div', 'bld-row');
  const saveBtn = el('button', 'bld-btn', { type: 'button', textContent: '💾 Save' });
  saveBtn.addEventListener('click', doSave);
  const clearBtn = el('button', 'bld-btn danger', { type: 'button', textContent: '🗑 Clear' });
  clearBtn.addEventListener('click', doClear);
  rowBtns.append(saveBtn, clearBtn);
  actions.append(driveBtn, rowBtns);

  stats.append(statCard, actions);

  body.append(palette, center, stats);
  panel.append(head, body);
  ctx.stage.appendChild(panel);

  /* ---------------- Palette chip (draggable) ---------------- */

  /**
   * Build a draggable palette chip for a part. Supports HTML5 drag AND a
   * click-to-select + click-cell fallback (touch / no-drag).
   * @param {object} part
   */
  function makeChip(part) {
    const chip = el('button', 'bld-chip', { type: 'button', draggable: true, title: part.blurb || part.name });
    chip.dataset.part = part.id;
    const badge = part.badge ? `<span class="bg">${part.badge}</span>` : '';
    chip.innerHTML = `<span class="ic">${part.icon}</span><span class="nm">${part.name}</span>${badge}`;
    chip.addEventListener('dragstart', (ev) => {
      try { ev.dataTransfer.setData('text/plain', part.id); ev.dataTransfer.effectAllowed = 'copy'; } catch (_e) { /* ignore */ }
      setPending(part.id);
    });
    chip.addEventListener('dragend', () => clearPending());
    chip.addEventListener('click', () => {
      setPending(state.pending === part.id ? null : part.id);
    });
    return chip;
  }

  function setPending(id) {
    state.pending = id;
    for (const chip of palette.querySelectorAll('.bld-chip')) {
      chip.classList.toggle('pending', chip.dataset.part === id);
    }
  }
  function clearPending() { setPending(null); }

  /* ---------------- Grid ---------------- */

  /** Rebuild the grid cells to match the current base's size and placements. */
  function renderGrid() {
    const { cols, rows } = gridSize(state.base);
    grid.style.gridTemplateColumns = `repeat(${cols}, auto)`;
    grid.innerHTML = '';
    const total = cols * rows;
    for (let i = 0; i < total; i++) grid.appendChild(makeCell(i));
  }

  /**
   * Create one grid cell wired for drop + click.
   * @param {number} index
   */
  function makeCell(index) {
    const cell = el('div', 'bld-cell');
    cell.dataset.index = String(index);
    paintCell(cell, index);

    cell.addEventListener('dragover', (ev) => { ev.preventDefault(); try { ev.dataTransfer.dropEffect = 'copy'; } catch (_e) {} cell.classList.add('over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));
    cell.addEventListener('drop', (ev) => {
      ev.preventDefault();
      cell.classList.remove('over');
      let id = '';
      try { id = ev.dataTransfer.getData('text/plain'); } catch (_e) { id = ''; }
      if (!id) id = state.pending || '';
      if (id && partById(id)) placePart(index, id);
      clearPending();
    });
    cell.addEventListener('click', () => {
      const cells = cur().cells;
      if (cells[index]) { removePart(index); return; }      // remove on click when filled
      if (state.pending) { placePart(index, state.pending); clearPending(); } // else place selected
    });
    return cell;
  }

  /** Paint a single cell's contents from its placement. */
  function paintCell(cell, index) {
    const id = cur().cells[index];
    const part = id ? partById(id) : null;
    if (part) {
      cell.classList.add('filled');
      cell.innerHTML = `<span>${part.icon}</span>${part.badge ? `<span class="badge">${part.badge}</span>` : ''}<span class="rm">✕</span>`;
    } else {
      cell.classList.remove('filled');
      cell.innerHTML = '';
    }
  }

  function repaintCell(index) {
    const cell = grid.querySelector(`.bld-cell[data-index="${index}"]`);
    if (cell) paintCell(cell, index);
  }

  function placePart(index, id) {
    cur().cells[index] = id;
    repaintCell(index);
    refresh();
  }
  function removePart(index) {
    delete cur().cells[index];
    repaintCell(index);
    refresh();
  }

  /* ---------------- Base switch ---------------- */

  function setBase(type) {
    if (!BASES[type]) return;
    state.base = type;
    for (const t of Object.keys(baseBtns)) baseBtns[t].classList.toggle('active', t === type);
    nameInput.value = cur().name || '';
    colorInput.value = normHex(cur().color) || baseConfig(type).color;
    clearPending();
    renderGrid();
    refresh();
  }

  /** Coerce any color string to a #rrggbb the color input accepts. */
  function normHex(c) {
    if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
    return null;
  }

  /* ---------------- Stats + preview refresh ---------------- */

  function currentSpec() {
    return buildSpec(state.base, cur().cells, cur().color, (cur().name || '').trim() || baseConfig(state.base).label);
  }

  function refresh() {
    let st;
    try { st = computeStats(state.base, cur().cells); } catch (_e) { return; }
    statEls.topSpeed.val.textContent = `${st.topSpeedKmh} km/h`;
    statEls.topSpeed.fill.style.width = `${Math.round(st.bars.topSpeed * 100)}%`;
    statEls.accel.val.textContent = `${st.accel}`;
    statEls.accel.fill.style.width = `${Math.round(st.bars.accel * 100)}%`;
    statEls.grip.val.textContent = `${st.grip}`;
    statEls.grip.fill.style.width = `${Math.round(st.bars.grip * 100)}%`;
    statEls.weight.val.textContent = fmtWeight(st.weightKg);
    statEls.weight.fill.style.width = `${Math.round(st.bars.weight * 100)}%`;
    drawPreview(st);
  }

  /* ---------------- Live mini preview ---------------- */

  /**
   * Draw a simple top-view of the current build on the preview canvas. Purely
   * cosmetic and fully guarded — never affects physics.
   * @param {object} st stats from computeStats
   */
  function drawPreview(st) {
    const cxs = preview.getContext && preview.getContext('2d');
    if (!cxs) return;
    const W = preview.width, H = preview.height;
    cxs.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const color = normHex(cur().color) || baseConfig(state.base).color;

    // Count part flavours to flavour the drawing.
    const ids = Object.values(cur().cells);
    const has = (p) => ids.indexOf(p) !== -1;
    const wheelBig = ids.filter((x) => x === 'wheel-l').length > 0;
    const wheelSmall = ids.filter((x) => x === 'wheel-s').length > 0;
    const hasSpoiler = has('spoiler');

    cxs.save();
    cxs.translate(cx, cy);

    try {
      if (state.base === 'robot') drawRobot(cxs, color, st, wheelBig);
      else if (state.base === 'slotcar') drawSlot(cxs, color, st);
      else drawCar(cxs, color, st, { wheelBig, wheelSmall, hasSpoiler });
    } catch (_e) { /* preview is best-effort */ }

    cxs.restore();

    // Little caption.
    cxs.fillStyle = 'rgba(138,144,162,0.9)';
    cxs.font = '11px system-ui, sans-serif';
    cxs.textAlign = 'left';
    cxs.fillText(`${baseConfig(state.base).label} · ${st.partCount} part${st.partCount === 1 ? '' : 's'}`, 10, H - 10);
  }

  function roundRect(cxs, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    cxs.beginPath();
    cxs.moveTo(x + rr, y);
    cxs.arcTo(x + w, y, x + w, y + h, rr);
    cxs.arcTo(x + w, y + h, x, y + h, rr);
    cxs.arcTo(x, y + h, x, y, rr);
    cxs.arcTo(x, y, x + w, y, rr);
    cxs.closePath();
  }

  function drawCar(cxs, color, st, opts) {
    // Body points +x (right). Length scales a touch with top speed.
    const L = 150 + Math.round(st.bars.topSpeed * 20);
    const Wd = 66;
    const tw = opts.wheelBig ? 22 : opts.wheelSmall ? 12 : 16; // tire length
    const th = opts.wheelBig ? 13 : 10;                        // tire width
    // Tires (dark) at four corners.
    cxs.fillStyle = '#101216';
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      roundRect(cxs, sx * (L / 2 - tw / 2) - tw / 2, sy * (Wd / 2) - th / 2, tw, th, 4);
      cxs.fill();
    }
    // Spoiler at the rear.
    if (opts.hasSpoiler) {
      cxs.fillStyle = '#2b3040';
      roundRect(cxs, -L / 2 - 8, -Wd / 2 - 2, 10, Wd + 4, 3);
      cxs.fill();
    }
    // Body.
    cxs.fillStyle = color;
    roundRect(cxs, -L / 2, -Wd / 2, L, Wd, 16);
    cxs.fill();
    // Windshield.
    cxs.fillStyle = 'rgba(20,22,28,0.55)';
    roundRect(cxs, -6, -Wd / 2 + 10, 26, Wd - 20, 6);
    cxs.fill();
    // Headlights (front = +x).
    cxs.fillStyle = '#fff4c2';
    for (const sy of [-1, 1]) { cxs.beginPath(); cxs.arc(L / 2 - 8, sy * (Wd / 2 - 10), 4, 0, Math.PI * 2); cxs.fill(); }
  }

  function drawRobot(cxs, color, st, wheelBig) {
    const S = 96;
    const ww = wheelBig ? 20 : 14;
    cxs.fillStyle = '#101216';
    for (const sy of [-1, 1]) { roundRect(cxs, -S / 2 + 6, sy * (S / 2) - ww / 2, S - 12, ww, 5); cxs.fill(); }
    cxs.fillStyle = color;
    roundRect(cxs, -S / 2, -S / 2 + ww / 2, S, S - ww, 14);
    cxs.fill();
    // Direction arrow (+x).
    cxs.fillStyle = 'rgba(20,22,28,0.7)';
    cxs.beginPath(); cxs.moveTo(S / 2 - 10, 0); cxs.lineTo(S / 2 - 30, -14); cxs.lineTo(S / 2 - 30, 14); cxs.closePath(); cxs.fill();
  }

  function drawSlot(cxs, color, st) {
    const L = 118, Wd = 48;
    cxs.fillStyle = color;
    roundRect(cxs, -L / 2, -Wd / 2, L, Wd, 12);
    cxs.fill();
    // Cockpit.
    cxs.fillStyle = 'rgba(20,22,28,0.55)';
    roundRect(cxs, -10, -Wd / 2 + 8, 30, Wd - 16, 6);
    cxs.fill();
    // Guide flag at the front.
    cxs.strokeStyle = '#8a90a2'; cxs.lineWidth = 3;
    cxs.beginPath(); cxs.moveTo(L / 2, 0); cxs.lineTo(L / 2 + 16, 0); cxs.stroke();
    cxs.fillStyle = '#f5c518';
    cxs.beginPath(); cxs.moveTo(L / 2 + 16, 0); cxs.lineTo(L / 2 + 16, -12); cxs.lineTo(L / 2 + 30, -6); cxs.closePath(); cxs.fill();
  }

  /* ---------------- Actions: drive / save / load / clear ---------------- */

  function doDrive() {
    let spec;
    try { spec = currentSpec(); } catch (_e) { ctx.showToast && ctx.showToast('Could not build that vehicle'); return; }
    try {
      ctx.loadVehicleSpec(spec);
      ctx.setMode('drive');
      ctx.showToast && ctx.showToast(`Driving “${spec.name}”`);
    } catch (_e) {
      ctx.showToast && ctx.showToast('Failed to load the build');
    }
  }

  function doSave() {
    const name = (cur().name || '').trim();
    if (!name) { nameInput.focus(); ctx.showToast && ctx.showToast('Name your build first'); return; }
    const store = loadStore();
    store[name] = { base: state.base, color: cur().color, name, cells: Object.assign({}, cur().cells) };
    saveStore(store);
    refreshSavedList(name);
    ctx.showToast && ctx.showToast(`Saved “${name}”`);
  }

  function doLoad(name) {
    const store = loadStore();
    const rec = store[name];
    if (!rec) return;
    const type = BASES[rec.base] ? rec.base : 'racecar';
    builds[type] = {
      name: rec.name || name,
      color: normHex(rec.color) || baseConfig(type).color,
      cells: (rec.cells && typeof rec.cells === 'object') ? sanitizeCells(rec.cells) : {},
    };
    setBase(type);
    ctx.showToast && ctx.showToast(`Loaded “${name}”`);
  }

  /** Keep only valid part ids in a loaded cells map. */
  function sanitizeCells(cells) {
    const out = {};
    for (const k of Object.keys(cells)) {
      if (partById(cells[k])) out[k] = cells[k];
    }
    return out;
  }

  function doClear() {
    cur().cells = {};
    renderGrid();
    refresh();
  }

  function refreshSavedList(selectName) {
    const store = loadStore();
    const names = Object.keys(store);
    savedSel.innerHTML = '';
    const ph = el('option', undefined, { value: '', textContent: names.length ? 'Load build…' : 'No saved builds' });
    savedSel.appendChild(ph);
    for (const n of names) {
      const rec = store[n];
      const opt = el('option', undefined, { value: n });
      const ico = baseConfig(rec && rec.base).icon;
      opt.textContent = `${ico} ${n}`;
      savedSel.appendChild(opt);
    }
    savedSel.value = selectName && names.indexOf(selectName) !== -1 ? selectName : '';
  }

  /* ---------------- Mode registration ---------------- */

  ctx.registerMode('build', {
    onEnter() {
      panel.classList.remove('hidden');
      refreshSavedList();
      // Sync header inputs to the current base's build and rebuild the grid.
      setBase(state.base);
    },
    onExit() {
      panel.classList.add('hidden');
      clearPending();
    },
  });

  // Initial paint so the panel is correct the first time it is shown.
  setBase('racecar');
  refreshSavedList();
}
