/**
 * SpikeSim Python runtime — Skulpt bridge + embedded SPIKE-style `spike` package.
 *
 * Exposes one entry point, {@link runPython}, which runs SPIKE v2-style Python
 * (see docs/CONTRACT.md, AGENT-PY section) against a live Engine instance.
 *
 * How it works:
 *  - A native Skulpt module `_sim` (a JS source string in Sk.builtinFiles) wraps
 *    `engine.api`. It reaches the engine through `Sk.simEngine`, which is set
 *    fresh on every run.
 *  - The `spike` package (and `spike.control`) is embedded as Python source and
 *    implements the kid-facing classes on top of `_sim`.
 *  - Long-running commands (move, wait, beep, ...) return engine promises that
 *    resolve on SIM time; they are bridged with Sk.misceval.promiseToSuspension.
 *  - stop() sets a flag; Skulpt's '*' suspension handler throws a sentinel at the
 *    next yield, and Error('SIM_STOPPED') rejections from engine.cancelAll() are
 *    treated as a clean stop — never shown to the kid as a Python error.
 *
 * Only one program should run at a time (Skulpt state is global); app.js
 * enforces this.
 */
import { emit } from '../core/bus.js';

/**
 * Native Skulpt module `_sim` — a STRING of JavaScript evaluated by Skulpt's
 * import machinery. It must define `$builtinmodule`. The engine instance is
 * read from `Sk.simEngine` (set by runPython before each run).
 * NOTE: keep this ES5-flavored and free of backticks / `${`.
 */
