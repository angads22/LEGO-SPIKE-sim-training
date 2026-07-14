/**
 * robotapi.js — a closed-loop controller that drives the PHYSICS robot vehicle
 * (js/vehicles/robot.js) from code, plus the SPIKE-3 Python glue that the Code
 * feature (code.js) loads into Pyodide. No DOM here — pure logic so it can be
 * unit-verified in Node with the real Pyodide (see the scratch harness).
 *
 * The robot is differential drive with momentum: applying a track force does not
 * stop instantly, so every primitive is CLOSED-LOOP — it drives toward a target
 * (distance from odometry, heading from the gyro angle) and tapers/brakes as it
 * arrives, then resolves its Promise. A single `tick(dt)` (called every frame by
 * code.js's registered ctx.onFrame hook, AFTER input so code wins) advances the
 * current motion and issues the actual applyControls({leftTrack,rightTrack}).
 *
 * Sign conventions (match robot.js):
 *  - planck angle is CCW-positive. leftTrack=+ / rightTrack=- spins CLOCKWISE
 *    (angle DECREASES). So turnDeg(+deg) turns clockwise by convention here.
 *  - forward is local +x; heading vector is (cos angle, sin angle).
 */

const MAX_RANGE_M = 5;        // distance-sensor ray length
const FRONT_OFFSET_M = 0.16;  // start the ray just ahead of the chassis
const MOTION_TIMEOUT_S = 25;  // safety: never let a blocked motion hang forever
const STOP = 'SIM_STOPPED';   // internal stop sentinel (never shown to the user)

/** Clamp to 0..1. @returns {number} */
function clamp01(v) { v = Number(v); if (!Number.isFinite(v)) return 0; return v < 0 ? 0 : v > 1 ? 1 : v; }
/** Clamp to -1..1. @returns {number} */
function clampSigned(v) { v = Number(v); if (!Number.isFinite(v)) return 0; return v < -1 ? -1 : v > 1 ? 1 : v; }

/**
 * Controller over the active physics robot. Construct once; it always reads the
 * CURRENT active vehicle via ctx.getActiveVehicle() so a vehicle swap is safe.
 */
export class RobotController {
  /** @param {object} ctx the sandbox extension context (world, getActiveVehicle, ...) */
  constructor(ctx) {
    this.ctx = ctx;
    /** running while a program owns the robot. tick() no-ops otherwise. */
    this.running = false;
    /** current blocking motion: { step(dt)->{l,r,done}, resolve, reject, t } | null */
    this._motion = null;
    /** persistent open-loop tracks from setTracks()/start() when no motion runs. */
    this._hold = { l: 0, r: 0 };
    /** pending sleep timers → their reject fns, so halt() can cancel them. */
    this._timers = new Map();
  }

  /** The active physics vehicle (the robot) or null. */
  vehicle() {
    try { return this.ctx.getActiveVehicle(); } catch (_e) { return null; }
  }

  /** Read a safe state snapshot ({x,y,angleRad,speedMps,wheels}). */
  getState() {
    const v = this.vehicle();
    if (!v || typeof v.getState !== 'function') return { x: 0, y: 0, angleRad: 0, speedMps: 0, wheels: [] };
    try {
      const s = v.getState();
      return {
        x: Number.isFinite(s.x) ? s.x : 0,
        y: Number.isFinite(s.y) ? s.y : 0,
        angleRad: Number.isFinite(s.angleRad) ? s.angleRad : 0,
        speedMps: Number.isFinite(s.speedMps) ? s.speedMps : 0,
        wheels: s.wheels || [],
      };
    } catch (_e) {
      return { x: 0, y: 0, angleRad: 0, speedMps: 0, wheels: [] };
    }
  }

  /** Begin owning the robot for a program run. */
  begin() {
    this.running = true;
    this._motion = null;
    this._hold = { l: 0, r: 0 };
    this._clearTimers(false);
  }

  /** End a run cleanly: zero the tracks, drop any motion. */
  end() {
    this.running = false;
    this._motion = null;
    this._hold = { l: 0, r: 0 };
    this._clearTimers(false);
    this._apply(0, 0);
  }

  /**
   * Halt a running program PROMPTLY: reject the in-flight motion + any sleeps
   * with the stop sentinel (Python turns it into a clean stop), zero the tracks.
   */
  halt() {
    this.running = false;
    const m = this._motion;
    this._motion = null;
    this._hold = { l: 0, r: 0 };
    this._clearTimers(true);
    this._apply(0, 0);
    if (m) { try { m.reject(new Error(STOP)); } catch (_e) { /* ignore */ } }
  }

