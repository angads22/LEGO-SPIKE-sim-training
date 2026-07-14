/**
 * code.js — AGENT-CODE feature module: SPIKE-3 Python coding for the PHYSICS
 * robot, via the vendored Pyodide (real CPython in WASM). Exports `init(ctx)`.
 *
 * What it does:
 *  - Registers a 'code' mode (onEnter: switch to the robot + show a code panel;
 *    onExit: hide it + stop any running program).
 *  - Injects a #mode-code button into the toolbar and wires it to ctx.setMode.
 *  - The panel has a Python editor (SPIKE-3 starter), Run / Stop, and a console.
 *  - Pyodide loads once, lazily, on the first Run. A JS bridge (`_sim`) is
 *    registered and the SPIKE-3 module set (hub / runloop / motor_pair /
 *    distance_sensor) is defined so a kid-style program drives the real robot.
 *  - A RobotController (robotapi.js) is driven every frame by a ctx.onFrame hook
 *    (runs AFTER input, so code wins) — closed-loop so the momentum-y physics
 *    robot actually reaches its distance/heading targets.
 *
 * Robustness: Stop halts promptly; Python errors show with a line number; the
 * internal stop sentinel is never shown to the user. Never breaks Drive mode
 * (the frame hook no-ops unless a program is running).
 */

import { loadPyodide } from '../../vendor/pyodide/pyodide.mjs';
import { RobotControl } from '../robot/control.js';
import {
  SpikeRuntime, createBridge, PY_BOOTSTRAP,
  DEFAULT_PROGRAM, EXAMPLES,
} from '../robot/spike_py.js';

/**
 * @param {object} ctx the sandbox extension context
 */
