/**
 * Race mode for SpikeSim v2 (AGENT-RACE).
 *
 * A plug-in feature module: `init(ctx)` self-injects a Race panel (track picker +
 * lap-count + Start/Stop), a race HUD (lap x/N, current/best/last lap time) and a
 * 3-2-1-GO countdown, then registers the 'race' mode and a per-frame lap timer.
 *
 * Lap detection: each frame the active vehicle's CENTRE is tested for a
 * segment-crossing of the next expected checkpoint (in order), and once every
 * checkpoint is passed, of the start/finish line — forward direction only, so a
 * wrong-way or wiggling crossing never counts. Crossing the line records the
 * split, updates best/last, and re-arms the checkpoints for the next lap (which
 * makes a double-count impossible). Reset restarts the race; a vehicle change
 * re-arms on the same track.
 *
 * Contract compliance: appends UI to ctx.stage (never touches index.html /
 * sandbox.js), shows it only in race mode (onEnter/onExit), matches css/sandbox
 * styling, never throws in the frame hook and never produces NaN. Start/finish +
 * checkpoint DECORATIONS are drawn by AGENT-VISUAL from the arena def; this module
 * only supplies the geometry (via tracks.js) and does the timing.
 */

import { raceTracks, computeGates, forwardCross } from './tracks.js';

/* ------------------------------------------------------------------ *
 * Styling (injected once, uses the shared css/sandbox.css variables)  *
 * ------------------------------------------------------------------ */