  /** Apply track commands to the active vehicle (full neutral control + tracks). */
  _apply(l, r) {
    const v = this.vehicle();
    if (!v || typeof v.applyControls !== 'function') return;
    try {
      v.applyControls({
        throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0,
        leftTrack: clampSigned(l), rightTrack: clampSigned(r),
      });
    } catch (_e) { /* never throw in a frame hook */ }
  }

  /**
   * Advance the current motion by dt and issue this frame's control. Called by
   * code.js's ctx.onFrame hook. No-ops unless a program is running.
   * @param {number} dt seconds
   */
  tick(dt) {
    if (!this.running) return;
    const v = this.vehicle();
    if (!v) return;
    dt = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
    const m = this._motion;
    if (m) {
      m.t += dt;
      let out;
      try {
        out = m.step(dt);
      } catch (e) {
        this._motion = null;
        this._apply(0, 0);
        try { m.reject(e instanceof Error ? e : new Error(String(e))); } catch (_e) { /* ignore */ }
        return;
      }
      if (!out) out = { l: 0, r: 0, done: false };
      if (m.t >= MOTION_TIMEOUT_S) out.done = true; // safety net
      this._apply(out.l, out.r);
      if (out.done) {
        this._motion = null;
        this._hold = { l: 0, r: 0 };
        try { m.resolve(); } catch (_e) { /* ignore */ }
      }
    } else {
      this._apply(this._hold.l, this._hold.r);
    }
  }