const SIM_MODULE_JS = [
  'var $builtinmodule = function (name) {',
  '    var mod = {};',
  '',
  '    function engine() {',
  '        var e = Sk.simEngine;',
  '        if (!e || !e.api) {',
  '            throw new Sk.builtin.RuntimeError("The simulator is not connected. Try reloading the page.");',
  '        }',
  '        return e;',
  '    }',
  '',
  '    // Turn engine error codes into messages a kid can act on.',
  '    function friendlyMessage(err) {',
  '        var msg = (err && err.message !== undefined) ? String(err.message) : String(err);',
  '        if (msg.indexOf("NO_DEVICE:") === 0) {',
  '            return "Oops - " + msg.slice(10).trim() + ". Open the Build tab to check what is plugged into each port.";',
  '        }',
  '        if (msg.indexOf("NO_DRIVE:") === 0) {',
  '            return "Oops - this robot has no drive motors set up. Open the Build tab and choose the two drive motor ports.";',
  '        }',
  '        return msg;',
  '    }',
  '',
  '    function asPyError(err) {',
  '        if (err instanceof Sk.builtin.BaseException) { return err; }',
  '        return new Sk.builtin.RuntimeError(friendlyMessage(err));',
  '    }',
  '',
  '    function jsArgs(args) {',
  '        var out = [];',
  '        for (var i = 0; i < args.length; i++) { out.push(Sk.ffi.remapToJs(args[i])); }',
  '        return out;',
  '    }',
  '',
  '    // Wrap a synchronous engine call: JS value in/out, engine throws -> RuntimeError.',
  '    function syncFunc(fn) {',
  '        return new Sk.builtin.func(function () {',
  '            var v;',
  '            try { v = fn.apply(null, jsArgs(arguments)); }',
  '            catch (err) { throw asPyError(err); }',
  '            return Sk.ffi.remapToPy(v === undefined ? null : v);',
  '        });',
  '    }',
  '',
  '    // Wrap an engine call that returns a promise resolved on sim time.',
  '    // Error("SIM_STOPPED") rejections are re-thrown untouched so runPython',
  '    // can recognise them as a clean stop, not a Python error.',
  '    function asyncFunc(fn) {',
  '        return new Sk.builtin.func(function () {',
  '            var p;',
  '            try { p = fn.apply(null, jsArgs(arguments)); }',
  '            catch (err) { throw asPyError(err); }',
  '            var chained = Promise.resolve(p).then(',
  '                function (v) { return Sk.ffi.remapToPy(v === undefined || v === null ? null : v); },',
  '                function (err) {',
  '                    if (err && err.message === "SIM_STOPPED") { throw err; }',
  '                    throw asPyError(err);',
  '                }',
  '            );',
  '            // Keep a no-op rejection branch: if the run is interrupted before Skulpt',
  '            // subscribes to this promise, its rejection must not surface as an',
  '            // "unhandled rejection" warning in the browser console.',
  '            chained["catch"](function () {});',
  '            return Sk.misceval.promiseToSuspension(chained);',
  '        });',
  '    }',
  '',
  '    // ---- robot info ----',
  '    mod.drive_info = syncFunc(function () {',
  '        var d = engine().getRobotConfig().drive || {};',
  '        return {',
  '            wheelDiameterCm: Number(d.wheelDiameterCm) || 5.6,',
  '            trackWidthCm: Number(d.trackWidthCm) || 11.2,',
  '            maxDegPerSec: Number(d.maxDegPerSec) || 970',
  '        };',
  '    });',
  '    mod.drive_ports = syncFunc(function () {',
  '        var d = engine().getRobotConfig().drive || {};',
  '        return [d.leftPort || null, d.rightPort || null];',
  '    });',
  '',
  '    // ---- single motors ----',
  '    mod.motor_run = syncFunc(function (port, speed) { engine().api.motorRun(port, speed); });',
  '    mod.motor_stop = syncFunc(function (port) { engine().api.motorStop(port); });',
  '    mod.motor_run_for_degrees = asyncFunc(function (port, speed, degrees) {',
  '        return engine().api.motorRunForDegrees(port, speed, degrees);',
  '    });',
  '    mod.motor_position = syncFunc(function (port) { return engine().api.motorGetPosition(port); });',
  '    mod.motor_speed = syncFunc(function (port) { return engine().api.motorGetSpeed(port); });',
  '',
  '    // ---- movement (drive base) ----',
  '    mod.move_start = syncFunc(function (steering, speed) { engine().api.moveStart(steering, speed); });',
  '    mod.move_start_tank = syncFunc(function (l, r) { engine().api.moveStartTank(l, r); });',
  '    mod.move_stop = syncFunc(function () { engine().api.moveStop(); });',
  '    mod.move_for_cm = asyncFunc(function (cm, speed, steering) {',
  '        return engine().api.moveForCm(cm, speed, steering);',
  '    });',
  '    mod.move_tank_for_cm = asyncFunc(function (cm, l, r) {',
  '        return engine().api.moveTankForCm(cm, l, r);',
  '    });',
  '    mod.turn_degrees = asyncFunc(function (degrees, speed) {',
  '        return engine().api.turnDegrees(degrees, speed);',
  '    });',
  '',
  '    // ---- gyro + sensors ----',
  '    mod.gyro_yaw = syncFunc(function () { return engine().api.gyroYaw(); });',
  '    mod.gyro_reset = syncFunc(function () { engine().api.gyroReset(); });',
  '    mod.distance_cm = syncFunc(function (port) { return engine().api.distanceCm(port); });',
  '    mod.color_name = syncFunc(function (port) { return engine().api.colorName(port); });',
  '    mod.reflected = syncFunc(function (port) { return engine().api.reflected(port); });',
  '    mod.force_pressed = syncFunc(function (port) { return engine().api.forcePressed(port); });',
  '    mod.force_newtons = syncFunc(function (port) { return engine().api.forceNewtons(port); });',
  '',
  '    // ---- time, display, sound ----',
  '    mod.timer_sec = syncFunc(function () { return engine().api.timerSec(); });',
  '    mod.timer_reset = syncFunc(function () { engine().api.timerReset(); });',
  '    mod.wait_seconds = asyncFunc(function (sec) { return engine().api.waitSeconds(sec); });',
  '    mod.beep = asyncFunc(function (freq, sec) { return engine().api.beep(freq, sec); });',
  '    mod.display_write = syncFunc(function (text) { engine().api.displayWrite(text); });',
  '    mod.display_image = syncFunc(function (name) { engine().api.displayImage(name); });',
  '    mod.display_set_pixel = syncFunc(function (x, y, b) { engine().api.displaySetPixel(x, y, b); });',
  '    mod.display_get_pixel = syncFunc(function (x, y) { return engine().api.displayGetPixel(x, y); });',
  '    mod.display_clear = syncFunc(function () { engine().api.displayClear(); });',
  '',
  '    return mod;',
  '};',
].join('\n');

