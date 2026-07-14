/**
 * spike_py.js — the FULL SPIKE 3 Python dialect over the physics robot.
 *
 * Two halves, both DOM-free so they can be verified headlessly in Node with the
 * real Pyodide:
 *
 *   1. PY_BOOTSTRAP — the Python module SOURCE that fabricates the SPIKE 3 module
 *      set in `sys.modules` (hub / runloop / motor / motor_pair / color_sensor /
 *      distance_sensor / force_sensor) plus `__run_user_program(src)`. Every
 *      SPIKE call funnels through the JS bridge module `_sim`.
 *   2. SpikeRuntime + createBridge — the JS side. SpikeRuntime wraps a
 *      RobotControl (js/robot/control.js) and turns the SPIKE calls into
 *      closed-loop motions, ticked once per frame by code.js's onFrame hook.
 *
 * UNITS boundary (the whole point): the SPIKE API speaks CENTIMETRES and
 * DEGREES; RobotControl already converts cm→m and deg→rad internally. So
 * move_for_cm(30) → control.driveForCm(30) → 0.30 m and STOP; turn(90) →
 * control.turnDeg(90) → +90°. `speed` is a 0..100 percent and passes straight
 * through to RobotControl (which also takes 0..100). No cm→m scaling happens
 * here — that was the Stage-2 bug and it is gone.
 *
 * Stop halts promptly: halt() rejects the in-flight primitive with the internal
 * sentinel 'SIM_STOPPED'; the Python `_await` turns that into a SpikeStop
 * (a BaseException a kid's `except Exception:` can't swallow) so the whole
 * program unwinds cleanly and the sentinel never reaches the user console.
 */

import { RobotControl } from './control.js';

/** Internal stop sentinel — never shown to the user. */
export const STOP_SENTINEL = 'SIM_STOPPED';

/* ------------------------------------------------------------------ */
/* small numeric helpers                                               */
/* ------------------------------------------------------------------ */

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clampN(v, lo, hi) { v = Number(v); if (!Number.isFinite(v)) return lo; return v < lo ? lo : v > hi ? hi : v; }
/** Speed magnitude as a 0..100 percent, defaulting when absent. */
function spd(v, def) { const n = Number(v); if (!Number.isFinite(n)) return def; return clampN(Math.abs(n), 0, 100); }
/** Signed track percent, -100..100. */
function spdSigned(v) { const n = Number(v); if (!Number.isFinite(n)) return 0; return clampN(n, -100, 100); }

/**
 * Convert a SPIKE steering (-100..100, + = turn right) + speed (0..100) into
 * left/right track percents for differential drive.
 * @returns {{l:number, r:number}}
 */
function steeringToTracks(steering, speed) {
  const s = clampN(steering, -100, 100) / 100;
  const v = clampN(speed, -100, 100);
  let l; let r;
  if (s >= 0) { l = v; r = v * (1 - 2 * s); }   // turn right: right wheel slows/reverses
  else { r = v; l = v * (1 + 2 * s); }          // turn left: left wheel slows/reverses
  return { l: clampN(l, -100, 100), r: clampN(r, -100, 100) };
}

const MOTOR_TIMEOUT_S = 15;

/* ------------------------------------------------------------------ */
/* SpikeRuntime — the JS engine behind the SPIKE modules               */
/* ------------------------------------------------------------------ */

/**
 * Drives a RobotControl from the SPIKE Python bridge. One instance lives for the
 * whole session; code.js rebinds it to the current robot via setControl() at the
 * start of each run. tick(dt) is called every frame (only advances while a
 * program is running); halt() interrupts promptly.
 */
export class SpikeRuntime {
  /**
   * @param {import('./control.js').RobotControl|null} control
   */
  constructor(control) {
    /** @type {import('./control.js').RobotControl|null} */
    this.control = control || null;
    /** True only while a user program owns the robot; tick() no-ops otherwise. */
    this.running = false;
    /** The in-flight blocking primitive's {resolve,reject}, or null. */
    this._pending = null;
    /** Active single-motor motion state, or null. */
    this._motor = null;
    /** Persistent continuous track percents (motor_pair.move / motor.start). */
    this._cont = { l: 0, r: 0 };
    /** setTimeout ids -> their reject fns, so halt() can cancel sleeps. */
    this._timers = new Map();
  }