  /** Start a blocking closed-loop motion; returns a Promise resolved on arrival. */
  _startMotion(stepFn) {
    if (!this.running) return Promise.reject(new Error(STOP));
    return new Promise((resolve, reject) => {
      this._motion = { step: stepFn, resolve, reject, t: 0 };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Async primitives                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Drive straight for `cm` centimetres at track fraction `speed` (0..1).
   * Odometry = accumulated position delta; tapers to a stop as it arrives.
   * @param {number} cm distance (negative = reverse)
   * @param {number} [speed] 0..1 track fraction
   * @returns {Promise<void>}
   */
  driveForCm(cm, speed) {
    const target = Math.abs(Number(cm) || 0) / 100;
    const dir = (Number(cm) || 0) >= 0 ? 1 : -1;
    const sp = clamp01(Number.isFinite(speed) ? speed : 0.4) || 0.4;
    const st = this.getState();
    // Progress is the SIGNED displacement projected onto the START heading, so
    // residual/backward drift subtracts instead of counting as progress (raw
    // magnitude would let a drive "finish" while sliding backward).
    const hx = Math.cos(st.angleRad);
    const hy = Math.sin(st.angleRad);
    let last = { x: st.x, y: st.y };
    let traveled = 0;
    let settle = 0;
    const tol = 0.006;
    const KP = 10; // track command per metre of error (saturates to sp)
    return this._startMotion(() => {
      const s = this.getState();
      const proj = (s.x - last.x) * hx + (s.y - last.y) * hy;
      last = { x: s.x, y: s.y };
      traveled += dir * proj; // signed forward progress in the commanded direction
      const err = target - traveled; // metres remaining (negative if overshot)
      if (Math.abs(err) <= tol) settle++; else if (Math.abs(err) > tol * 2) settle = 0;
      if ((Math.abs(err) <= tol && s.speedMps < 0.06) || settle > 45) return { l: 0, r: 0, done: true };
      // Proportional command: eases to a stop at the target and gently reverses
      // to null any overshoot (a proportional correction never spins away).
      const mag = Math.min(sp, Math.abs(err) * KP);
      const cmd = dir * (err >= 0 ? 1 : -1) * mag;
      return { l: cmd, r: cmd, done: false };
    });
  }

  /**
   * Turn in place by `deg` degrees at track fraction `speed`. +deg = CLOCKWISE
   * (angle decreases). Gyro = accumulated angle delta; tapers + counter-brakes.
   * @param {number} deg degrees (positive = clockwise)
   * @param {number} [speed] 0..1 track fraction
   * @returns {Promise<void>}
   */
  turnDeg(deg, speed) {
    const target = Math.abs(Number(deg) || 0) * Math.PI / 180;
    const dir = (Number(deg) || 0) >= 0 ? 1 : -1; // +deg → clockwise
    const sp = clamp01(Number.isFinite(speed) ? speed : 0.3) || 0.3;
    const st = this.getState();
    let last = st.angleRad;
    let turned = 0;
    let settle = 0;
    const tol = 1.5 * Math.PI / 180;
    const KP = 3.2; // track command per radian of error (saturates to sp)
    return this._startMotion((dt) => {
      const s = this.getState();
      let d = s.angleRad - last;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      last = s.angleRad;
      turned += (-dir) * d; // signed progress in the commanded direction
      const angVel = dt > 0 ? Math.abs(d / dt) : 0;
      const err = target - turned; // radians remaining (negative if overshot)
      if (Math.abs(err) <= tol) settle++; else if (Math.abs(err) > tol * 2) settle = 0;
      if ((Math.abs(err) <= tol && angVel < 0.25) || settle > 45) return { l: 0, r: 0, done: true };
      // Proportional spin: eases to a stop on target and gently reverses to null
      // overshoot. dd = commanded turn direction (dir for CW, flipped past target).
      const mag = Math.min(sp, Math.abs(err) * KP);
      const dd = dir * (err >= 0 ? 1 : -1);
      return { l: dd * mag, r: -dd * mag, done: false };
    });
  }

  /**
   * Set persistent (open-loop) track speeds, -1..1 each. Non-blocking.
   * @returns {Promise<void>} resolved immediately (so it may be awaited).
   */
  setTracks(l, r) {
    this._motion = null;
    this._hold = { l: clampSigned(l), r: clampSigned(r) };
    return Promise.resolve();
  }

  /** Stop the motors (zero tracks, drop any motion). Non-blocking. */
  stop() {
    this._motion = null;
    this._hold = { l: 0, r: 0 };
    this._apply(0, 0);
    return Promise.resolve();
  }

  /**
   * Distance to the nearest obstacle straight ahead, in centimetres. Raycasts
   * from just in front of the chassis along the heading. Returns the max range
   * (in cm) when nothing is hit.
   * @returns {number}
   */
  distanceAheadCm() {
    const s = this.getState();
    const c = Math.cos(s.angleRad);
    const sn = Math.sin(s.angleRad);
    const x1 = s.x + c * FRONT_OFFSET_M;
    const y1 = s.y + sn * FRONT_OFFSET_M;
    const x2 = s.x + c * (FRONT_OFFSET_M + MAX_RANGE_M);
    const y2 = s.y + sn * (FRONT_OFFSET_M + MAX_RANGE_M);
    let hit = null;
    try { hit = this.ctx.world.raycastClosest(x1, y1, x2, y2); } catch (_e) { hit = null; }
    if (hit && hit.hit && Number.isFinite(hit.fraction)) {
      return Math.max(0, hit.fraction * MAX_RANGE_M * 100);
    }
    return MAX_RANGE_M * 100;
  }

  /**
   * Wait `ms` milliseconds (real time). Rejects with the stop sentinel if halted.
   * @returns {Promise<void>}
   */
  sleep(ms) {
    if (!this.running) return Promise.reject(new Error(STOP));
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => { this._timers.delete(id); resolve(); }, Math.max(0, Number(ms) || 0));
      this._timers.set(id, reject);
    });
  }

  /** Clear pending sleep timers; if `reject`, reject them with the stop sentinel. */
  _clearTimers(reject) {
    for (const [id, rej] of this._timers) {
      clearTimeout(id);
      if (reject) { try { rej(new Error(STOP)); } catch (_e) { /* ignore */ } }
    }
    this._timers.clear();
  }
}

/**
 * Build the JS bridge object exposed to Python as the `_sim` module. Each method
 * maps a SPIKE-ish call onto the controller. Async ones return the controller's
 * Promise (Python awaits it); sync ones return plain values.
 * @param {RobotController} controller
 * @param {{print?: (msg:string)=>void}} [opts]
 * @returns {object}
 */
export function createBridge(controller, opts) {
  const onPrint = opts && typeof opts.print === 'function' ? opts.print : null;
  return {
    drive_for_cm: (cm, speed) => controller.driveForCm(cm, speed),
    turn_deg: (deg, speed) => controller.turnDeg(deg, speed),
    set_tracks: (l, r) => { controller.setTracks(l, r); },
    stop_motors: () => { controller.stop(); },
    distance_cm: () => controller.distanceAheadCm(),
    sleep_ms: (ms) => controller.sleep(ms),
    log: (m) => { if (onPrint) onPrint(String(m)); },
  };
}

