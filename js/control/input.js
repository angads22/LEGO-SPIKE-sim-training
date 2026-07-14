/**
 * InputManager — keyboard + gamepad + on-screen (virtual) input for the
 * SpikeSim v2 physics sandbox.
 *
 * Produces a fresh normalized `ControlInput` each frame via {@link InputManager#poll}.
 * The manager owns a held-keys set (updated by window keydown/keyup), polls the
 * Gamepad API defensively, and merges on-screen pedal/button state fed through
 * {@link InputManager#setVirtual} / {@link InputManager#bindButton}.
 *
 * Coordinate/steer conventions (must match js/vehicles):
 *  - Car:  steer > 0 turns RIGHT (D / ArrowRight = +1, A / ArrowLeft = -1).
 *          throttle drives forward, brake slows then reverses.
 *  - Robot: differential drive. drive = forward(W) - reverse(S), turn = steer.
 *          leftTrack  = drive + turn, rightTrack = drive - turn. So W+A curves
 *          LEFT (right track faster => CCW), matching the contract.
 *  - Slot: throttle-only steering-wise; throttle from W/Up/Space, brake from
 *          S/Down (needed to brake into the hairpin instead of flying off).
 *
 * Robustness: never throws inside poll()/listeners; all state is finite; when
 * `enabled` is false poll() returns a neutral (all-zero) ControlInput.
 */

/**
 * @typedef {Object} ControlInput
 * @property {number} throttle  -1..1 (forward for car/slot)
 * @property {number} brake     0..1
 * @property {number} steer     -1..1
 * @property {number} handbrake 0..1
 * @property {number} boost     0..1
 * @property {number} leftTrack  -1..1 (robot)
 * @property {number} rightTrack -1..1 (robot)
 */

/** Gamepad stick deadzone (ignore drift below this magnitude). */
const DEADZONE = 0.15;

/** Physical key codes we swallow to stop the page scrolling while driving. */
const PREVENT_DEFAULT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);

/** Field names accepted by setVirtual/bindButton. */
const VIRTUAL_FIELDS = new Set([
  'throttle', 'brake', 'steer', 'handbrake', 'boost', 'leftTrack', 'rightTrack',
]);

/** A neutral control input (all zero). @returns {ControlInput} */
function neutralControl() {
  return { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0, leftTrack: 0, rightTrack: 0 };
}

/**
 * Clamp v into [lo, hi]; non-finite becomes lo.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Manages driving input for the active vehicle. One instance is shared by the
 * app; call {@link InputManager#setScheme} whenever the active vehicle changes.
 */
export class InputManager {
  /**
   * @param {EventTarget} [targetEl] optional element (kept for callers; key
   *   events are always bound on window so driving works regardless of focus
   *   target).
   */
  constructor(targetEl) {
    /** Optional host element (not required for key input). */
    this.targetEl = targetEl || null;
    /** Whether poll() produces live input. Public per contract. @type {boolean} */
    this.enabled = true;

    /** @type {'car'|'robot'|'slot'} */
    this._scheme = 'car';
    /** Physical key codes currently held. @type {Set<string>} */
    this._keys = new Set();
    /** On-screen / injected field values. @type {Record<string,number>} */
    this._virtual = {};
    /** Bound button listener records for destroy(). @type {Array<{el:EventTarget,onDown:Function,onUp:Function}>} */
    this._bound = [];

    /** @type {(Window & typeof globalThis)|null} */
    this._win = (typeof window !== 'undefined') ? window : null;

    this._onKeyDown = (e) => {
      const code = e && e.code;
      if (!code) return;
      this._keys.add(code);
      // Only stop the page scrolling for the driving keys, and never override
      // real shortcuts (Ctrl/Meta/Alt combos).
      if (this.enabled && PREVENT_DEFAULT.has(code) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        try { e.preventDefault(); } catch (_e) { /* ignore */ }
      }
    };
    this._onKeyUp = (e) => {
      if (e && e.code) this._keys.delete(e.code);
    };
    // Releasing all keys on blur avoids "stuck throttle" when focus is lost
    // mid-press (alt-tab, devtools, etc.).
    this._onBlur = () => { this._keys.clear(); };

    if (this._win) {
      this._win.addEventListener('keydown', this._onKeyDown);
      this._win.addEventListener('keyup', this._onKeyUp);
      this._win.addEventListener('blur', this._onBlur);
    }
  }