  /** Bind to a (new) RobotControl — call before begin() each run. */
  setControl(control) { this.control = control || null; }

  /** Begin a run: reset transient state and take ownership. */
  begin() {
    this.running = true;
    this._pending = null;
    this._motor = null;
    this._cont = { l: 0, r: 0 };
    this._clearTimers(false);
  }

  /** End a run cleanly: stop the robot and drop all state. */
  end() {
    this.running = false;
    this._pending = null;
    this._motor = null;
    this._cont = { l: 0, r: 0 };
    this._clearTimers(false);
    try { if (this.control) this.control.stop(); } catch (_e) { /* ignore */ }
  }

  /** Halt a running program PROMPTLY (Stop button): reject in-flight work. */
  halt() {
    this.running = false;
    this._motor = null;
    this._cont = { l: 0, r: 0 };
    this._clearTimers(true);
    try { if (this.control) this.control.stop(); } catch (_e) { /* ignore */ }
    const p = this._pending;
    this._pending = null;
    if (p) { try { p.reject(new Error(STOP_SENTINEL)); } catch (_e) { /* ignore */ } }
  }

  /**
   * Advance the current motion by dt and issue this frame's control. Called by
   * code.js's ctx.onFrame hook. No-ops unless a program is running. Never throws.
   * @param {number} dt seconds
   */
  tick(dt) {
    if (!this.running || !this.control) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
    try {
      if (this._motor) this._advanceMotor(step);
      this.control.tick(step);
    } catch (_e) { /* never throw in a frame hook */ }
  }

  /* -------- blocking-primitive plumbing -------- */

  /**
   * Wrap a RobotControl motion promise so halt() can interrupt it. RobotControl
   * resolves (never rejects) on completion; halt() rejects our wrapper first, so
   * a Stop unwinds the program instead of falling through to the next line.
   * @param {Promise<void>} controlPromise
   * @returns {Promise<void>}
   */
  _blocking(controlPromise) {
    if (!this.running) return Promise.reject(new Error(STOP_SENTINEL));
    return new Promise((resolve, reject) => {
      const rec = { resolve, reject };
      this._pending = rec;
      Promise.resolve(controlPromise).then(
        () => { if (this._pending === rec) { this._pending = null; this._cont = { l: 0, r: 0 }; resolve(); } },
        (e) => { if (this._pending === rec) { this._pending = null; reject(e); } },
      );
    });
  }

  /* -------- motor_pair primitives -------- */

  /**
   * Drive straight for `cm` centimetres (negative = reverse), then stop.
   * @param {number} cm @param {number} [speed] 0..100
   * @returns {Promise<void>}
   */
  driveForCm(cm, speed) {
    if (!this.running || !this.control) return Promise.reject(new Error(STOP_SENTINEL));
    return this._blocking(this.control.driveForCm(num(cm, 0), spd(speed, 50)));
  }

  /**
   * Turn in place by `deg` degrees (+ = clockwise), then stop.
   * @param {number} deg @param {number} [speed] 0..100
   * @returns {Promise<void>}
   */
  turnDeg(deg, speed) {
    if (!this.running || !this.control) return Promise.reject(new Error(STOP_SENTINEL));
    return this._blocking(this.control.turnDeg(num(deg, 0), spd(speed, 40)));
  }

  /** Continuous differential drive (steering -100..100, speed 0..100). Non-blocking. */
  move(steering, speed) {
    const t = steeringToTracks(steering, speed);
    this._cont = { l: t.l, r: t.r };
    this._motor = null;
    try { if (this.control) this.control.setTracks(t.l, t.r); } catch (_e) { /* ignore */ }
  }

  /** Stop both drive motors. Non-blocking. */
  stopMotors() {
    this._cont = { l: 0, r: 0 };
    this._motor = null;
    try { if (this.control) this.control.stop(); } catch (_e) { /* ignore */ }
  }