export function init(ctx) {
  // The runtime wraps a RobotControl (js/robot/control.js). It is rebound to the
  // active robot at the start of each run so a vehicle swap is always safe.
  const runtime = new SpikeRuntime(null);

  // Drive the robot every frame WHILE a program runs (no-ops otherwise, so
  // Drive mode and the keyboard are never affected).
  ctx.onFrame((dt) => { try { runtime.tick(dt); } catch (_e) { /* never throw */ } });

  injectStyles();
  const ui = buildPanel(ctx);
  injectToolbarButton(ctx);

  /* ---------------- Pyodide (lazy, once) ---------------- */

  let pyodide = null;
  let pyReady = null;   // in-flight load Promise
  let running = false;  // a user program is currently executing

  async function ensurePyodide() {
    if (pyodide) return pyodide;
    if (pyReady) return pyReady;
    setStatus('loading');
    writeln('Loading Python runtime… (first run reads the local Pyodide, please wait)');
    pyReady = (async () => {
      const indexURL = new URL('../../vendor/pyodide/', import.meta.url).href;
      const py = await loadPyodide({
        indexURL,
        stdout: (s) => writeln(s),
        stderr: (s) => writeln(s, 'err'),
      });
      py.registerJsModule('_sim', createBridge(runtime, { print: (m) => writeln(m) }));
      py.runPython(PY_BOOTSTRAP);
      pyodide = py;
      return py;
    })();
    try {
      await pyReady;
      writeln('Python ready.');
    } catch (e) {
      pyReady = null;
      setStatus('idle');
      writeln('Could not load Python: ' + (e && e.message ? e.message : e), 'err');
      throw e;
    }
    return pyodide;
  }

  /* ---------------- Run / Stop ---------------- */

  async function runProgram() {
    if (running) return;
    let py;
    try { py = await ensurePyodide(); } catch (_e) { return; }

    // Bind the runtime's RobotControl to the CURRENT active robot. Code mode's
    // onEnter already selects the robot; guard anyway so we never drive a car.
    let vehicle = null;
    try { vehicle = ctx.getActiveVehicle(); } catch (_e) { vehicle = null; }
    if (!vehicle || (vehicle.spec && vehicle.spec.type !== 'robot')) {
      try { ctx.selectVehicle('robot'); vehicle = ctx.getActiveVehicle(); } catch (_e) { /* ignore */ }
    }
    if (!vehicle) { writeln('No robot to run — switch to the robot first.', 'err'); return; }
    try { runtime.setControl(new RobotControl(vehicle, ctx.world)); } catch (e) {
      writeln('Could not attach to the robot: ' + (e && e.message ? e.message : e), 'err');
      return;
    }

    running = true;
    ui.runBtn.disabled = true;
    ui.stopBtn.disabled = false;
    setStatus('running');
    runtime.begin();
    const src = ui.editor.value;
    try {
      py.globals.set('__USER_SRC__', src);
      await py.runPythonAsync('await __run_user_program(__USER_SRC__)');
      writeln('■ Program finished.');
    } catch (e) {
      reportError(e);
    } finally {
      runtime.end();
      running = false;
      ui.runBtn.disabled = false;
      ui.stopBtn.disabled = true;
      setStatus('idle');
    }
  }

  function stopProgram() {
    if (!running) { runtime.end(); return; }
    runtime.halt();
    writeln('■ Stopped.');
  }

  /**
   * Show a Python error with the offending program line. The stop sentinel and
   * SpikeStop are treated as a clean stop and never shown as an error.
   */
  function reportError(e) {
    const msg = e && e.message !== undefined ? String(e.message) : String(e);
    if (msg.indexOf('SpikeStop') !== -1 || msg.indexOf('SIM_STOPPED') !== -1) return;
    let lineNo = null;
    const re = /File "<program>", line (\d+)/g;
    let m; let last = null;
    while ((m = re.exec(msg)) !== null) last = m;
    if (last) lineNo = last[1];
    const lines = msg.replace(/\s+$/, '').split('\n');
    const summary = lines[lines.length - 1] || 'Error';
    writeln(lineNo ? `Error on line ${lineNo}: ${summary}` : summary, 'err');
  }

  /* ---------------- Console helpers ---------------- */

  function writeln(text, cls) {
    const line = document.createElement('div');
    line.className = 'code-line' + (cls === 'err' ? ' err' : '');
    line.textContent = text == null ? '' : String(text);
    ui.consoleEl.appendChild(line);
    // Keep the console from growing without bound.
    while (ui.consoleEl.childNodes.length > 400) ui.consoleEl.removeChild(ui.consoleEl.firstChild);
    ui.consoleEl.scrollTop = ui.consoleEl.scrollHeight;
  }

  function setStatus(state) {
    const map = { idle: ['Ready', 'idle'], loading: ['Loading…', 'loading'], running: ['Running', 'running'] };
    const [label, cls] = map[state] || map.idle;
    ui.status.textContent = label;
    ui.status.className = 'code-status ' + cls;
  }

  /* ---------------- Wiring ---------------- */

  ui.runBtn.addEventListener('click', () => { runProgram(); });
  ui.stopBtn.addEventListener('click', () => { stopProgram(); });
  ui.clearBtn.addEventListener('click', () => { ui.consoleEl.textContent = ''; });
  ui.stopBtn.disabled = true;
  setStatus('idle');

  /* ---------------- Public hook for other features (Challenges) ---------------- */

  // Downstream features (e.g. AGENT-CHALLENGES) drive the code panel through this
  // small API instead of poking the DOM. setProgram() fills the editor textarea;
  // run()/stop() trigger the exact same logic as the Run/Stop buttons (Pyodide
  // load, robot bind, frame-hook motion, prompt Stop). Safe to call any time; a
  // second run() while a program is running is a no-op (running guard).
  //
  //   ctx.code.setProgram(srcString)  -> load SPIKE-3 source into the editor
  //   ctx.code.run()                  -> run the current editor program
  //   ctx.code.stop()                 -> stop a running program promptly
  //   ctx.code.getProgram()           -> current editor source (string)
  ctx.code = {
    setProgram(src) {
      if (typeof src === 'string') ui.editor.value = src;
      return ctx.code;
    },
    getProgram() { return ui.editor.value; },
    run() { runProgram(); },
    stop() { stopProgram(); },
  };

  /* ---------------- Mode registration ---------------- */

  ctx.registerMode('code', {
    onEnter: () => {
      // The robot is the coded vehicle. Disable the keyboard so typing code
      // never drives the robot; the panel becomes visible.
      try { ctx.selectVehicle('robot'); } catch (_e) { /* ignore */ }
      if (ctx.input) ctx.input.enabled = false;
      ui.panel.classList.remove('hidden');
    },
    onExit: () => {
      stopProgram();
      if (ctx.input) ctx.input.enabled = true;
      ui.panel.classList.add('hidden');
    },
  });
}