  /**
   * Choose the key/gamepad mapping for the active vehicle type. Accepts the
   * three scheme names and the vehicle type aliases.
   * @param {'car'|'robot'|'slot'|'racecar'|'slotcar'} type
   * @returns {'car'|'robot'|'slot'} the normalized scheme
   */
  setScheme(type) {
    const t = String(type == null ? '' : type).toLowerCase();
    if (t === 'robot') this._scheme = 'robot';
    else if (t === 'slot' || t === 'slotcar') this._scheme = 'slot';
    else this._scheme = 'car'; // 'car', 'racecar', unknown -> car
    return this._scheme;
  }

  /** @returns {'car'|'robot'|'slot'} the current scheme. */
  getScheme() { return this._scheme; }

  /**
   * Inject on-screen / touch input for a ControlInput field. For car/slot the
   * logical fields (throttle/brake/steer/handbrake/boost) feed the same mixer as
   * the keyboard, so generic pedals work in every scheme; robot also honours
   * direct leftTrack/rightTrack. Values are clamped when consumed in poll().
   * @param {string} field one of throttle|brake|steer|handbrake|boost|leftTrack|rightTrack
   * @param {number} value
   */
  setVirtual(field, value) {
    if (!VIRTUAL_FIELDS.has(field)) return;
    this._virtual[field] = Number.isFinite(value) ? value : 0;
  }

  /**
   * Wire a DOM element (on-screen pedal/button) to a virtual field: pressing it
   * sets the field to `value`, releasing resets it to 0. Pointer events cover
   * both mouse and touch. Returns an unbind function.
   * @param {EventTarget} el
   * @param {string} field
   * @param {number} [value=1]
   * @returns {() => void} unbind
   */
  bindButton(el, field, value) {
    if (!el || typeof el.addEventListener !== 'function' || !VIRTUAL_FIELDS.has(field)) {
      return () => {};
    }
    const v = Number.isFinite(value) ? value : 1;
    const onDown = (e) => {
      try { if (e && e.cancelable) e.preventDefault(); } catch (_e) { /* ignore */ }
      this.setVirtual(field, v);
    };
    const onUp = () => { this.setVirtual(field, 0); };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onUp);
    el.addEventListener('pointercancel', onUp);

    const rec = { el, onDown, onUp };
    this._bound.push(rec);

