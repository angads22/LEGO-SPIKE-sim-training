/**
 * SpikeSim challenge system (v1.1) — loads challenge JSONs from challenges/,
 * applies their robot + map + starter code, and watches the live engine state
 * with a 500 ms goal checker. Interfaces per docs/CONTRACT.md (AGENT-CHALLENGE);
 * authoring guide (schema + "ask Claude" workflow) in CHALLENGES.md.
 *
 * Design notes:
 * - Goals are LATCHED: once a goal is met it stays checked (and is logged once)
 *   until 'sim-reset' re-arms everything, so a crate drifting back out of a bin
 *   after delivery doesn't un-complete the run.
 * - The checker survives map switches on purpose: if the current map lacks the
 *   challenge's labelled zones the goals simply never complete. Picking a
 *   different challenge (or the blank entry) stops/replaces the checker.
 * - Movable crates are matched by color NAME: the crate's hex fill is snapped
 *   to the nearest SPIKE color anchor (same anchors as the engine's color
 *   sensor, duplicated here because engine.js does not export them).
 */

import { emit, on } from '../core/bus.js';

/**
 * RGB anchors for snapping a hex color to a SPIKE color name.
 * MUST stay in sync with SPIKE_COLOR_RGB in js/core/engine.js.
 */
const SPIKE_COLOR_RGB = [
  { name: 'black', r: 15, g: 15, b: 18 },
  { name: 'violet', r: 145, g: 70, b: 210 },
  { name: 'blue', r: 40, g: 80, b: 220 },
  { name: 'azure', r: 90, g: 185, b: 235 },
  { name: 'green', r: 60, g: 165, b: 75 },
  { name: 'yellow', r: 250, g: 205, b: 50 },
  { name: 'red', r: 215, g: 60, b: 55 },
  { name: 'white', r: 245, g: 245, b: 240 },
];

const CHECK_MS = 500; // goal-checker cadence (per contract)
const HINT_VALUE = '__hint__'; // reserved <option> value for "next hint"

/**
 * Parse '#rgb' or '#rrggbb' into {r,g,b}.
 * @param {string} hex CSS hex color
 * @returns {{r:number,g:number,b:number}|null} null when unparsable
 */
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Snap a hex color to the nearest SPIKE color name ('black'…'white').
 * @param {string} hex CSS hex color (e.g. a crate's fill)
 * @returns {string|null} SPIKE color name, or null when hex is unparsable
 */
export function snapHexToSpike(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  let best = null;
  let bestD = Infinity;
  for (const c of SPIKE_COLOR_RGB) {
    const dr = rgb.r - c.r;
    const dg = rgb.g - c.g;
    const db = rgb.b - c.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = c.name; }
  }
  return best;
}

/** Point-in-zone test (zone = {x,y,w,h}, edges inclusive). */
function insideRect(zone, x, y) {
  return x >= zone.x && x <= zone.x + zone.w && y >= zone.y && y <= zone.y + zone.h;
}

/** Human description for a goal that has no label. */
function describeGoal(g) {
  if (g.type === 'movable-in-zone') return `Push the ${g.color} crate into the ${g.zone}`;
  if (g.type === 'robot-in-zone') return `Drive the robot into the ${g.zone}`;
  return String(g.type || 'goal');
}

/**
 * Loads the challenge index into a <select>, applies a picked challenge
 * (robot → map → starter code → Python tab), and runs the goal checker.
 */