  /* -------- single motor primitives -------- */

  /** Map a port letter to a drive side ('l'|'r') or null (non-drive motor). */
  _side(port) {
    try {
      const devs = (this.control && this.control.vehicle && this.control.vehicle.devices) || [];
      for (const d of devs) {
        if (d && d.port === port && d.type === 'motor') {
          if (d.role === 'drive-left') return 'l';
          if (d.role === 'drive-right') return 'r';
          return null;
        }
      }
    } catch (_e) { /* ignore */ }
    if (port === 'A') return 'l';
    if (port === 'B') return 'r';
    return null;
  }

  /** Read a motor's accumulated position (deg) from the robot state. */
  _motorPos(port) {
    try {
      const s = this.control.vehicle.getState();
      return num(s.motors && s.motors[port] && s.motors[port].posDeg, 0);
    } catch (_e) { return 0; }
  }

  /** Run one motor for `degrees` (± direction), then stop. @returns {Promise<void>} */
  motorDegrees(port, degrees, velocity) {
    if (!this.running || !this.control) return Promise.reject(new Error(STOP_SENTINEL));
    const side = this._side(port);
    const d = num(degrees, 0);
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this._motor = {
        mode: 'deg', port, side,
        dir: d >= 0 ? 1 : -1,
        target: Math.abs(d),
        start: this._motorPos(port),
        speedPct: spd(velocity, 60),
        timed: side == null,     // non-drive motor: no odometry → time-based
        t: 0,
      };
    });
  }

  /** Run one motor for `seconds`, then stop. @returns {Promise<void>} */
  motorSeconds(port, seconds, velocity) {
    if (!this.running || !this.control) return Promise.reject(new Error(STOP_SENTINEL));
    const side = this._side(port);
    const secs = Math.max(0, num(seconds, 0));
    const v = spdSigned(velocity);
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this._motor = {
        mode: 'sec', port, side,
        dir: v >= 0 ? 1 : -1,
        speedPct: Math.abs(v) || 60,
        target: secs,
        timed: side == null,
        t: 0,
      };
    });
  }

  /** Advance the active single-motor motion by dt. */
  _advanceMotor(dt) {
    const m = this._motor;
    if (!m) return;
    m.t += dt;
    let done = false;
    if (m.mode === 'sec') {
      if (m.side) {
        const cmd = m.dir * m.speedPct;
        this.control.setTracks(m.side === 'l' ? cmd : 0, m.side === 'r' ? cmd : 0);
      }
      if (m.t >= m.target) done = true;
    } else { // degrees
      if (m.timed) {
        const dps = (m.speedPct / 100) * 600; // nominal deg/s for a bodiless motor
        const dur = m.target / Math.max(1, dps);
        if (m.t >= dur) done = true;
      } else {
        const traveled = Math.abs(this._motorPos(m.port) - m.start);
        if (m.target - traveled <= 5 || m.t >= MOTOR_TIMEOUT_S) done = true;
        else {
          const cmd = m.dir * m.speedPct;
          this.control.setTracks(m.side === 'l' ? cmd : 0, m.side === 'r' ? cmd : 0);
        }
      }
    }
    if (done) {
      this._motor = null;
      this._cont = { l: 0, r: 0 };
      try { this.control.stop(); } catch (_e) { /* ignore */ }
      const p = this._pending;
      this._pending = null;
      if (p) { try { p.resolve(); } catch (_e) { /* ignore */ } }
    }
  }

  /** Set one motor running continuously at `velocity` (%). Non-blocking. */
  motorStart(port, velocity) {
    const side = this._side(port);
    if (!side) return; // non-drive motor: no persistent physical effect
    this._cont[side] = spdSigned(velocity);
    this._motor = null;
    try { if (this.control) this.control.setTracks(this._cont.l, this._cont.r); } catch (_e) { /* ignore */ }
  }

  /** Stop one motor. Non-blocking. */
  motorStop(port) {
    const side = this._side(port);
    if (side) {
      this._cont[side] = 0;
      try { if (this.control) this.control.setTracks(this._cont.l, this._cont.r); } catch (_e) { /* ignore */ }
    }
  }

  /* -------- sensors (synchronous reads) -------- */

  color(port) { try { return String(this.control.color(port)); } catch (_e) { return 'none'; } }
  reflection(port) { try { return num(this.control.reflected(port), 0); } catch (_e) { return 0; } }
  distanceCm(port) {
    try { const v = this.control.distanceCm(port); return v == null ? null : num(v, null); }
    catch (_e) { return null; }
  }
  force(port) { try { return num(this.control.force(port), 0); } catch (_e) { return 0; } }
  pressed(port) { try { return !!this.control.pressed(port); } catch (_e) { return false; } }
  yawDeg() { try { return num(this.control.yawDeg(), 0); } catch (_e) { return 0; } }
  resetYaw() { try { this.control.resetYaw(); } catch (_e) { /* ignore */ } }

  /* -------- timing -------- */

  /** Wait `ms` real milliseconds; rejects with the stop sentinel if halted. */
  sleep(ms) {
    if (!this.running) return Promise.reject(new Error(STOP_SENTINEL));
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => { this._timers.delete(id); resolve(); }, Math.max(0, num(ms, 0)));
      this._timers.set(id, reject);
    });
  }

  /** Clear pending sleeps; if `reject`, reject them with the stop sentinel. */
  _clearTimers(reject) {
    for (const [id, rej] of this._timers) {
      clearTimeout(id);
      if (reject) { try { rej(new Error(STOP_SENTINEL)); } catch (_e) { /* ignore */ } }
    }
    this._timers.clear();
  }
}