/**
 * The `spike` package (Python source). SPIKE v2-style API per the contract.
 */
const SPIKE_INIT_PY = `"""SPIKE Prime-style robot API for SpikeSim.

Mimics the LEGO SPIKE app's Python API, so programs written here feel
like the real thing. Talks to the simulator through the _sim module.
"""

import _sim

_PI = 3.141592653589793
_PORTS = ('A', 'B', 'C', 'D', 'E', 'F')


def _check_port(port):
    if not isinstance(port, str):
        raise TypeError("A port should be a letter in quotes, like 'A' (got " + type(port).__name__ + ")")
    p = port.upper()
    if p not in _PORTS:
        raise ValueError("'" + str(port) + "' is not a port. Ports are 'A' to 'F'.")
    return p


def _num(value, what):
    if not isinstance(value, (int, float)):
        raise TypeError(what + " should be a number (got " + type(value).__name__ + ")")
    return value


def _clamp(value, lo, hi):
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def _speed_value(speed):
    return _clamp(_num(speed, 'speed'), -100, 100)


def _steering_value(steering):
    return _clamp(_num(steering, 'steering'), -100, 100)


def _sign(x):
    if x < 0:
        return -1
    return 1


class _MotionSensor:
    """The hub's built-in gyro (yaw only in the simulator)."""

    def get_yaw_angle(self):
        return int(round(_sim.gyro_yaw()))

    def reset_yaw_angle(self):
        _sim.gyro_reset()


class _LightMatrix:
    """The 5x5 light matrix (text via write(), or images/pixels on the grid)."""

    def write(self, text):
        _sim.display_write(str(text))

    def off(self):
        _sim.display_write('')

    def clear(self):
        _sim.display_clear()

    def show_image(self, image):
        """Show a named image, e.g. 'HEART', 'HAPPY', 'ARROW_N'."""
        _sim.display_image(str(image))

    def set_pixel(self, x, y, brightness=100):
        """Light one pixel (x, y from 0 to 4) at 0..100 brightness."""
        b = int(round(_clamp(_num(brightness, 'brightness'), 0, 100) / 100.0 * 9))
        _sim.display_set_pixel(int(x), int(y), b)

    def get_pixel(self, x, y):
        """Read one pixel's brightness (0..100)."""
        return int(round(_sim.display_get_pixel(int(x), int(y)) / 9.0 * 100))


class _Speaker:
    """The hub speaker."""

    def beep(self, note=60, seconds=0.2):
        note = _num(note, 'note')
        seconds = _num(seconds, 'seconds')
        if seconds < 0:
            raise ValueError('seconds should be 0 or more')
        freq = 440.0 * 2 ** ((note - 69) / 12.0)
        _sim.beep(freq, seconds)


class PrimeHub:
    """The SPIKE Prime hub: motion_sensor, light_matrix and speaker."""

    def __init__(self):
        self.motion_sensor = _MotionSensor()
        self.light_matrix = _LightMatrix()
        self.speaker = _Speaker()


class Motor:
    """A single motor plugged into one port ('A' to 'F')."""

    def __init__(self, port):
        self.port = _check_port(port)
        _sim.motor_position(self.port)  # friendly error now if there is no motor here
        self._default_speed = 50
        self._max_dps = _sim.drive_info()['maxDegPerSec']

    def set_default_speed(self, speed):
        self._default_speed = _speed_value(speed)

    def get_default_speed(self):
        return self._default_speed

    def _speed(self, speed):
        if speed is None:
            return self._default_speed
        return _speed_value(speed)

    def start(self, speed=None):
        _sim.motor_run(self.port, self._speed(speed))

    def stop(self):
        _sim.motor_stop(self.port)

    def run_for_degrees(self, degrees, speed=None):
        s = self._speed(speed)
        d = _num(degrees, 'degrees')
        if s == 0 or d == 0:
            return
        # SPIKE rule: direction = sign(amount) x sign(speed)
        _sim.motor_run_for_degrees(self.port, abs(s), d * _sign(s))

    def run_for_rotations(self, rotations, speed=None):
        self.run_for_degrees(_num(rotations, 'rotations') * 360, speed)

    def run_for_seconds(self, seconds, speed=None):
        s = self._speed(speed)
        sec = _num(seconds, 'seconds')
        if s == 0 or sec == 0:
            return
        _sim.motor_run(self.port, s * _sign(sec))
        _sim.wait_seconds(abs(sec))
        _sim.motor_stop(self.port)

    def get_position(self):
        return int(round(_sim.motor_position(self.port))) % 360

    def get_degrees_counted(self):
        return int(round(_sim.motor_position(self.port)))

    def get_speed(self):
        return int(round(_sim.motor_speed(self.port) / self._max_dps * 100))


class MotorPair:
    """Two motors driving together, like the wheels of a driving base.

    MotorPair() uses the robot's configured drive ports.
    """

    def __init__(self, left_port=None, right_port=None):
        info = _sim.drive_info()
        ports = _sim.drive_ports()
        if left_port is None and right_port is None:
            left_port, right_port = ports[0], ports[1]
        elif left_port is None or right_port is None:
            raise ValueError("MotorPair needs two ports, like MotorPair('A', 'B')")
        else:
            left_port = _check_port(left_port)
            right_port = _check_port(right_port)
            if ports[0] is None or ports[1] is None:
                raise RuntimeError('This robot has no drive motors set up. Open the Build tab and choose them.')
            if left_port != ports[0] or right_port != ports[1]:
                raise RuntimeError("MotorPair('" + left_port + "', '" + right_port + "') does not match "
                                   + "this robot's drive motors (left='" + str(ports[0]) + "', right='"
                                   + str(ports[1]) + "'). Change the ports here or in the Build tab.")
        self.left_port = left_port
        self.right_port = right_port
        self._default_speed = 50
        self._wheel_cm = _PI * info['wheelDiameterCm']

    def set_default_speed(self, speed):
        self._default_speed = _speed_value(speed)

    def get_default_speed(self):
        return self._default_speed

    def _speed(self, speed):
        if speed is None:
            return self._default_speed
        return _speed_value(speed)

    def _to_cm(self, amount, unit):
        if unit == 'cm':
            return amount
        if unit == 'in':
            return amount * 2.54
        if unit == 'rotations':
            return amount * self._wheel_cm
        if unit == 'degrees':
            return amount * self._wheel_cm / 360.0
        raise ValueError("'" + str(unit) + "' is not a unit I know. Use 'cm', 'in', 'rotations', 'degrees' or 'seconds'.")

    def move(self, amount, unit='cm', steering=0, speed=None):
        amount = _num(amount, 'amount')
        steering = _steering_value(steering)
        s = self._speed(speed)
        if unit == 'seconds':
            if s == 0 or amount == 0:
                self.stop()
                return
            _sim.move_start(steering, s * _sign(amount))
            _sim.wait_seconds(abs(amount))
            _sim.move_stop()
            return
        cm = self._to_cm(abs(amount), unit) * _sign(amount) * _sign(s)
        if cm == 0 or s == 0:
            return
        _sim.move_for_cm(cm, abs(s), steering)

    def move_tank(self, amount, unit='cm', left_speed=None, right_speed=None):
        amount = _num(amount, 'amount')
        l = self._speed(left_speed)
        r = self._speed(right_speed)
        if unit == 'seconds':
            if amount == 0:
                self.stop()
                return
            _sim.move_start_tank(l * _sign(amount), r * _sign(amount))
            _sim.wait_seconds(abs(amount))
            _sim.move_stop()
            return
        cm = self._to_cm(abs(amount), unit)
        if cm == 0 or (l == 0 and r == 0):
            return
        _sim.move_tank_for_cm(cm, l * _sign(amount), r * _sign(amount))

    def start(self, steering=0, speed=None):
        _sim.move_start(_steering_value(steering), self._speed(speed))

    def start_tank(self, left_speed, right_speed):
        _sim.move_start_tank(_speed_value(left_speed), _speed_value(right_speed))

    def stop(self):
        _sim.move_stop()

    def turn(self, degrees, speed=None):
        """SpikeSim extension (not on a real hub): turn in place using the gyro.

        Positive degrees = turn right (clockwise), negative = left.
        """
        d = _num(degrees, 'degrees')
        s = self._speed(speed)
        if d == 0 or s == 0:
            return
        _sim.turn_degrees(d * _sign(s), abs(s))


class ColorSensor:
    """A color sensor. Looks straight down at the mat."""

    def __init__(self, port):
        self.port = _check_port(port)
        _sim.color_name(self.port)  # friendly error now if there is no color sensor here

    def get_color(self):
        c = _sim.color_name(self.port)
        if c == 'none':
            return None
        return c

    def get_reflected_light(self):
        return int(round(_sim.reflected(self.port)))


class DistanceSensor:
    """An ultrasonic distance sensor. Returns None beyond 200 cm."""

    def __init__(self, port):
        self.port = _check_port(port)
        _sim.distance_cm(self.port)  # friendly error now if there is no distance sensor here

    def get_distance_cm(self):
        return _sim.distance_cm(self.port)

    def get_distance_inches(self):
        cm = _sim.distance_cm(self.port)
        if cm is None:
            return None
        return cm / 2.54


class ForceSensor:
    """A force (touch) sensor."""

    def __init__(self, port):
        self.port = _check_port(port)
        _sim.force_pressed(self.port)  # friendly error now if there is no force sensor here

    def is_pressed(self):
        return bool(_sim.force_pressed(self.port))

    def get_force_newton(self):
        return _sim.force_newtons(self.port)
`;

