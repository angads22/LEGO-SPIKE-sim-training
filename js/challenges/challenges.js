/**
 * challenges.js — AGENT-CHALLENGES feature module. Exports `init(ctx)`.
 *
 * A challenge system layered on the physics SPIKE robot. It plugs into the
 * sandbox `ctx` exactly like the other Stage-2 features:
 *
 *  - Registers a 'challenge' mode and injects a #mode-challenge toolbar button
 *    wired to ctx.setMode('challenge').
 *  - Injects a Challenges panel (appended to ctx.stage, hidden unless challenge
 *    mode) with a challenge picker, a brief + numbered goal checklist, a
 *    progressive hints reveal, and Run / Stop / Restart buttons.
 *  - Selecting a challenge loads the robot onto the challenge mat
 *    (ctx.loadVehicleSpec({type:'robot'}, {arena: challenge.mat})), fills the
 *    shared code editor with the starter (ctx.code.setProgram), and logs the
 *    brief + goals + first hint teaser. The user edits + runs the program in the
 *    reused code panel (revealed alongside in challenge mode).
 *  - A goal checker runs on ctx.onFrame (guarded to challenge mode), reading the
 *    robot getState() + a per-attempt tracker, ticks each goal once (✔) and
 *    fires 🏆 + a beep when all are done. ctx.onExt('reset') re-arms.
 *
 * Everything here is defensive: the frame hook never throws, missing DOM/ctx
 * bits are guarded, and challenge mode never disturbs Drive mode.
 *
 * To run a challenge in the app: click the "Challenges" toolbar button, pick a
 * challenge from the dropdown, then press ▶ Run (in the Challenges panel or the
 * code panel). The three built-in challenges are Line Lap, Colour Tour and
 * Park It (see js/challenges/defs.js).
 */

import { challengeDefs } from './defs.js';

/**
 * Initialise the challenge feature.
 * @param {object} ctx the sandbox extension context (see js/sandbox.js)
 */