/**
 * Build the JS bridge object exposed to Python as the `_sim` module. Async
 * methods return the runtime's Promise (Python awaits it); sync sensor reads
 * return plain values (numbers / strings / null).
 * @param {SpikeRuntime} runtime
 * @param {{print?: (msg:string)=>void}} [opts]
 * @returns {object}
 */
export function createBridge(runtime, opts) {
  const print = opts && typeof opts.print === 'function' ? opts.print : () => {};
  return {
    // motor_pair
    drive_for_cm: (cm, speed) => runtime.driveForCm(cm, speed),
    turn_deg: (deg, speed) => runtime.turnDeg(deg, speed),
    move: (steering, speed) => { runtime.move(steering, speed); },
    mp_stop: () => { runtime.stopMotors(); },
    // motor
    motor_run_degrees: (port, deg, speed) => runtime.motorDegrees(port, deg, speed),
    motor_run_seconds: (port, secs, speed) => runtime.motorSeconds(port, secs, speed),
    motor_start: (port, speed) => { runtime.motorStart(port, speed); },
    motor_stop: (port) => { runtime.motorStop(port); },
    // sensors
    color: (port) => runtime.color(port),
    reflection: (port) => runtime.reflection(port),
    distance_cm: (port) => { const v = runtime.distanceCm(port); return v == null ? null : v; },
    force_newtons: (port) => runtime.force(port),
    force_pressed: (port) => runtime.pressed(port),
    // hub
    get_yaw: () => runtime.yawDeg(),
    reset_yaw: () => { runtime.resetYaw(); },
    write: (text) => { print(String(text)); },
    // timing + logging
    sleep_ms: (ms) => runtime.sleep(ms),
    log: (m) => { print(String(m)); },
  };
}

/**
 * Convenience: build a SpikeRuntime + bridge for a robot vehicle + world.
 * @param {object} vehicle the active Robot vehicle
 * @param {object} world the PhysicsWorld
 * @param {{print?: (msg:string)=>void}} [opts]
 * @returns {{runtime: SpikeRuntime, bridge: object, control: import('./control.js').RobotControl}}
 */
export function makeSpikeRuntime(vehicle, world, opts) {
  const control = new RobotControl(vehicle, world);
  const runtime = new SpikeRuntime(control);
  const bridge = createBridge(runtime, opts);
  return { runtime, bridge, control };
}