    return () => {
      try {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointerleave', onUp);
        el.removeEventListener('pointercancel', onUp);
      } catch (_e) { /* ignore */ }
      this.setVirtual(field, 0);
      const idx = this._bound.indexOf(rec);
      if (idx !== -1) this._bound.splice(idx, 1);
    };
  }

  /**
   * Read the first connected gamepad into normalized axes/buttons. Defensive:
   * returns null when no Gamepad API, no controller, or on any error.
   * @returns {{lx:number,ly:number,rx:number,ry:number,a:number,b:number,lt:number,rt:number}|null}
   * @private
   */
  _readGamepad() {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
        return null;
      }
      const pads = navigator.getGamepads();
      if (!pads) return null;
      let gp = null;
      for (let i = 0; i < pads.length; i++) {
        if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
      }
      if (!gp) return null;

      const ax = gp.axes || [];
      const bt = gp.buttons || [];
      const dz = (val) => {
        const n = Number(val);
        return (Number.isFinite(n) && Math.abs(n) > DEADZONE) ? clamp(n, -1, 1) : 0;
      };
      const btnVal = (i) => {
        const b = bt[i];
        if (!b) return 0;
        const val = (typeof b.value === 'number') ? b.value : (b.pressed ? 1 : 0);
        return Number.isFinite(val) ? clamp(val, 0, 1) : 0;
      };
      return {
        lx: dz(ax[0]),   // left stick X
        ly: dz(ax[1]),   // left stick Y (up = negative)
        rx: dz(ax[2]),   // right stick X
        ry: dz(ax[3]),   // right stick Y
        a: btnVal(0),    // A / cross
        b: btnVal(1),    // B / circle
        lt: btnVal(6),   // left trigger
        rt: btnVal(7),   // right trigger
      };
    } catch (_e) {
      return null;
    }
  }

  /**
   * Compute this frame's ControlInput from keyboard + gamepad + virtual input.
   * Always returns a fresh, fully-populated, finite object; neutral when the
   * manager is disabled. Never throws.
   * @returns {ControlInput}
   */
  poll() {
    const out = neutralControl();
    if (!this.enabled) return out;

    const scheme = this._scheme;
    const down = (c) => this._keys.has(c);

    // --- Logical axes (shared mixer): forward throttle, brake, steer, etc. ---
    let thr = 0;    // 0..1 forward
    let brk = 0;    // 0..1 brake / reverse
    let steer = 0;  // -1..1 (+ = right)
    let hb = 0;     // 0..1 handbrake
    let boost = 0;  // 0..1 boost
    let vLeft = 0;  // direct robot track override (virtual)
    let vRight = 0;

    // Keyboard.
    if (scheme === 'slot') {
      if (down('KeyW') || down('ArrowUp') || down('Space')) thr += 1;
      if (down('KeyS') || down('ArrowDown')) brk += 1;
    } else {
      // car + robot share the WASD/arrow layout for drive + steer.
      if (down('KeyW') || down('ArrowUp')) thr += 1;
      if (down('KeyS') || down('ArrowDown')) brk += 1;
      if (down('KeyD') || down('ArrowRight')) steer += 1;
      if (down('KeyA') || down('ArrowLeft')) steer -= 1;
      if (scheme === 'car') {
        if (down('Space')) hb += 1;
        if (down('ShiftLeft') || down('ShiftRight')) boost += 1;
      }
    }

    // Gamepad (adds onto keyboard; user won't fight both).
    const pad = this._readGamepad();
    if (pad) {
      if (scheme === 'car') {
        steer += pad.lx;                    // left stick X -> steer
        thr += Math.max(pad.rt, pad.a);     // RT / A -> throttle
        brk += Math.max(pad.lt, pad.b);     // LT / B -> brake
      } else if (scheme === 'robot') {
        const drive = -pad.ly;              // left stick Y up = forward
        if (drive > 0) thr += drive; else brk += -drive;
        steer += pad.rx + (pad.rt - pad.lt); // right stick X or triggers -> turn
      } else { // slot
        thr += Math.max(pad.rt, pad.a);
        brk += Math.max(pad.lt, pad.b);
      }
    }

    // Virtual (on-screen pedals / injected fields).
    const vm = this._virtual;
    thr += vm.throttle || 0;
    brk += vm.brake || 0;
    steer += vm.steer || 0;
    hb += vm.handbrake || 0;
    boost += vm.boost || 0;
    vLeft += vm.leftTrack || 0;
    vRight += vm.rightTrack || 0;

    // Clamp logical axes.
    thr = clamp(thr, 0, 1);
    brk = clamp(brk, 0, 1);
    steer = clamp(steer, -1, 1);
    hb = clamp(hb, 0, 1);
    boost = clamp(boost, 0, 1);

    // --- Map logical axes to the scheme's ControlInput fields. ---
    if (scheme === 'robot') {
      const drive = thr - brk;   // forward minus reverse
      const turn = steer;        // + = right (left track faster)
      out.leftTrack = clamp(drive + turn + vLeft, -1, 1);
      out.rightTrack = clamp(drive - turn + vRight, -1, 1);
    } else if (scheme === 'slot') {
      out.throttle = thr;        // throttle-only steering; brake allowed
      out.brake = brk;
    } else { // car
      out.throttle = thr;
      out.brake = brk;
      out.steer = steer;
      out.handbrake = hb;
      out.boost = boost;
    }

    return out;
  }

  /** Remove all listeners and clear state. Safe to call once. */
  destroy() {
    if (this._win) {
      try {
        this._win.removeEventListener('keydown', this._onKeyDown);
        this._win.removeEventListener('keyup', this._onKeyUp);
        this._win.removeEventListener('blur', this._onBlur);
      } catch (_e) { /* ignore */ }
    }
    for (const rec of this._bound.slice()) {
      try {
        rec.el.removeEventListener('pointerdown', rec.onDown);
        rec.el.removeEventListener('pointerup', rec.onUp);
        rec.el.removeEventListener('pointerleave', rec.onUp);
        rec.el.removeEventListener('pointercancel', rec.onUp);
      } catch (_e) { /* ignore */ }
    }
    this._bound.length = 0;
    this._keys.clear();
    this._virtual = {};
    this.enabled = false;
  }
}