/**
 * The `spike.control` module (Python source): waiting helpers + Timer.
 */
const SPIKE_CONTROL_PY = `"""spike.control - waiting helpers and the Timer stopwatch."""

import _sim


def wait_for_seconds(seconds):
    """Pause the program for that many simulated seconds."""
    if not isinstance(seconds, (int, float)):
        raise TypeError('seconds should be a number (got ' + type(seconds).__name__ + ')')
    if seconds < 0:
        raise ValueError('seconds should be 0 or more')
    _sim.wait_seconds(seconds)


def wait_until(condition, timeout=None):
    """Wait until condition() is true, checking about every 0.02 sim seconds.

    condition is a function, e.g. wait_until(lambda: sensor.get_color() == 'red').
    If timeout (seconds) is given, stop waiting after that long.
    """
    if timeout is not None and not isinstance(timeout, (int, float)):
        raise TypeError('timeout should be a number of seconds, or None')
    start = _sim.timer_sec()
    while not condition():
        if timeout is not None and _sim.timer_sec() - start >= timeout:
            return
        _sim.wait_seconds(0.02)


class Timer:
    """A stopwatch counting simulated seconds."""

    def __init__(self):
        self._start = _sim.timer_sec()

    def now(self):
        """Seconds since this Timer was made or last reset."""
        t = _sim.timer_sec() - self._start
        if t < 0:
            # the simulation was reset under us - start over
            self._start = _sim.timer_sec()
            return 0
        return t

    def reset(self):
        self._start = _sim.timer_sec()
`;