/* ------------------------------------------------------------------ */
/* PY_BOOTSTRAP — the SPIKE 3 module set, run once into Pyodide         */
/* ------------------------------------------------------------------ */

export const PY_BOOTSTRAP = `
import sys, types, asyncio
import _sim


class SpikeStop(BaseException):
    """Raised to unwind the program when the user presses Stop."""
    pass


async def _await(p):
    """Await a JS bridge promise; convert the stop sentinel into SpikeStop."""
    try:
        return await p
    except SpikeStop:
        raise
    except BaseException as e:  # JsException is an Exception subclass
        if '${STOP_SENTINEL}' in str(e):
            raise SpikeStop()
        raise


# ---- hub ----------------------------------------------------------------
hub = types.ModuleType('hub')


class _Port:
    A = 'A'; B = 'B'; C = 'C'; D = 'D'; E = 'E'; F = 'F'


class _MotionSensor:
    def get_yaw(self):
        return _sim.get_yaw()

    def reset_yaw(self, angle=0):
        _sim.reset_yaw()


class _LightMatrix:
    def write(self, text):
        _sim.write(str(text))

    def show_image(self, *a, **k):
        pass

    def clear(self):
        pass


hub.port = _Port()
hub.motion_sensor = _MotionSensor()
hub.light_matrix = _LightMatrix()
sys.modules['hub'] = hub


# ---- runloop ------------------------------------------------------------
runloop = types.ModuleType('runloop')
runloop._pending = []


def _rl_run(*coros):
    for c in coros:
        runloop._pending.append(c)


async def _rl_sleep_ms(ms):
    await _await(_sim.sleep_ms(ms))


async def _rl_until(predicate, timeout=None):
    while True:
        done = predicate() if callable(predicate) else predicate
        if done:
            return
        await _rl_sleep_ms(10)


async def _rl_drive():
    while runloop._pending:
        batch = runloop._pending
        runloop._pending = []
        await asyncio.gather(*batch)


runloop.run = _rl_run
runloop.sleep_ms = _rl_sleep_ms
runloop.until = _rl_until
runloop._drive = _rl_drive
sys.modules['runloop'] = runloop


# ---- motor_pair ---------------------------------------------------------
motor_pair = types.ModuleType('motor_pair')
motor_pair.PAIR_1 = 0
motor_pair.PAIR_2 = 1
_pair_cfg = {}


def _mp_pair(pair_id, left_port, right_port):
    _pair_cfg[pair_id] = (left_port, right_port)


async def _mp_move_for_cm(cm, speed=50):
    await _await(_sim.drive_for_cm(cm, speed))


async def _mp_turn(deg, speed=40):
    await _await(_sim.turn_deg(deg, speed))


def _mp_move(steering, speed=50):
    _sim.move(steering, speed)


def _mp_start(steering=0, speed=50):
    _sim.move(steering, speed)


def _mp_stop():
    _sim.mp_stop()


motor_pair.pair = _mp_pair
motor_pair.move_for_cm = _mp_move_for_cm
motor_pair.turn = _mp_turn
motor_pair.move = _mp_move
motor_pair.start = _mp_start
motor_pair.stop = _mp_stop
sys.modules['motor_pair'] = motor_pair


# ---- motor (callable module: motor(port).run_for_degrees(...)) ----------
class _MotorPort:
    def __init__(self, port):
        self.port = port

    async def run_for_degrees(self, degrees, velocity=360):
        await _await(_sim.motor_run_degrees(self.port, degrees, velocity))

    async def run_for_seconds(self, seconds, velocity=360):
        await _await(_sim.motor_run_seconds(self.port, seconds, velocity))

    def start(self, velocity=360):
        _sim.motor_start(self.port, velocity)

    def stop(self):
        _sim.motor_stop(self.port)


class _MotorModule:
    def __call__(self, port):
        return _MotorPort(port)

    async def run_for_degrees(self, port, degrees, velocity=360):
        await _await(_sim.motor_run_degrees(port, degrees, velocity))

    async def run_for_seconds(self, port, seconds, velocity=360):
        await _await(_sim.motor_run_seconds(port, seconds, velocity))

    def start(self, port, velocity=360):
        _sim.motor_start(port, velocity)

    def stop(self, port):
        _sim.motor_stop(port)


motor = _MotorModule()
sys.modules['motor'] = motor


# ---- color_sensor -------------------------------------------------------
color_sensor = types.ModuleType('color_sensor')


def _cs_color(port='E'):
    return _sim.color(port)


def _cs_reflection(port='E'):
    return int(_sim.reflection(port))


color_sensor.color = _cs_color
color_sensor.reflection = _cs_reflection
sys.modules['color_sensor'] = color_sensor


# ---- distance_sensor ----------------------------------------------------
distance_sensor = types.ModuleType('distance_sensor')


def _ds_distance_cm(port='D'):
    v = _sim.distance_cm(port)
    if v is None:
        return None
    return float(v)


distance_sensor.distance_cm = _ds_distance_cm
distance_sensor.distance = _ds_distance_cm
sys.modules['distance_sensor'] = distance_sensor


# ---- force_sensor -------------------------------------------------------
force_sensor = types.ModuleType('force_sensor')


def _fs_pressed(port='F'):
    return bool(_sim.force_pressed(port))


def _fs_force(port='F'):
    return float(_sim.force_newtons(port))


force_sensor.pressed = _fs_pressed
force_sensor.force = _fs_force
sys.modules['force_sensor'] = force_sensor


# ---- program driver -----------------------------------------------------
async def __run_user_program(src):
    runloop._pending = []
    g = {'__name__': '__main__'}
    code = compile(src, '<program>', 'exec')
    exec(code, g)
    await runloop._drive()
`;