export function init(ctx) {
  const defs = challengeDefs();

  injectStyles();
  const ui = buildPanel(ctx, defs);
  injectToolbarButton(ctx);

  /* ---------------- per-attempt state ---------------- */

  let current = defs[0];       // selected challenge def
  let loadedId = null;         // which challenge is currently loaded in the world
  const tracker = {};          // per-attempt geometry tracker (reset on arm)
  let goalDone = [];           // boolean[] parallel to current.goals
  let goalEls = [];            // <li> elements parallel to current.goals
  let won = false;             // 🏆 fired for this attempt
  let hintsShown = 0;          // how many hints have been revealed

  /* ---------------- console / log ---------------- */

  function log(text, cls) {
    const line = document.createElement('div');
    line.className = 'ch-log-line' + (cls ? ' ' + cls : '');
    line.textContent = text == null ? '' : String(text);
    ui.log.appendChild(line);
    while (ui.log.childNodes.length > 200) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  /* ---------------- challenge lifecycle ---------------- */

  /** (Re)build the goal checklist DOM for the current challenge. */
  function renderGoals() {
    ui.goals.textContent = '';
    goalEls = [];
    for (const g of current.goals) {
      const li = document.createElement('li');
      li.className = 'ch-goal';
      li.textContent = g;
      ui.goals.appendChild(li);
      goalEls.push(li);
    }
  }

  /** Reset goals + tracker for a fresh attempt (does not touch the code editor). */
  function arm() {
    goalDone = current.goals.map(() => false);
    won = false;
    for (const k of Object.keys(tracker)) delete tracker[k];
    try { if (typeof current.arm === 'function') current.arm(tracker); } catch (_e) { /* ignore */ }
    for (const li of goalEls) li.classList.remove('done');
  }

  /** Reveal the hints area for the current challenge (teaser + counter reset). */
  function resetHints() {
    hintsShown = 0;
    ui.hints.textContent = '';
    if (current.hints && current.hints.length) {
      addHint(current.hints[0]);
      hintsShown = 1;
      ui.hintBtn.disabled = current.hints.length <= 1;
      ui.hintBtn.textContent = current.hints.length > 1
        ? `💡 Show another hint (1/${current.hints.length})`
        : '💡 That is the only hint';
    } else {
      ui.hintBtn.disabled = true;
    }
  }

  function addHint(text) {
    const row = document.createElement('div');
    row.className = 'ch-hint';
    row.textContent = '💡 ' + text;
    ui.hints.appendChild(row);
  }

  /**
   * Load a challenge into the world: put the robot on the challenge mat, fill the
   * shared code editor with the starter, arm the checker, and log the brief.
   * @param {object} def a challenge definition
   */
  function loadChallenge(def) {
    current = def;
    // Place the robot on this challenge's mat (arena carries the `mat`).
    try { ctx.loadVehicleSpec({ type: 'robot' }, { arena: def.mat }); } catch (_e) { /* ignore */ }
    loadedId = def.id;
    // Reuse the code panel: drop in the starter program.
    try { if (ctx.code && typeof ctx.code.setProgram === 'function') ctx.code.setProgram(def.starterCode); } catch (_e) { /* ignore */ }

    renderGoals();
    arm();
    resetHints();

    ui.log.textContent = '';
    log('▶ ' + def.name, 'title');
    log(def.blurb);
    log('Goals:');
    def.goals.forEach((g, i) => log('  ' + (i + 1) + '. ' + g));
    log('Edit the starter in the code panel, then press ▶ Run.');
  }

  /* ---------------- goal checker (per frame) ---------------- */

  function celebrate() {
    log('🏆 ' + current.name + ' complete! Great driving.', 'win');
    try { ctx.showToast('🏆 ' + current.name + ' complete!'); } catch (_e) { /* ignore */ }
    beep();
  }

  ctx.onFrame((dt, veh) => {
    // Guard hard to challenge mode so nothing runs in Drive/Code/etc.
    let mode;
    try { mode = ctx.getMode(); } catch (_e) { mode = null; }
    if (mode !== 'challenge' || !current || won) return;

    let st = null;
    try { st = veh && typeof veh.getState === 'function' ? veh.getState() : null; } catch (_e) { st = null; }
    // Only the robot carries the sensors the checkers read.
    if (!st || !st.sensors) return;

    let results = null;
    try { results = current.check(st, tracker); } catch (_e) { results = null; }
    if (!Array.isArray(results)) return;

    for (let i = 0; i < goalDone.length; i++) {
      if (results[i] && !goalDone[i]) {
        goalDone[i] = true;
        if (goalEls[i]) goalEls[i].classList.add('done');
        log('✔ ' + current.goals[i], 'done');
      }
    }
    if (goalDone.length && goalDone.every(Boolean)) {
      won = true;
      celebrate();
    }
  });

  /* ---------------- re-arm on world reset ---------------- */

  ctx.onExt('reset', () => {
    let mode;
    try { mode = ctx.getMode(); } catch (_e) { mode = null; }
    if (mode !== 'challenge') return;
    arm();
    log('↺ Re-armed — robot back at the start.', 'title');
  });

  /* ---------------- panel wiring ---------------- */

  ui.picker.addEventListener('change', () => {
    const def = defs.find((d) => d.id === ui.picker.value) || defs[0];
    loadChallenge(def);
  });
  ui.hintBtn.addEventListener('click', () => {
    if (!current.hints || hintsShown >= current.hints.length) return;
    addHint(current.hints[hintsShown]);
    hintsShown++;
    if (hintsShown >= current.hints.length) {
      ui.hintBtn.disabled = true;
      ui.hintBtn.textContent = '💡 No more hints';
    } else {
      ui.hintBtn.textContent = `💡 Show another hint (${hintsShown}/${current.hints.length})`;
    }
  });
  ui.runBtn.addEventListener('click', () => { try { ctx.code && ctx.code.run(); } catch (_e) { /* ignore */ } });
  ui.stopBtn.addEventListener('click', () => { try { ctx.code && ctx.code.stop(); } catch (_e) { /* ignore */ } });
  ui.restartBtn.addEventListener('click', () => {
    try { ctx.code && ctx.code.stop(); } catch (_e) { /* ignore */ }
    loadChallenge(current); // re-place robot at start + re-arm (keeps selection)
  });

  /* ---------------- mode registration ---------------- */

  /** Reveal the shared code panel next to the challenges panel. */
  function showCodePanel(show) {
    const panel = document.querySelector('.code-panel');
    if (panel) panel.classList.toggle('hidden', !show);
  }

  ctx.registerMode('challenge', {
    onEnter: () => {
      ui.panel.classList.remove('hidden');
      showCodePanel(true);
      // Typing code must not drive the robot with the keyboard.
      if (ctx.input) ctx.input.enabled = false;
      // Load the selected challenge fresh (unless it is already the loaded one).
      if (loadedId !== current.id) loadChallenge(current);
    },
    onExit: () => {
      try { ctx.code && ctx.code.stop(); } catch (_e) { /* ignore */ }
      showCodePanel(false);
      ui.panel.classList.add('hidden');
      if (ctx.input) ctx.input.enabled = true;
    },
  });
}

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

/** A short celebratory two-tone beep. Silent if WebAudio is unavailable. */
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    const now = ac.currentTime;
    const tone = (freq, t0, dur) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + t0);
      g.gain.exponentialRampToValueAtTime(0.09, now + t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(now + t0); o.stop(now + t0 + dur + 0.02);
    };
    tone(660, 0, 0.12);
    tone(990, 0.12, 0.18);
    setTimeout(() => { try { ac.close(); } catch (_e) { /* ignore */ } }, 600);
  } catch (_e) { /* never throw for a sound */ }
}