let modulesRegistered = false;

/**
 * Install the `_sim` and `spike` modules into Sk.builtinFiles (idempotent).
 * The sources are static strings — the engine instance is read from
 * `Sk.simEngine` at call time, so registering once is enough.
 * @returns {boolean} true if Skulpt is present and the modules are registered
 */
function registerSpikeModules() {
  if (typeof Sk === 'undefined' || !Sk.builtinFiles || !Sk.builtinFiles.files) return false;
  if (!modulesRegistered) {
    Sk.builtinFiles.files['src/lib/_sim.js'] = SIM_MODULE_JS;
    Sk.builtinFiles.files['src/lib/spike/__init__.py'] = SPIKE_INIT_PY;
    Sk.builtinFiles.files['src/lib/spike/control.py'] = SPIKE_CONTROL_PY;
    modulesRegistered = true;
  }
  return true;
}
// Skulpt's script tags load before this module, so this normally succeeds now.
registerSpikeModules();

/**
 * Skulpt `read` hook: serve files from the bundled stdlib + our spike package.
 * @param {string} x file path
 * @returns {string} file contents
 */
function builtinRead(x) {
  if (Sk.builtinFiles === undefined || Sk.builtinFiles.files[x] === undefined) {
    throw "File not found: '" + x + "'";
  }
  return Sk.builtinFiles.files[x];
}

/**
 * Forward Skulpt's stdout (one call per print) to the app console.
 * @param {string} text
 */