/* ------------------------------------------------------------------ */
/* Programs: a good default + two loadable examples                    */
/* ------------------------------------------------------------------ */

/** Default editor program: drive a 30 cm square on the mat. */
export const DEFAULT_PROGRAM = `from hub import port, light_matrix
import runloop
import motor_pair

# Left drive motor on port A, right drive motor on port B.
motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)


async def main():
    light_matrix.write("GO")
    # Drive a 30 cm square: forward 30 cm, turn 90 deg, four times.
    for i in range(4):
        await motor_pair.move_for_cm(30, speed=50)
        await motor_pair.turn(90, speed=40)
    light_matrix.write("DONE")


runloop.run(main())
`;

/** Example: drive a 30 cm square (identical to the default, kept explicit). */
export const SQUARE_PROGRAM = `from hub import port
import runloop
import motor_pair

motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)


async def main():
    for i in range(4):
        await motor_pair.move_for_cm(30, speed=50)
        await motor_pair.turn(90, speed=40)


runloop.run(main())
`;

/**
 * Example: single-sensor line follower. The colour sensor on port E rides the
 * inner EDGE of the black loop on the mat; we steer proportionally to keep the
 * reflection at the edge setpoint (dark line ~1, light mat ~80, edge ~40). The
 * robot starts on the edge, so it locks straight on and laps the loop (~42 s per
 * lap) back to the start. Verified headlessly: stays within ~2.6 cm of the line.
 */
export const LINE_FOLLOW_PROGRAM = `from hub import port
import runloop
import motor_pair
import color_sensor

motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)

TARGET = 40   # edge reflection setpoint (dark line ~1, light mat ~80)
BASE = 40     # cruise speed (0..100) — a steady crawl
KP = 1.5      # steering gain (proportional on the reflection error)


async def main():
    # Follow the line's edge forever; press Stop (or a challenge goal) to end.
    while True:
        reflection = color_sensor.reflection(port.E)
        error = reflection - TARGET
        steering = max(-100, min(100, error * KP))
        motor_pair.move(steering, BASE)
        await runloop.sleep_ms(20)


runloop.run(main())
`;

/** Loadable examples, keyed by the label shown in the editor's picker. */
export const EXAMPLES = {
  'Drive a square': SQUARE_PROGRAM,
  'Line follow': LINE_FOLLOW_PROGRAM,
};