const STYLE_ID = 'race-feature-styles';
const CSS = `
.race-panel {
  position: absolute; top: 14px; right: 14px; z-index: 4;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; min-width: 184px;
  background: rgba(20,22,28,0.86);
  border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}
.race-panel-title { font-weight: 800; font-size: 14px; letter-spacing: 0.3px; display: flex; align-items: center; gap: 6px; }
.race-row { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
.race-row select {
  font-family: inherit; font-size: 13px; font-weight: 600; color: var(--text);
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px;
  text-transform: none; letter-spacing: 0;
}
.race-row select:focus { outline: none; border-color: var(--accent-dim); }
.race-actions { display: flex; gap: 8px; margin-top: 2px; }
.race-btn {
  flex: 1 1 auto; font-family: inherit; font-size: 13px; font-weight: 700;
  padding: 9px 10px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--panel-2); color: var(--text); cursor: pointer;
  transition: background 0.12s, border-color 0.12s, transform 0.05s;
}
.race-btn:hover { background: var(--panel-3); border-color: var(--border-2); }
.race-btn:active { transform: translateY(1px); }
.race-btn.primary { background: var(--accent); border-color: var(--accent-dim); color: #191207; }
.race-btn.primary:hover { background: #ffd23f; }
.race-btn:disabled { opacity: 0.45; cursor: default; transform: none; }

.race-hud {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 3;
  display: flex; align-items: center; gap: 14px;
  padding: 8px 18px; pointer-events: none;
  background: rgba(20,22,28,0.72);
  border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  font-variant-numeric: tabular-nums;
}
.race-hud .rh-block { display: flex; flex-direction: column; align-items: center; line-height: 1.05; }
.race-hud .rh-val { font-size: 19px; font-weight: 800; color: var(--text); }
.race-hud .rh-val.big { font-size: 25px; color: var(--accent); }
.race-hud .rh-lab { font-size: 9px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 3px; }
.race-hud .rh-sep { width: 1px; align-self: stretch; background: var(--border); }
.race-hud.flash { box-shadow: 0 0 0 2px var(--accent), var(--shadow); }

.race-count { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 5; pointer-events: none; }
.race-count > span {
  font-size: 120px; font-weight: 900; color: var(--accent);
  text-shadow: 0 6px 34px rgba(0,0,0,0.65);
  font-variant-numeric: tabular-nums;
}
.race-count > span.go { color: var(--go); }
.race-count.pop > span { animation: race-pop 0.42s ease-out; }
@keyframes race-pop { from { transform: scale(1.6); opacity: 0.15; } to { transform: scale(1); opacity: 1; } }

@media (max-width: 760px) {
  .race-panel { top: 10px; right: 10px; min-width: 150px; padding: 10px; }
  .race-hud { gap: 9px; padding: 6px 10px; }
  .race-hud .rh-val { font-size: 15px; }
  .race-hud .rh-val.big { font-size: 19px; }
  .race-count > span { font-size: 84px; }
}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ------------------------------------------------------------------ *
 * Helpers                                                              *
 * ------------------------------------------------------------------ */

/** Format seconds as "S.SS" or "M:SS.SS"; "--" for no time yet. */
function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) return '--';
  if (t < 60) return t.toFixed(2);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Feature init                                                         *
 * ------------------------------------------------------------------ */

/**
 * Initialise Race mode.
 * @param {object} ctx the sandbox extension context (see docs/SANDBOX.md)
 */
export function init(ctx) {
  if (!ctx || !ctx.stage) return;
  injectStyles();

  const tracks = raceTracks();
  if (!tracks.length) return;

  /* ---- UI: panel + HUD + countdown ---- */

  const panel = document.createElement('div');
  panel.className = 'race-panel hidden';
  panel.innerHTML = `
    <div class="race-panel-title">🏁 Race</div>
    <label class="race-row">Track
      <select class="race-track"></select>
    </label>
    <label class="race-row">Laps
      <select class="race-laps">
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3" selected>3</option>
        <option value="5">5</option>
        <option value="10">10</option>
      </select>
    </label>
    <div class="race-actions">
      <button type="button" class="race-btn primary race-start">Start</button>
      <button type="button" class="race-btn race-stop">Stop</button>
    </div>`;

  const hud = document.createElement('div');
  hud.className = 'race-hud hidden';
  hud.innerHTML = `
    <div class="rh-block"><span class="rh-val big"><span class="rh-lap">0</span>/<span class="rh-lapsN">3</span></span><span class="rh-lab">Lap</span></div>
    <div class="rh-sep"></div>
    <div class="rh-block"><span class="rh-val rh-cur">0.00</span><span class="rh-lab">Current</span></div>
    <div class="rh-sep"></div>
    <div class="rh-block"><span class="rh-val rh-best">--</span><span class="rh-lab">Best</span></div>
    <div class="rh-sep"></div>
    <div class="rh-block"><span class="rh-val rh-last">--</span><span class="rh-lab">Last</span></div>`;

  const count = document.createElement('div');
  count.className = 'race-count hidden';
  count.innerHTML = '<span class="rh-num">3</span>';

  ctx.stage.appendChild(panel);
  ctx.stage.appendChild(hud);
  ctx.stage.appendChild(count);

  const trackSel = panel.querySelector('.race-track');
  const lapsSel = panel.querySelector('.race-laps');
  const startBtn = panel.querySelector('.race-start');
  const stopBtn = panel.querySelector('.race-stop');
  const elLap = hud.querySelector('.rh-lap');
  const elLapsN = hud.querySelector('.rh-lapsN');
  const elCur = hud.querySelector('.rh-cur');
  const elBest = hud.querySelector('.rh-best');
  const elLast = hud.querySelector('.rh-last');
  const countNum = count.querySelector('.rh-num');

  for (const t of tracks) {
    const opt = document.createElement('option');
    opt.textContent = t.name;
    trackSel.appendChild(opt);
  }

  /* ---- State ---- */

  let selectedTrack = 0;
  let lapsTarget = 3;
  let gates = null;         // { finish, checkpoints } from computeGates

  let counting = false;     // 3-2-1-GO in progress
  let cdTimer = 0;          // seconds; >0 = number, (−0.8,0] = "GO"
  let racing = false;       // timing + lap detection active
  let lapCount = 0;
  let cpIndex = 0;          // next checkpoint to pass; === N means finish armed
  let curLap = 0;           // current lap elapsed (s)
  let bestLap = Infinity;
  let lastLap = 0;
  let lastPos = null;       // previous-frame vehicle centre
  let armingArena = false;  // guard against loadArena → vehicle-changed recursion
  let flashTimer = 0;

  /* ---- HUD ---- */

  function paintHud() {
    elLap.textContent = String(lapCount);
    elLapsN.textContent = String(lapsTarget);
    elCur.textContent = fmtTime(curLap);
    elBest.textContent = fmtTime(bestLap === Infinity ? -1 : bestLap);
    elLast.textContent = lastLap > 0 ? fmtTime(lastLap) : '--';
  }

  function showCount(text, isGo) {
    countNum.textContent = text;
    countNum.classList.toggle('go', !!isGo);
    count.classList.remove('hidden');
    // Restart the pop animation.
    count.classList.remove('pop');
    void count.offsetWidth;
    count.classList.add('pop');
  }
  function hideCount() { count.classList.add('hidden'); }

  /* ---- Race lifecycle ---- */

  /** Load the selected track's arena if it is not already the world arena. */
  function ensureTrackLoaded() {
    const track = tracks[selectedTrack];
    if (ctx.world && ctx.world.arena !== track.arena) {
      armingArena = true;
      try { ctx.loadArena(track.arena); } catch (_e) { /* never throw */ }
      armingArena = false;
    }
    gates = computeGates(ctx.world.arena);
  }

  /** Reset to a fresh idle state (no countdown, clock zeroed). */
  function armIdle() {
    counting = false;
    racing = false;
    cdTimer = 0;
    lapCount = 0;
    cpIndex = 0;
    curLap = 0;
    bestLap = Infinity;
    lastLap = 0;
    lastPos = null;
    hideCount();
    paintHud();
  }

  /** Begin a race: standing start, 3-2-1-GO countdown, then timing. */
  function startRace() {
    ensureTrackLoaded();
    // Place the vehicle at the track start for a clean standing start.
    const av = ctx.getActiveVehicle();
    if (av) { try { av.reset(); } catch (_e) { /* ignore */ } }
    counting = true;
    racing = false;
    cdTimer = 3.0;
    lapCount = 0;
    cpIndex = 0;
    curLap = 0;
    bestLap = Infinity;
    lastLap = 0;
    lastPos = null;
    paintHud();
    showCount('3', false);
  }

  /** Stop the race (freeze the HUD at its current values). */
  function stopRace() {
    counting = false;
    racing = false;
    hideCount();
    paintHud();
  }

  /** Transition from countdown into live timing. */
  function beginTiming() {
    racing = true;
    lapCount = 0;
    cpIndex = 0;
    curLap = 0;
    lastPos = null;
    paintHud();
  }

  /** A completed lap: record the split, update best/last, re-arm checkpoints. */
  function completeLap() {
    lapCount += 1;
    lastLap = curLap;
    if (lastLap < bestLap) bestLap = lastLap;
    curLap = 0;
    cpIndex = 0; // disarm the finish until every checkpoint is passed again
    flashTimer = 0.5;
    hud.classList.add('flash');
    paintHud();
    if (lapCount >= lapsTarget) {
      racing = false;
      counting = false;
      hideCount();
      ctx.showToast && ctx.showToast(`🏁 Finished — best lap ${fmtTime(bestLap)}`);
    } else {
      ctx.showToast && ctx.showToast(`Lap ${lapCount} — ${fmtTime(lastLap)}`);
    }
  }

  /** Test the vehicle centre motion for gate crossings this frame. */
  function detect() {
    const av = ctx.getActiveVehicle();
    if (!av || !gates) return;
    let st;
    try { st = av.getState(); } catch (_e) { return; }
    if (!st || !Number.isFinite(st.x) || !Number.isFinite(st.y)) return;
    const cur = { x: st.x, y: st.y };
    if (lastPos) {
      const cps = gates.checkpoints;
      // Advance through any checkpoints crossed this frame, in order.
      let guard = 0;
      while (cpIndex < cps.length && guard++ <= cps.length) {
        if (forwardCross(lastPos, cur, cps[cpIndex])) cpIndex += 1;
        else break;
      }
      if (cpIndex >= cps.length && forwardCross(lastPos, cur, gates.finish)) {
        completeLap();
      }
    }
    lastPos = cur;
  }

  /* ---- Per-frame hook (registered once; no-ops outside race mode) ---- */

  ctx.onFrame((dt) => {
    if (!ctx.getMode || ctx.getMode() !== 'race') return;
    let d = dt;
    if (!Number.isFinite(d) || d < 0) d = 0;
    if (d > 0.25) d = 0.25;

    if (flashTimer > 0) {
      flashTimer -= d;
      if (flashTimer <= 0) hud.classList.remove('flash');
    }

    if (counting) {
      const prev = cdTimer;
      cdTimer -= d;
      if (cdTimer > 0) {
        // Hold the car on the line during the countdown.
        const av = ctx.getActiveVehicle();
        if (av) { try { av.reset(); } catch (_e) { /* ignore */ } }
        const n = Math.ceil(cdTimer);
        if (Math.ceil(prev) !== n) showCount(String(n), false);
      } else {
        if (!racing) { beginTiming(); showCount('GO', true); }
        if (cdTimer <= -0.8) { counting = false; hideCount(); }
      }
    }

    if (racing) {
      curLap += d;
      detect();
      paintHud();
    }
  });

  /* ---- Mode registration ---- */

  ctx.registerMode('race', {
    onEnter() {
      panel.classList.remove('hidden');
      hud.classList.remove('hidden');
      // Reflect the current selections, load the track, arm an idle clock.
      trackSel.selectedIndex = selectedTrack;
      lapsSel.value = String(lapsTarget);
      ensureTrackLoaded();
      armIdle();
      if (ctx.fitCameras) ctx.fitCameras();
    },
    onExit() {
      stopRace();
      panel.classList.add('hidden');
      hud.classList.add('hidden');
      hideCount();
    },
  });

  /* ---- Controls ---- */

  trackSel.addEventListener('change', () => {
    selectedTrack = trackSel.selectedIndex;
    if (ctx.getMode() === 'race') {
      ensureTrackLoaded();
      armIdle();
      if (ctx.fitCameras) ctx.fitCameras();
    }
  });

  lapsSel.addEventListener('change', () => {
    const v = parseInt(lapsSel.value, 10);
    lapsTarget = Number.isFinite(v) && v > 0 ? v : 3;
    paintHud();
  });

  startBtn.addEventListener('click', () => { startRace(); if (startBtn.blur) startBtn.blur(); });
  stopBtn.addEventListener('click', () => { stopRace(); if (stopBtn.blur) stopBtn.blur(); });

  /* ---- Sandbox events ---- */

  // Reset (global ⟲) restarts an active race, or re-arms an idle clock.
  ctx.onExt('reset', () => {
    if (ctx.getMode() !== 'race') return;
    if (racing || counting) startRace();
    else armIdle();
  });

  // Vehicle change re-arms on the current track. The shell's vehicle switch may
  // have swapped the arena back to a drive arena, so reload the track first
  // (guarded so our own loadArena does not recurse).
  ctx.onExt('vehicle-changed', () => {
    if (ctx.getMode() !== 'race') return;
    if (armingArena) { gates = computeGates(ctx.world.arena); lastPos = null; return; }
    const wasActive = racing || counting;
    ensureTrackLoaded();
    if (wasActive) startRace();
    else armIdle();
  });
}
