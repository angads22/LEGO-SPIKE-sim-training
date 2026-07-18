/**
 * DriveMode — manual keyboard driving for the MAIN app (MoSim-style practice).
 *
 * A deliberate toolbar toggle: while active, W/S (or ↑/↓) drive and A/D (or
 * ←/→) turn the robot through the normal engine command API, so the trail,
 * sensors, crates and challenge goals all behave exactly as they do under a
 * program. Hold Shift for slow precision driving. Driving and programs are
 * mutually exclusive: activating is refused while a program runs (isBlocked),
 * and app.js deactivates drive mode when ▶ Run starts.
 *
 * Robustness: key handling ignores editable targets (typing in the Python
 * editor never drives the robot), arrow keys don't scroll the page while
 * driving, and every engine call is guarded — a robot with no drive motors
 * logs one friendly line instead of throwing per frame.
 */

import { emit } from '../core/bus.js';

/** Keys that drive (code → channel). */
const KEY_CHANNEL = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

const FULL_PCT = 65;   // top speed, percent of the robot's max
const SLOW_PCT = 30;   // Shift held: precision speed
const TURN_MIX = 0.85; // how strongly turn keys skew the tank mix

/** True when the event targets something editable (editor, inputs, Blockly). */
function isEditableTarget(t) {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

export class DriveMode {
  /**
   * @param {import('../core/engine.js').Engine} engine
   * @param {{isBlocked?: () => boolean, onChange?: (active: boolean) => void}} [opts]
   *   isBlocked: return true to refuse activation (a program is running);
   *   onChange: notified after every activate/deactivate (button styling).
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this._isBlocked = opts.isBlocked || (() => false);
    this._onChange = opts.onChange || (() => {});
    this.active = false;
    /** @private held driving channels */
    this._held = new Set();
    this._shift = false;
    /** @private true while a non-zero tank target is set (brake idempotency) */
    this._moving = false;
    this._raf = 0;
    this._keydown = (e) => this._onKey(e, true);
    this._keyup = (e) => this._onKey(e, false);
    // Losing focus mid-drive (alt-tab) must not leave the robot running away.
    this._blur = () => { this._held.clear(); this._shift = false; };
  }

  /** Toggle; returns the new active state. */
  toggle() {
    if (this.active) this.deactivate();
    else this.activate();
    return this.active;
  }

  /** Start driving (no-op when blocked by a running program). */
  activate() {
    if (this.active) return;
    if (this._isBlocked()) {
      emit('log', { text: 'Stop the program first — then you can drive by hand.', level: 'info' });
      return;
    }
    this.active = true;
    this._held.clear();
    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
    window.addEventListener('blur', this._blur);
    emit('log', { text: '🎮 Drive mode — W/S or ↑/↓ to drive, A/D or ←/→ to turn, Shift = slow. Press 🎮 again to exit.', level: 'info' });
    const tick = () => {
      if (!this.active) return;
      this._apply();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    this._onChange(true);
  }

  /** Stop driving and brake. Safe to call repeatedly. */
  deactivate() {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
    window.removeEventListener('blur', this._blur);
    cancelAnimationFrame(this._raf);
    this._held.clear();
    this._brake();
    this._onChange(false);
  }

  // ------------------------------------------------------------ private

  /** @private keydown/keyup: track channels + Shift, swallow page scroll.
   *  Only keyDOWN respects editable targets — a keyUP must ALWAYS clear its
   *  channel, or releasing W with the caret in the editor (mid-drive click)
   *  would leave 'fwd' held and the robot running away. */
  _onKey(e, down) {
    if (e.key === 'Shift') {
      if (!down || !isEditableTarget(e.target)) this._shift = down;
      return;
    }
    const ch = KEY_CHANNEL[e.code];
    if (!ch) return;
    if (down) {
      if (isEditableTarget(e.target)) return; // typing, not driving
      e.preventDefault(); // arrows must not scroll the page while driving
      this._held.add(ch);
    } else {
      this._held.delete(ch);
    }
  }

  /** @private one frame: held keys → tank targets (or a hard brake) */
  _apply() {
    const drive = (this._held.has('fwd') ? 1 : 0) - (this._held.has('back') ? 1 : 0);
    const turn = (this._held.has('right') ? 1 : 0) - (this._held.has('left') ? 1 : 0);
    const base = this._shift ? SLOW_PCT : FULL_PCT;
    let l = (drive + turn * TURN_MIX) * base;
    let r = (drive - turn * TURN_MIX) * base;
    l = Math.max(-100, Math.min(100, l));
    r = Math.max(-100, Math.min(100, r));
    if (l === 0 && r === 0) {
      this._brake();
      return;
    }
    // moveStartTank just (re)sets target velocities — calling it every frame
    // with the same values is harmless, so no dedup bookkeeping is needed.
    try {
      this.engine.api.moveStartTank(l, r);
      this._moving = true;
    } catch (err) {
      this.deactivate();
      emit('log', { text: `Can't drive: ${(err && err.message) || err}. Check the Build tab.`, level: 'error' });
    }
  }

  /** @private stop the wheels once (idempotent, never throws) */
  _brake() {
    if (!this._moving) return;
    this._moving = false;
    try { this.engine.api.moveStop(); } catch { /* robot without drive motors */ }
  }
}