/* ------------------------------------------------------------------ */
/* UI construction                                                     */
/* ------------------------------------------------------------------ */

/** Inject the #mode-challenge toolbar button and wire it to challenge mode. */
function injectToolbarButton(ctx) {
  if (!ctx.toolbar || document.getElementById('mode-challenge')) return;
  const btn = document.createElement('button');
  btn.id = 'mode-challenge';
  btn.className = 'mode-btn';
  btn.type = 'button';
  btn.title = 'Run coding challenges on the SPIKE robot';
  btn.textContent = 'Challenges';
  const modes = ctx.toolbar.querySelector('.modes');
  if (modes) modes.appendChild(btn);
  else ctx.toolbar.appendChild(btn);
  btn.addEventListener('click', () => { ctx.setMode('challenge'); if (btn.blur) btn.blur(); });
}

/**
 * Build the Challenges panel, appended to the stage and hidden until challenge
 * mode is active.
 * @param {object} ctx
 * @param {Array<Object>} defs
 * @returns {{panel:HTMLElement, picker:HTMLSelectElement, blurb:HTMLElement, goals:HTMLElement, hints:HTMLElement, hintBtn:HTMLElement, runBtn:HTMLElement, stopBtn:HTMLElement, restartBtn:HTMLElement, log:HTMLElement}}
 */
function buildPanel(ctx, defs) {
  const panel = document.createElement('div');
  panel.className = 'ch-panel hidden';
  panel.innerHTML = `
    <div class="ch-head">
      <span class="ch-title">🏁 Challenges</span>
    </div>
    <div class="ch-body">
      <select class="ch-picker" title="Pick a challenge"></select>
      <div class="ch-section">Goals</div>
      <ol class="ch-goals"></ol>
      <div class="ch-section">Hints</div>
      <div class="ch-hints"></div>
      <button type="button" class="ch-btn ghost ch-hint-btn">💡 Show a hint</button>
      <div class="ch-log" aria-live="polite"></div>
    </div>
    <div class="ch-actions">
      <button type="button" class="ch-btn run">▶ Run</button>
      <button type="button" class="ch-btn stop">■ Stop</button>
      <button type="button" class="ch-btn ghost restart">↺ Restart</button>
    </div>
  `;

  const picker = /** @type {HTMLSelectElement} */ (panel.querySelector('.ch-picker'));
  for (const d of defs) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    picker.appendChild(opt);
  }

  const host = ctx.stage || document.body;
  host.appendChild(panel);

  return {
    panel,
    picker,
    blurb: panel.querySelector('.ch-blurb'),
    goals: panel.querySelector('.ch-goals'),
    hints: panel.querySelector('.ch-hints'),
    hintBtn: panel.querySelector('.ch-hint-btn'),
    runBtn: panel.querySelector('.ch-btn.run'),
    stopBtn: panel.querySelector('.ch-btn.stop'),
    restartBtn: panel.querySelector('.ch-btn.restart'),
    log: panel.querySelector('.ch-log'),
  };
}

