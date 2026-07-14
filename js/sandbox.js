/**
 * SpikeSim v2 — sandbox shell / app entry (AGENT-SHELL).
 *
 * Wires the physics core, the 2D/3D views and the input manager into a single
 * running app: build a PhysicsWorld, drop in a default arena + race car, and run
 * a native requestAnimationFrame loop that steps physics at a fixed timestep,
 * feeds normalized controls to the active vehicle, and renders the active view.
 *
 * Golden rules honored here:
 *  - Rendering never mutates physics (we only read getState()).
 *  - The loop pauses on document.hidden and resumes WITHOUT a giant catch-up
 *    (the dt clock is reset on resume; world.step also clamps big hitches).
 *  - The frame body is wrapped in try/catch that logs once — one bad frame can
 *    never kill the loop, and we never throw / never NaN in the hot path.
 *  - All cross-module calls (views/input built in parallel to the same contract)
 *    are defensively guarded so a missing optional method never crashes boot.
 *
 * Debug handle: `window.sandbox = { world, activeVehicle:()=>.., arena2d, arena3d }`.
 */

import { PhysicsWorld } from './core/world.js';
import { defaultArena, slotOvalArena, robotMatArena } from './core/arenas.js';
import { createVehicle, presetVehicles } from './vehicles/index.js';
import { Arena2D } from './view/arena2d.js';
import { Arena3D } from './view/arena3d.js';
import { InputManager } from './control/input.js';
import { init as initBuild } from './build/build.js';
import { init as initRace } from './race/race.js';
import { init as initCode } from './code/code.js';
import { init as initChallenges } from './challenges/challenges.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Get an element by id (may be null; callers guard). @returns {HTMLElement|null} */
const $ = (id) => document.getElementById(id);

/**
 * Call an optional method on an object, swallowing any error. Lets the shell
 * cooperate with view/input modules whose optional APIs may not all be present.
 * @param {any} obj
 * @param {string} method
 * @param {...any} args
 * @returns {any}
 */
function safe(obj, method, ...args) {
  try {
    if (obj && typeof obj[method] === 'function') return obj[method](...args);
  } catch (e) {
    if (!safe._logged) { console.warn(`[sandbox] ${method}() failed`, e); safe._logged = true; }
  }
  return undefined;
}

/** The home arena a vehicle type drops into by default. @returns {object} arena def */
function arenaForType(type) {
  if (type === 'robot') return robotMatArena();
  if (type === 'slotcar') return slotOvalArena();
  return defaultArena();
}

/** Map a vehicle spec.type to an InputManager scheme. @returns {'car'|'robot'|'slot'} */
function schemeFor(type) {
  if (type === 'robot') return 'robot';
  if (type === 'slotcar') return 'slot';
  return 'car';
}

/* ------------------------------------------------------------------ */
/* Pedal → control-field maps (per input scheme)                        */
/* Each logical pedal injects one or more [field, value] pairs via      */
/* InputManager.setVirtual(). Robot pedals drive both tracks for a       */
/* differential feel; slot car ignores steering.                         */
/* ------------------------------------------------------------------ */

/** @type {Record<string, Record<string, Array<[string, number]>>>} */
const PEDAL_MAPS = {
  car: {
    throttle: [['throttle', 1]],
    brake: [['brake', 1]],
    left: [['steer', -1]],
    right: [['steer', 1]],
  },
  slot: {
    throttle: [['throttle', 1]],
    brake: [['brake', 1]],
    left: [],
    right: [],
  },
  robot: {
    throttle: [['leftTrack', 1], ['rightTrack', 1]],
    brake: [['leftTrack', -1], ['rightTrack', -1]],
    left: [['leftTrack', -1], ['rightTrack', 1]],
    right: [['leftTrack', 1], ['rightTrack', -1]],
  },
};