/**
 * The SPIKE-3 Python module set + program driver, executed ONCE into Pyodide's
 * globals after `_sim` is registered. Defines hub / runloop / motor_pair /
 * distance_sensor in sys.modules and `__run_user_program(src)` which code.js
 * awaits. Motion errors carrying the JS stop sentinel become `SpikeStop`
 * (a BaseException — a kid's `except Exception:` can't swallow it), so a Stop
 * unwinds cleanly and never surfaces as a traceback.
 */
export const PY_BOOTSTRAP = `
import sys, types, asyncio
import _sim


class SpikeStop(BaseException):
    """Raised to unwind the program when the user presses Stop."""
    pass


async def _await(p):
    """Await a JS bridge promise, converting the stop sentinel to SpikeStop."""
    try:
        return await p
    except SpikeStop:
        raise
    except BaseException as e:  # JsException is an Exception subclass
        if 'SIM_STOPPED' in str(e):
            raise SpikeStop()
        raise


# ---- hub ---------------------------------------------------------------
hub = types.ModuleType('hub')


class _Port:
    A = 'A'; B = 'B'; C = 'C'; D = 'D'; E = 'E'; F = 'F'


hub.port = _Port()
sys.modules['hub'] = hub


# ---- runloop -----------------------------------------------------------
runloop = types.ModuleType('runloop')
runloop._pending = []


def _rl_run(*coros):
    for c in coros:
        runloop._pending.append(c)


async def _rl_sleep_ms(ms):
    await _await(_sim.sleep_ms(ms))


async def _rl_drive():
    while runloop._pending:
        batch = runloop._pending
        runloop._pending = []
        await asyncio.gather(*batch)


runloop.run = _rl_run
runloop.sleep_ms = _rl_sleep_ms
runloop._drive = _rl_drive
sys.modules['runloop'] = runloop


# ---- motor_pair --------------------------------------------------------
motor_pair = types.ModuleType('motor_pair')
motor_pair.PAIR_1 = 0
motor_pair.PAIR_2 = 1
_pair_cfg = {}


def _mp_pair(pair_id, left_port, right_port):
    _pair_cfg[pair_id] = (left_port, right_port)


async def _mp_move_for_cm(cm, speed=40):
    await _await(_sim.drive_for_cm(cm, (speed or 0) / 100.0))


async def _mp_turn(deg, speed=30):
    await _await(_sim.turn_deg(deg, (speed or 0) / 100.0))


def _mp_start(left=75, right=75):
    _sim.set_tracks((left or 0) / 100.0, (right or 0) / 100.0)


def _mp_stop():
    _sim.stop_motors()


motor_pair.pair = _mp_pair
motor_pair.move_for_cm = _mp_move_for_cm
motor_pair.turn = _mp_turn
motor_pair.start = _mp_start
motor_pair.stop = _mp_stop
sys.modules['motor_pair'] = motor_pair


# ---- distance_sensor ---------------------------------------------------
distance_sensor = types.ModuleType('distance_sensor')


def _ds_distance(port=None):
    return float(_sim.distance_cm())


distance_sensor.distance = _ds_distance
distance_sensor.distance_cm = _ds_distance
sys.modules['distance_sensor'] = distance_sensor


# ---- program driver ----------------------------------------------------
async def __run_user_program(src):
    runloop._pending = []
    g = {'__name__': '__main__'}
    code = compile(src, '<program>', 'exec')
    exec(code, g)
    await runloop._drive()
`;

/** A friendly SPIKE-3 starter shown in the editor: drive a 30 cm square. */
export const SPIKE_STARTER = `from hub import port
import runloop
import motor_pair
import distance_sensor

# Left drive motor on port A, right on port B.
motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)


async def main():
    # Drive a 30 cm square: forward, turn 90 deg, four times.
    for i in range(4):
        await motor_pair.move_for_cm(30, speed=45)
        await motor_pair.turn(90, speed=35)

    # Try a wall-stop instead: uncomment below and comment the square above.
    # while distance_sensor.distance() > 15:
    #     await motor_pair.move_for_cm(5, speed=40)
    # motor_pair.stop()


runloop.run(main())
`;