/** Inject the panel styles once (matches css/sandbox.css: dark, accent #f5c518). */
function injectStyles() {
  if (document.getElementById('challenge-feature-styles')) return;
  const style = document.createElement('style');
  style.id = 'challenge-feature-styles';
  style.textContent = `
    .ch-panel {
      position: absolute;
      top: 12px;
      left: 12px;
      bottom: 12px;
      width: min(340px, 32vw);
      display: flex;
      flex-direction: column;
      background: var(--panel, #1c1f27);
      border: 1px solid var(--border-2, #3a4054);
      border-radius: var(--radius, 10px);
      box-shadow: var(--shadow, 0 6px 20px rgba(0,0,0,0.35));
      z-index: 8;
      overflow: hidden;
    }
    .ch-panel.hidden { display: none !important; }
    .ch-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: linear-gradient(180deg, #1f232d, var(--panel, #1c1f27));
      border-bottom: 1px solid var(--border, #2b3040);
    }
    .ch-title { font-weight: 800; letter-spacing: 0.2px; font-size: 14px; }
    .ch-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ch-picker {
      width: 100%;
      border: 1px solid var(--border-2, #3a4054);
      background: var(--panel-3, #2b3040);
      color: var(--text, #e7e9ee);
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
    }
    .ch-picker:hover { border-color: var(--accent-dim, #c99f14); }
    .ch-section {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--muted, #8a90a2);
      margin-top: 2px;
    }
    .ch-goals { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .ch-goal {
      position: relative;
      padding: 7px 10px 7px 30px;
      border: 1px solid var(--border, #2b3040);
      border-radius: 8px;
      background: var(--bg, #14161c);
      color: var(--text, #e7e9ee);
      font-size: 12.5px;
      line-height: 1.35;
    }
    .ch-goal::before {
      content: "○";
      position: absolute;
      left: 10px;
      top: 7px;
      color: var(--muted, #8a90a2);
      font-weight: 800;
    }
    .ch-goal.done {
      border-color: rgba(63,185,80,0.5);
      background: rgba(63,185,80,0.10);
      color: #cdefd3;
    }
    .ch-goal.done::before { content: "✔"; color: #3fb950; }
    .ch-hints { display: flex; flex-direction: column; gap: 6px; }
    .ch-hint {
      padding: 7px 10px;
      border: 1px dashed var(--border-2, #3a4054);
      border-radius: 8px;
      background: rgba(245,197,24,0.06);
      color: var(--text, #e7e9ee);
      font-size: 12px;
      line-height: 1.4;
    }
    .ch-log {
      margin-top: 4px;
      border-top: 1px solid var(--border, #2b3040);
      padding-top: 8px;
      font-family: "SFMono-Regular", "Consolas", "Liberation Mono", Menlo, monospace;
      font-size: 12px;
      line-height: 1.45;
      color: var(--muted, #8a90a2);
    }
    .ch-log-line { white-space: pre-wrap; word-break: break-word; }
    .ch-log-line.title { color: var(--accent, #f5c518); font-weight: 700; }
    .ch-log-line.done { color: #a6f0b3; }
    .ch-log-line.win { color: var(--accent, #f5c518); font-weight: 800; }
    .ch-actions {
      display: flex;
      gap: 8px;
      padding: 8px 10px;
      border-top: 1px solid var(--border, #2b3040);
      background: var(--panel-2, #232733);
    }
    .ch-btn {
      border: 1px solid var(--border-2, #3a4054);
      background: var(--panel-3, #2b3040);
      color: var(--text, #e7e9ee);
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
    }
    .ch-btn:hover { border-color: var(--accent-dim, #c99f14); }
    .ch-btn.run { background: rgba(63,185,80,0.16); border-color: rgba(63,185,80,0.5); color: #a6f0b3; }
    .ch-btn.stop { background: rgba(226,64,42,0.14); border-color: rgba(226,64,42,0.5); color: #f3a99e; }
    .ch-btn.ghost { background: transparent; color: var(--muted, #8a90a2); }
    .ch-btn:disabled { opacity: 0.45; cursor: default; }
    .ch-hint-btn { align-self: flex-start; }
    @media (max-width: 720px) {
      .ch-panel { width: auto; right: 12px; bottom: auto; max-height: 60%; }
    }
  `;
  document.head.appendChild(style);
}