/* ------------------------------------------------------------------ */
/* UI construction                                                     */
/* ------------------------------------------------------------------ */

/** Inject the #mode-code toolbar button next to the other mode buttons. */
function injectToolbarButton(ctx) {
  if (!ctx.toolbar || document.getElementById('mode-code')) return;
  const btn = document.createElement('button');
  btn.id = 'mode-code';
  btn.className = 'mode-btn';
  btn.type = 'button';
  btn.title = 'Code the robot in Python (SPIKE 3)';
  btn.textContent = 'Code';
  const modes = ctx.toolbar.querySelector('.modes');
  if (modes) modes.appendChild(btn);
  else ctx.toolbar.appendChild(btn);
  btn.addEventListener('click', () => { ctx.setMode('code'); if (btn.blur) btn.blur(); });
}

/**
 * Build the code panel (editor + Run/Stop + console), appended to the stage and
 * hidden until code mode is active.
 * @returns {{panel:HTMLElement, editor:HTMLTextAreaElement, runBtn:HTMLElement, stopBtn:HTMLElement, clearBtn:HTMLElement, consoleEl:HTMLElement, status:HTMLElement}}
 */
function buildPanel(ctx) {
  const panel = document.createElement('div');
  panel.className = 'code-panel hidden';
  panel.innerHTML = `
    <div class="code-head">
      <span class="code-title">🐍 Python — Robot</span>
      <span class="code-status idle">Ready</span>
    </div>
    <textarea class="code-editor" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
    <div class="code-actions">
      <button type="button" class="code-btn run">▶ Run</button>
      <button type="button" class="code-btn stop">■ Stop</button>
      <button type="button" class="code-btn ghost clear">Clear</button>
      <select class="code-examples" title="Load an example program">
        <option value="__default__">Examples…</option>
      </select>
    </div>
    <div class="code-console" aria-live="polite"></div>
  `;

  const editor = /** @type {HTMLTextAreaElement} */ (panel.querySelector('.code-editor'));
  editor.value = DEFAULT_PROGRAM;

  // Populate the examples picker and load the chosen program into the editor.
  const picker = /** @type {HTMLSelectElement} */ (panel.querySelector('.code-examples'));
  for (const name of Object.keys(EXAMPLES)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    picker.appendChild(opt);
  }
  picker.addEventListener('change', () => {
    const src = picker.value === '__default__' ? DEFAULT_PROGRAM : EXAMPLES[picker.value];
    if (src) editor.value = src;
    picker.value = '__default__';
    editor.focus();
  });

  // Keep keystrokes inside the editor: never let WASD/arrows reach the driving
  // InputManager (it listens on window). Tab inserts spaces for Python.
  const swallow = (e) => e.stopPropagation();
  editor.addEventListener('keydown', (e) => {
    swallow(e);
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = editor.selectionStart;
      const t = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '    ' + editor.value.slice(t);
      editor.selectionStart = editor.selectionEnd = s + 4;
    }
  });
  editor.addEventListener('keyup', swallow);
  editor.addEventListener('keypress', swallow);

  const host = ctx.stage || document.body;
  host.appendChild(panel);

  return {
    panel,
    editor,
    runBtn: panel.querySelector('.code-btn.run'),
    stopBtn: panel.querySelector('.code-btn.stop'),
    clearBtn: panel.querySelector('.code-btn.clear'),
    consoleEl: panel.querySelector('.code-console'),
    status: panel.querySelector('.code-status'),
  };
}