function emitUserText(text) {
  let t = String(text);
  if (t.endsWith('\n')) t = t.slice(0, -1); // print() appends one newline per call
  for (const line of t.split('\n')) emit('log', { text: line, level: 'user' });
}

/**
 * Build a readable one-line message from a Skulpt error, with a line number
 * when the traceback has one.
 * @param {*} err
 * @returns {string}
 */
function formatPythonError(err) {
  let msg;
  try {
    msg = err && typeof err.toString === 'function' ? err.toString() : String(err);
  } catch {
    msg = 'Unknown Python error';
  }
  try {
    if (err && err.traceback && err.traceback[0] && err.traceback[0].lineno !== undefined) {
      msg += ' (line ' + err.traceback[0].lineno + ')';
    }
  } catch {
    /* traceback shape surprised us — the message alone is fine */
  }
  return msg;
}

/**
 * Run SPIKE-style Python against the simulator.
 *
 * The returned promise NEVER rejects. It resolves with:
 *  - `{ok: true}` on a clean finish,
 *  - `{ok: true, stopped: true}` when stop() was called (or the sim cancelled
 *    pending commands with Error('SIM_STOPPED'), e.g. on reset),
 *  - `{ok: false, error}` on a Python error, with a kid-readable message.
 *
 * `stop()` interrupts promptly: the flag is checked by Skulpt's suspension
 * handler on every yield (loops are compiled killable). app.js additionally
 * calls `engine.cancelAll('stop')` so in-flight movement promises unblock.
 *
 * @param {string} code Python source
 * @param {import('../core/engine.js').Engine} engine live Engine instance
 * @returns {{promise: Promise<{ok: boolean, stopped?: boolean, error?: string}>, stop: () => void}}
 */
export function runPython(code, engine) {
  let stopRequested = false;
  const sentinel = { spikesimStop: true };

  /** Ask the running program to stop at its next opportunity. */
  const stop = () => { stopRequested = true; };

  if (!registerSpikeModules() || !Sk.misceval || typeof Sk.configure !== 'function') {
    return {
      promise: Promise.resolve({
        ok: false,
        error: 'The Python engine (Skulpt) did not load. Try reloading the page.',
      }),
      stop,
    };
  }

  let settle;
  /** @type {Promise<{ok: boolean, stopped?: boolean, error?: string}>} */
  const promise = new Promise((resolve) => { settle = resolve; });
  const finish = (result) => settle(result); // extra calls are no-ops (promises settle once)

  // A stop can surface as our sentinel (thrown by the interrupt handler),
  // as a raw Error('SIM_STOPPED') from the engine, or as that same error
  // wrapped in Sk.builtin.ExternalError (with .nativeError) by a Python frame.
  const isStop = (err) => {
    if (!err) return false;
    if (err === sentinel || err.spikesimStop === true) return true;
    if (err.message === 'SIM_STOPPED') return true;
    const native = err.nativeError;
    return !!(native && (native.spikesimStop === true || native.message === 'SIM_STOPPED'));
  };

  const resultFor = (err) => {
    if (stopRequested || isStop(err)) return { ok: true, stopped: true };
    if (Sk.builtin && Sk.builtin.SystemExit && err instanceof Sk.builtin.SystemExit) {
      return { ok: true }; // sys.exit() / raise SystemExit = clean end
    }
    return { ok: false, error: formatPythonError(err) };
  };

  try {
    Sk.simEngine = engine;
    Sk.configure({
      output: emitUserText,
      read: builtinRead,
      uncaughtException: (err) => finish(resultFor(err)),
      __future__: Sk.python3,
      killableWhile: true,
      killableFor: true,
      yieldLimit: 100,
    });

    // Called on every Skulpt suspension (promise waits, loop yields, ...).
    // Returning undefined lets Skulpt handle the suspension normally.
    const interrupt = () => {
      if (stopRequested) throw sentinel;
    };

    Sk.misceval
      .asyncToPromise(() => Sk.importMainWithBody('<stdin>', false, code, true), { '*': interrupt })
      .then(
        () => finish(stopRequested ? { ok: true, stopped: true } : { ok: true }),
        (err) => finish(resultFor(err))
      );
  } catch (err) {
    finish(resultFor(err));
  }

  return { promise, stop };
}