const ALL_VIRTUAL_FIELDS = ['throttle', 'brake', 'steer', 'handbrake', 'boost', 'leftTrack', 'rightTrack'];

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  const canvas = $('canvas-2d');
  const host3d = $('view3d-host');
  const stage = $('stage');

  // --- Core physics + views + input -------------------------------------
  const world = new PhysicsWorld();
  world.loadArena(defaultArena()); // give views an arena before construction

  const arena2d = new Arena2D(canvas, world);
  const arena3d = new Arena3D(host3d, world);
  const input = new InputManager(stage || document.body);

  // Preset specs keyed by type for the vehicle picker.
  const presets = {};
  try {
    for (const s of presetVehicles()) presets[s.type] = s;
  } catch (_e) { /* fall back to inline specs below */ }
  const specFor = (type) => presets[type] || { type };

  /** @type {import('./vehicles/vehicle.js').Vehicle|null} */
  let activeVehicle = null;
  let activeType = 'racecar';
  let activeSpec = null;
  let currentArena = null;
  let currentScheme = 'car';
  let currentTab = '2d';
  let followOn = true;

  /* ---------------- Extension framework (Stage 2 plug-ins) ---------------- */
  // Feature modules (Build, Race, Code) register a mode and/or per-frame hooks
  // and event listeners through the `ctx` object, so the shell stays the single
  // owner of the loop and vehicle lifecycle. Built-in mode: 'drive'.

  /** name → { onEnter?, onExit?, label? }. @type {Record<string, object>} */
  const modeHandlers = { drive: {} };
  /** per-frame update fns: (dt, activeVehicle) => void. @type {Array<Function>} */
  const frameHooks = [];
  /** event listeners: name → fns. @type {Record<string, Array<Function>>} */
  const extListeners = {};

  /** Register (or replace) a mode's enter/exit handlers (called by feature inits). */
  function registerMode(name, handlers) { modeHandlers[name] = handlers || {}; }
  /** Add a per-frame update hook (Race lap timing, etc.). Returns an unregister fn. */
  function onFrame(fn) { if (typeof fn === 'function') frameHooks.push(fn); return () => { const i = frameHooks.indexOf(fn); if (i >= 0) frameHooks.splice(i, 1); }; }
  /** Subscribe to a sandbox event ('vehicle-changed','mode-changed','reset'). */
  function onExt(name, fn) { (extListeners[name] || (extListeners[name] = [])).push(fn); }
  /** Emit a sandbox event to extension listeners. */
  function emitExt(name, payload) { for (const fn of (extListeners[name] || [])) { try { fn(payload); } catch (e) { console.warn('[sandbox] ext listener', name, e); } } }

  /* ---------------- Vehicle switching ---------------- */

  /**
   * Instantly switch the active vehicle: destroy the old one, load the arena the
   * new vehicle needs (slot car → oval, else the open speedway), create it at the
   * arena start, set the input scheme, hand it to both views and refit the camera.
   * @param {'racecar'|'robot'|'slotcar'} type
   */
  function selectVehicle(type) {
    return loadVehicleSpec(specFor(type));
  }

  /**
   * Create the active vehicle from ANY spec (a preset OR a custom build from the
   * Build mode). Loads the arena the vehicle needs (or opts.arena), places it at
   * the arena start, sets input scheme, hands it to both views, refits the camera.
   * @param {object} spec vehicle spec ({type, ...tunables})
   * @param {{arena?: object, pose?: object}} [opts]
   * @returns {import('./vehicles/vehicle.js').Vehicle|null}
   */
  function loadVehicleSpec(spec, opts) {
    opts = opts || {};
    const type = (spec && spec.type) || 'racecar';

    // Destroy the old vehicle explicitly (loadArena also clears vehicles).
    if (activeVehicle) { safe(world, 'removeVehicle', activeVehicle); activeVehicle = null; }

    // Load the arena this vehicle needs (override wins, e.g. a race track/challenge).
    // Otherwise pick the vehicle's home arena by type: robot → SPIKE mat, slot → oval, else speedway.
    const arena = opts.arena || arenaForType(type);
    world.loadArena(arena);
    currentArena = arena;

    // Create at the given/arena start pose and register it.
    try {
      activeVehicle = createVehicle(world, spec, opts.pose || arena.start);
      world.addVehicle(activeVehicle);
    } catch (e) {
      console.error('[sandbox] failed to create vehicle', type, e);
      activeVehicle = null;
    }
    activeType = type;
    activeSpec = spec;

    // Input scheme + pedal mapping, and clear any stuck virtual inputs.
    currentScheme = schemeFor(type);
    safe(input, 'setScheme', currentScheme);
    clearVirtual();

    // Hand the active vehicle to both views (optional API — guarded).
    safe(arena2d, 'setActiveVehicle', activeVehicle);
    safe(arena3d, 'setActiveVehicle', activeVehicle);

    // Refit + follow, and let extensions (Race, etc.) react to the new vehicle.
    applyFollow();
    fitCameras();
    updateVehicleButtons();
    emitExt('vehicle-changed', activeVehicle);
    return activeVehicle;
  }

  /**
   * Load an arena (used by Race mode to swap in a track) and re-place the active
   * vehicle at its start. Keeps the current vehicle spec.
   * @param {object} arenaDef
   */
  function loadArena(arenaDef) {
    if (!arenaDef) return;
    loadVehicleSpec(activeSpec || specFor(activeType), { arena: arenaDef });
  }

  function updateVehicleButtons() {
    const map = { racecar: 'veh-racecar', robot: 'veh-robot', slotcar: 'veh-slotcar' };
    for (const [t, id] of Object.entries(map)) {
      const el = $(id);
      if (el) el.classList.toggle('active', t === activeType);
    }
  }

  /* ---------------- Camera / view ---------------- */

  function fitCameras() {
    if (currentTab === '2d') { safe(arena2d, 'fitArena'); return; }
    // 3D: use an optional fit if the view offers one; otherwise the chase cam frames it.
    if (arena3d && typeof arena3d.fitArena === 'function') safe(arena3d, 'fitArena');
    else if (arena3d && typeof arena3d.fit === 'function') safe(arena3d, 'fit');
  }

  function applyFollow() {
    safe(arena2d, 'setFollow', followOn);
    safe(arena3d, 'setFollow', followOn);
    const btn = $('btn-follow');
    if (btn) btn.classList.toggle('active', followOn);
  }

  /**
   * Switch the visible view. 2D renders from the rAF loop; 3D self-drives via its
   * own setAnimationLoop, so we only activate/deactivate it here.
   * @param {'2d'|'3d'} tab
   */
  function setTab(tab) {
    currentTab = tab;
    const on2d = tab === '2d';
    if (canvas) canvas.classList.toggle('hidden', !on2d);
    if (host3d) host3d.classList.toggle('hidden', on2d);
    $('tab-2d') && $('tab-2d').classList.toggle('active', on2d);
    $('tab-3d') && $('tab-3d').classList.toggle('active', !on2d);
    if (on2d) {
      safe(arena3d, 'deactivate');
      safe(arena2d, 'resize');
      safe(arena2d, 'render');
    } else {
      safe(arena3d, 'activate');
      safe(arena3d, 'resize');
    }
    fitCameras();
  }

  /* ---------------- On-screen pedals ---------------- */

  /** Zero every virtual input field (used on vehicle switch / release). */
  function clearVirtual() {
    for (const f of ALL_VIRTUAL_FIELDS) safe(input, 'setVirtual', f, 0);
  }

  /**
   * Wire a pedal button to inject/clear virtual control values on press/release.
   * Uses pointer events so touch + mouse both work and drag-off releases cleanly.
   * @param {string} id element id
   * @param {string} logical pedal name (key into PEDAL_MAPS[scheme])
   */
  function wirePedal(id, logical) {
    const el = $(id);
    if (!el) return;
    let held = false;
    const pairsNow = () => (PEDAL_MAPS[currentScheme] && PEDAL_MAPS[currentScheme][logical]) || [];
    const press = (ev) => {
      ev.preventDefault();
      held = true;
      el.classList.add('held');
      for (const [field, value] of pairsNow()) safe(input, 'setVirtual', field, value);
    };
    const release = () => {
      if (!held) return;
      held = false;
      el.classList.remove('held');
      for (const [field] of pairsNow()) safe(input, 'setVirtual', field, 0);
    };
    el.addEventListener('pointerdown', (ev) => { try { el.setPointerCapture(ev.pointerId); } catch (_e) {} press(ev); });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  wirePedal('pedal-throttle', 'throttle');
  wirePedal('pedal-brake', 'brake');
  wirePedal('pedal-left', 'left');
  wirePedal('pedal-right', 'right');

  /* ---------------- Toast ---------------- */

  let toastTimer = 0;
  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  /* ---------------- HUD ---------------- */

  const hudKmh = $('hud-kmh');
  const hudMps = $('hud-mps');
  const hudFlag = $('hud-flag');
  function updateHud() {
    let mps = 0;
    let crashed = false;
    if (activeVehicle) {
      try {
        const st = activeVehicle.getState();
        if (st) {
          if (Number.isFinite(st.speedMps)) mps = st.speedMps;
          crashed = !!(st.extra && st.extra.crashed);
        }
      } catch (_e) { /* keep last */ }
    }
    if (hudKmh) hudKmh.textContent = String(Math.round(mps * 3.6));
    if (hudMps) hudMps.textContent = mps.toFixed(1);
    if (hudFlag) hudFlag.classList.toggle('hidden', !crashed);
  }

  /* ---------------- Toolbar wiring ---------------- */

  const bindClick = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener('click', (ev) => {
      fn(ev);
      if (el.blur) el.blur(); // keep keyboard focus off buttons so Space=drift, arrows=drive
    });
  };

  // Vehicle picker — one click, instant switch.
  bindClick('veh-racecar', () => selectVehicle('racecar'));
  bindClick('veh-robot', () => selectVehicle('robot'));
  bindClick('veh-slotcar', () => selectVehicle('slotcar'));

  // Modes: 'drive' is built in; Build/Race/Code register their handlers via ctx.
  // A mode with no registered handler shows a friendly toast and stays put.
  bindClick('mode-drive', () => setMode('drive'));
  bindClick('mode-build', () => setMode('build'));
  bindClick('mode-race', () => setMode('race'));
  bindClick('mode-code', () => setMode('code')); // button injected by the Code feature (may be absent)

  let currentMode = 'drive';
  const prettyMode = (m) => m.charAt(0).toUpperCase() + m.slice(1);

  /**
   * Switch app mode. 'drive' is built in; other modes must be registered by a
   * feature (ctx.registerMode). Runs the previous mode's onExit and the new
   * mode's onEnter, updates the toolbar, and shows pedals only in Drive.
   * @param {string} mode
   */
  function setMode(mode) {
    if (!modeHandlers[mode]) { showToast(`${prettyMode(mode)} mode is on the way — coming soon`); return; }
    if (mode === currentMode) return;
    safe(modeHandlers[currentMode], 'onExit', ctx);
    currentMode = mode;
    const pedals = $('pedals');
    if (pedals) pedals.classList.toggle('hidden', mode !== 'drive');
    document.querySelectorAll('[id^="mode-"]').forEach((el) => el.classList.toggle('active', el.id === `mode-${mode}`));
    safe(modeHandlers[mode], 'onEnter', ctx);
    emitExt('mode-changed', mode);
  }

  // Reset re-places the vehicle at the start.
  bindClick('btn-reset', () => { safe(world, 'reset'); clearVirtual(); emitExt('reset'); });

  // View tabs.
  bindClick('tab-2d', () => setTab('2d'));
  bindClick('tab-3d', () => setTab('3d'));

  // Camera.
  bindClick('btn-fit', () => fitCameras());
  bindClick('btn-follow', () => { followOn = !followOn; applyFollow(); });

  // Hide the desktop hint once the user starts driving.
  let hintHidden = false;
  const dismissHint = () => {
    if (hintHidden) return;
    hintHidden = true;
    const h = $('hint');
    if (h) { h.style.opacity = '0'; setTimeout(() => h.classList.add('hidden'), 600); }
  };
  window.addEventListener('keydown', dismissHint, { once: true });
  window.addEventListener('pointerdown', dismissHint, { once: true });

  /* ---------------- Resize ---------------- */

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (resizeTimer) cancelAnimationFrame(resizeTimer);
    resizeTimer = requestAnimationFrame(() => {
      safe(arena2d, 'resize');
      safe(arena3d, 'resize');
    });
  });

  /* ---------------- Pause / resume ---------------- */

  let paused = document.hidden === true;
  let lastT = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      paused = true;
    } else {
      // Resume clean: reset the dt clock so there is NO giant catch-up step.
      paused = false;
      lastT = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    }
  });

  /* ---------------- The loop ---------------- */

  let rafId = 0;
  let frameErrLogged = false;

  /**
   * One simulation+render iteration (physics → controls → extension hooks →
   * render → HUD). Extracted from the rAF loop so it can also be driven
   * deterministically (tests / headless via window.sandbox._step).
   * @param {number} dt seconds since the previous step
   */
  function stepOnce(dt) {
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.25) dt = 0.25; // safety net (world.step clamps too)

    // 1) Advance physics (fixed-timestep accumulator lives in world.step).
    world.step(dt);

    // 2) Read this frame's controls and hand them to the active vehicle.
    const ci = safe(input, 'poll');
    if (activeVehicle && ci) activeVehicle.applyControls(ci);

    // 3) Per-frame extension hooks (Race lap timing, Code stepping, …).
    for (const hook of frameHooks) { try { hook(dt, activeVehicle); } catch (e) { if (!frameErrLogged) { console.error('[sandbox] frame hook', e); frameErrLogged = true; } } }

    // 4) Render the active view (3D self-renders via its own animation loop).
    if (currentTab === '2d') safe(arena2d, 'render');

    // 5) HUD.
    updateHud();
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    try {
      if (paused) { lastT = now; return; }
      const dt = (now - lastT) / 1000;
      lastT = now;
      stepOnce(dt);
    } catch (e) {
      if (!frameErrLogged) { console.error('[sandbox] frame error (loop continues)', e); frameErrLogged = true; }
    }
  }

  /* ---------------- Go ---------------- */

  // Extension context handed to every Stage-2 feature module (Build/Race/Code).
  // Feature modules build their own UI and plug into the loop/vehicle lifecycle
  // through this object — the shell stays the single owner of both.
  const ctx = {
    world,
    arena2d,
    arena3d,
    input,
    stage,
    toolbar: $('toolbar'),
    // vehicle lifecycle
    getActiveVehicle: () => activeVehicle,
    getActiveSpec: () => activeSpec,
    getActiveType: () => activeType,
    selectVehicle,
    loadVehicleSpec,
    loadArena,
    presetSpec: specFor,
    arenas: { defaultArena, slotOvalArena },
    // modes + loop
    registerMode,
    setMode,
    getMode: () => currentMode,
    onFrame,
    onExt,
    // misc
    showToast,
    fitCameras,
    setInputScheme: (s) => { currentScheme = s; safe(input, 'setScheme', s); },
  };

  initExtensions(ctx);

  setMode('drive');
  setTab('2d');
  selectVehicle('robot'); // SPIKE robot is the centerpiece — default vehicle, on its mat
  rafId = requestAnimationFrame(frame);

  // Debug handle for the orchestrator / console.
  window.sandbox = {
    world,
    activeVehicle: () => activeVehicle,
    arena2d,
    arena3d,
    input,
    selectVehicle,
    loadVehicleSpec,
    ctx,
    setMode,
    _step: stepOnce, // drive one loop iteration deterministically (tests)
    _stop: () => cancelAnimationFrame(rafId),
  };
}

/**
 * Initialize Stage-2 feature modules (Build / Race / Code / visual extras).
 * Each feature is a module exporting `init(ctx)` that self-injects its UI and
 * registers its mode + frame hooks. Wired here after the modules are built;
 * a missing/failing feature never blocks boot (each call is guarded).
 * @param {object} ctx the sandbox extension context
 */
function initExtensions(ctx) {
  for (const feature of SANDBOX_FEATURES) {
    try { feature(ctx); } catch (e) { console.error('[sandbox] feature init failed', e); }
  }
}

/**
 * Feature init functions (Stage-2 plug-in modules). Each is `init(ctx)`:
 * Build shop, Race mode, and Code-the-robot. A failing feature never blocks boot.
 * @type {Array<(ctx: object) => void>}
 */
const SANDBOX_FEATURES = [initBuild, initRace, initCode, initChallenges];

// Boot once the DOM is ready. Never throw out of module scope.
try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
} catch (e) {
  console.error('[sandbox] boot failed', e);
}