/** Inject the panel styles once (matches css/sandbox.css: dark, accent #f5c518). */
function injectStyles() {
  if (document.getElementById('code-feature-styles')) return;
  const style = document.createElement('style');
  style.id = 'code-feature-styles';
  style.textContent = `
    .code-panel {
      position: absolute;
      top: 12px;
      right: 12px;
      bottom: 12px;
      width: min(460px, 44vw);
      display: flex;
      flex-direction: column;
      background: var(--panel, #1c1f27);
      border: 1px solid var(--border-2, #3a4054);
      border-radius: var(--radius, 10px);
      box-shadow: var(--shadow, 0 6px 20px rgba(0,0,0,0.35));
      z-index: 8;
      overflow: hidden;
    }
    .code-panel.hidden { display: none !important; }
    .code-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: linear-gradient(180deg, #1f232d, var(--panel, #1c1f27));
      border-bottom: 1px solid var(--border, #2b3040);
    }
    .code-title { font-weight: 800; letter-spacing: 0.2px; font-size: 14px; }
    .code-status {
      font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px;
      color: var(--muted, #8a90a2); background: var(--bg, #14161c);
      border: 1px solid var(--border, #2b3040);
    }
    .code-status.running { color: #a6f0b3; border-color: rgba(63,185,80,0.5); }
    .code-status.loading { color: var(--accent, #f5c518); border-color: var(--accent-dim, #c99f14); }
    .code-editor {
      flex: 1 1 60%;
      resize: none;
      border: 0;
      outline: none;
      padding: 12px;
      margin: 0;
      background: var(--bg, #14161c);
      color: var(--text, #e7e9ee);
      font-family: "SFMono-Regular", "Consolas", "Liberation Mono", Menlo, monospace;
      font-size: 13px;
      line-height: 1.5;
      tab-size: 4;
      white-space: pre;
      overflow: auto;
    }
    .code-actions {
      display: flex;
      gap: 8px;
      padding: 8px 10px;
      border-top: 1px solid var(--border, #2b3040);
      border-bottom: 1px solid var(--border, #2b3040);
      background: var(--panel-2, #232733);
    }
    .code-btn {
      border: 1px solid var(--border-2, #3a4054);
      background: var(--panel-3, #2b3040);
      color: var(--text, #e7e9ee);
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
    }
    .code-btn:hover { border-color: var(--accent-dim, #c99f14); }
    .code-btn.run { background: rgba(63,185,80,0.16); border-color: rgba(63,185,80,0.5); color: #a6f0b3; }
    .code-btn.stop { background: rgba(226,64,42,0.14); border-color: rgba(226,64,42,0.5); color: #f3a99e; }
    .code-btn.ghost { background: transparent; color: var(--muted, #8a90a2); }
    .code-btn:disabled { opacity: 0.45; cursor: default; }
    .code-examples {
      margin-left: auto;
      border: 1px solid var(--border-2, #3a4054);
      background: var(--panel-3, #2b3040);
      color: var(--text, #e7e9ee);
      padding: 7px 10px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
    }
    .code-examples:hover { border-color: var(--accent-dim, #c99f14); }
    .code-console {
      flex: 1 1 40%;
      min-height: 90px;
      overflow: auto;
      padding: 10px 12px;
      background: var(--bg, #14161c);
      font-family: "SFMono-Regular", "Consolas", "Liberation Mono", Menlo, monospace;
      font-size: 12.5px;
      line-height: 1.45;
    }
    .code-line { white-space: pre-wrap; word-break: break-word; color: var(--text, #e7e9ee); }
    .code-line.err { color: #f3a99e; }
    @media (max-width: 720px) {
      .code-panel { width: auto; left: 12px; }
    }
  `;
  document.head.appendChild(style);
}