export class ChallengeManager {
  /**
   * @param {import('../core/engine.js').Engine} engine
   * @param {{selectEl: HTMLSelectElement,
   *          setMap: (json: object) => void,
   *          setRobot: (json: object) => void,
   *          setPython: (code: string) => void,
   *          activatePythonTab: () => void}} hooks app.js glue callbacks
   */
  constructor(engine, hooks) {
    this.engine = engine;
    this.hooks = hooks || {};
    /** @private {Array<{file:string,name:string,blurb?:string}>} */
    this._challenges = [];
    /** @private the active challenge JSON (null when none) */
    this._active = null;
    /** @private */
    this._activeFile = '';
    /** @private setInterval id (0 when stopped) */
    this._timer = 0;
    /** @private latched per-goal flags (index-aligned with goals) */
    this._satisfied = [];
    /** @private true once 🏆 was logged for this arm-cycle */
    this._done = false;
    /** @private how many hints were revealed so far */
    this._hintsShown = 0;
    // Re-arm on every sim reset so the next attempt re-logs its ✔s. The
    // subscription lives as long as the app; _rearm is a no-op when idle.
    on('sim-reset', () => this._rearm());
  }

  /**
   * Fetch challenges/index.json, fill the select's options, wire onchange.
   * @returns {Promise<void>}
   */
  async loadIndex() {
    const res = await fetch('challenges/index.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const idx = await res.json();
    this._challenges = Array.isArray(idx.challenges) ? idx.challenges : [];
    const sel = this.hooks.selectEl;
    if (!sel) return;
    this._rebuildOptions();
    sel.onchange = () => this._onSelect(sel.value);
  }

  /** Stop the goal checker and drop the active challenge. */
  clear() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = 0;
    }
    this._active = null;
    this._activeFile = '';
    this._satisfied = [];
    this._done = false;
    this._hintsShown = 0;
    this._rebuildOptions();
  }

  /**
   * Log the next hint for the active challenge. Reachable from the dropdown's
   * "💡 Next hint" entry and from the console: spikesim.challenges.hint().
   */
  hint() {
    const hints = (this._active && this._active.hints) || [];
    if (!this._active || !hints.length) {
      emit('log', { text: 'No challenge hints available — pick a challenge first.', level: 'info' });
      return;
    }
    if (this._hintsShown >= hints.length) {
      emit('log', { text: '💡 That was the last hint — you have everything you need. Experiment!', level: 'info' });
      return;
    }
    const i = this._hintsShown++;
    emit('log', { text: `💡 Hint ${i + 1}/${hints.length}: ${hints[i]}`, level: 'info' });
    this._rebuildOptions(); // refresh the "(n/6)" counter on the hint entry
  }

  /**
   * Live snapshot for UI overlays (match HUD): the active challenge's name and
   * per-goal done flags. Cheap to call every frame.
   * @returns {{active: boolean, name: string, goals: Array<{label: string, done: boolean}>, done: boolean}}
   */
  getStatus() {
    const ch = this._active;
    if (!ch) return { active: false, name: '', goals: [], done: false };
    const goals = (ch.goals || []).map((g, i) => ({
      label: g.label || describeGoal(g),
      done: !!this._satisfied[i],
    }));
    return { active: true, name: ch.name || this._activeFile, goals, done: this._done };
  }

  // ------------------------------------------------------------ private

  /**
   * @private Rebuild the select's options: blank entry, one per challenge,
   * plus a "next hint" pseudo-entry while a challenge with hints is active.
   */
  _rebuildOptions() {
    const sel = this.hooks.selectEl;
    if (!sel) return;
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Pick a challenge…';
    sel.appendChild(blank);
    for (const c of this._challenges) {
      const opt = document.createElement('option');
      opt.value = c.file;
      opt.textContent = c.name;
      if (c.blurb) opt.title = c.blurb;
      sel.appendChild(opt);
    }
    const hints = (this._active && this._active.hints) || [];
    if (this._active && hints.length) {
      const opt = document.createElement('option');
      opt.value = HINT_VALUE;
      const next = Math.min(this._hintsShown + 1, hints.length);
      opt.textContent = `💡 Next hint (${next}/${hints.length})`;
      sel.appendChild(opt);
    }
    sel.value = this._activeFile;
  }

  /** @private select onchange: blank clears, hint entry logs, file starts. */
  _onSelect(value) {
    const sel = this.hooks.selectEl;
    if (value === HINT_VALUE) {
      if (sel) sel.value = this._activeFile; // snap back to the challenge entry
      this.hint();
      return;
    }
    if (!value) {
      if (this._active) emit('log', { text: 'Challenge cleared.', level: 'info' });
      this.clear();
      return;
    }
    this._startFromFile(value).catch((err) => {
      emit('log', { text: `Could not load challenge (${err.message})`, level: 'error' });
      if (sel) sel.value = this._activeFile;
    });
  }

  /** @private fetch challenges/<file> and start it */
  async _startFromFile(file) {
    const res = await fetch(`challenges/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    this._start(await res.json(), file);
  }

  /**
   * @private Replace any running challenge: apply robot → map → starter code
   * → Python tab, log the brief + goals + hint teaser, start the checker.
   */
  _start(ch, file) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = 0;
    }
    this._active = ch;
    this._activeFile = file;
    this._hintsShown = 0;
    this._done = false;
    this._satisfied = new Array((ch.goals || []).length).fill(false);

    const h = this.hooks;
    if (ch.robot && h.setRobot) h.setRobot(ch.robot);
    if (ch.map && h.setMap) h.setMap(ch.map); // loadMap → reset() → 'sim-reset' (goals already fresh)
    if (typeof ch.starterCode === 'string' && h.setPython) h.setPython(ch.starterCode);
    if (h.activatePythonTab) h.activatePythonTab();

    emit('log', { text: `🚩 Challenge: ${ch.name || file}`, level: 'info' });
    for (const line of String(ch.brief || ch.blurb || '').split('\n')) {
      if (line.trim()) emit('log', { text: line, level: 'info' });
    }
    (ch.goals || []).forEach((g, i) => {
      emit('log', { text: `  ${i + 1}. ${g.label || describeGoal(g)}`, level: 'info' });
    });
    if ((ch.hints || []).length) {
      emit('log', {
        text: `💡 ${ch.hints.length} hints ready — pick “💡 Next hint” in the Challenge menu when stuck.`,
        level: 'info',
      });
    }
    this._rebuildOptions();
    this._timer = setInterval(() => this._check(), CHECK_MS);
  }

  /** @private 'sim-reset': un-latch all goals so they re-log next attempt. */
  _rearm() {
    if (!this._active) return;
    this._satisfied.fill(false);
    this._done = false;
  }

  /** @private one checker tick: latch newly-met goals, detect completion. */
  _check() {
    const ch = this._active;
    if (!ch) return;
    const goals = ch.goals || [];
    if (!goals.length) return;
    const st = this.engine.getState();
    if (!st || !st.map) return;
    let all = true;
    for (let i = 0; i < goals.length; i++) {
      if (!this._satisfied[i] && this._goalMet(goals[i], st)) {
        this._satisfied[i] = true; // latched until the next sim-reset
        emit('log', { text: `✔ ${goals[i].label || describeGoal(goals[i])}`, level: 'user' });
      }
      if (!this._satisfied[i]) all = false;
    }
    if (all && !this._done) {
      this._done = true;
      emit('log', { text: '🏆 CHALLENGE COMPLETE!', level: 'user' });
      emit('beep', { freq: 880, sec: 0.4 });
    }
  }

  /**
   * @private Is one goal currently satisfied? Zones are matched by label in
   * the CURRENT map; a missing zone simply returns false (map was switched).
   */
  _goalMet(goal, st) {
    const zone = (st.map.zones || []).find((z) => z.label === goal.zone);
    if (!zone) return false;
    if (goal.type === 'robot-in-zone') {
      return insideRect(zone, st.pose.x, st.pose.y);
    }
    if (goal.type === 'movable-in-zone') {
      const movs = st.movables || [];
      return movs.some((m) => snapHexToSpike(m.color) === goal.color
        && insideRect(zone, m.x + m.w / 2, m.y + m.h / 2));
    }
    return false;
  }
}
