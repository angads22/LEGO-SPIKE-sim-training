/**
 * SpikeSim SPIKE 3 Python runtime — Pyodide (real CPython in WASM) + the
 * SPIKE 3 module set (hub, runloop, motor, motor_pair, color, color_sensor,
 * distance_sensor, force_sensor). See docs/CONTRACT.md, AGENT-SPIKE3 section.
 *
 * How it works:
 *  - Pyodide is vendored at vendor/pyodide/ and loaded ONCE (lazily, or via
 *    preloadPyodide()); the instance is cached module-level and reused.
 *  - A JS bridge module `_simjs` (registerJsModule) wraps `engine.api`. Sync
 *    calls return values directly; async calls START the action immediately
 *    and return the engine's sim-time JS Promise (Python awaits it).
 *  - The SPIKE 3 modules are ONE Python bootstrap source, re-executed into a
 *    fresh module object for every run and written into sys.modules, so no
 *    state (motor pairs, offsets, pending coroutines) leaks between runs.
 *  - `runloop.run(*coros)` does NOT gather immediately: it stashes a lazy
 *    handle. Awaiting the handle (user wrote `await runloop.run(...)`) starts
 *    an asyncio.gather; if the program never awaits it (the normal
 *    `runloop.run(main())` as the last line), run_program() drives every
 *    unconsumed handle to completion after the user code finishes. Pyodide's
 *    WebLoop has no usable run_until_complete, so this "stash, then await on
 *    the Python side" is what actually runs the program.
 *  - User code is compiled from a lightly transformed AST: every loop body in
 *    an awaitable scope (module level / async def) gets an injected
 *    `await __spikesim_tick__()`. The tick checks the stop flag on every
 *    iteration and yields to the browser at most every ~12 ms, so tight
 *    robot loops (the classic sync-read + motor_pair.move P-controller) keep
 *    the page alive, see fresh sensor values, and stop within ~100 ms.
 *    KNOWN LIMIT: a CPU-bound loop inside a plain sync `def` can never yield
 *    or be interrupted (that would need SharedArrayBuffer + a worker); real
 *    robot loops live in async defs / module scope, where the tick applies,
 *    and every sync sensor read also checks the stop flag.
 *  - Stop: stop() sets a flag; every bridge call checks it and throws
 *    Error('SIM_STOPPED'); engine promise rejections carry the same message.
 *    The Python side converts those into SimStopped (a BaseException
 *    subclass, so a kid's `except Exception:` can't swallow it — and unlike
 *    SystemExit, asyncio Tasks do not re-raise it into the event loop, so a
 *    stop leaves no unhandled-rejection noise) and runPython3 maps
 *    SimStopped/SystemExit/SIM_STOPPED to {ok:true, stopped:true} — never a
 *    user-visible traceback.
 *
 * Only one program runs at a time (app.js enforces this).
 */
import { emit } from '../core/bus.js';

/** Matches the contract exactly: any SPIKE 3-style import at a line start. */
const SPIKE3_RE = /^\s*(from|import)\s+(hub|runloop|motor_pair|motor|color_sensor|distance_sensor|force_sensor|color)\b/m;

/**
 * Heuristic: does this Python source target the SPIKE 3 API (Pyodide runtime)
 * rather than the SPIKE 2 `spike` package (Skulpt runtime)?
 * @param {string} code Python source
 * @returns {boolean}
 */
export function isSpike3(code) {
  return SPIKE3_RE.test(String(code == null ? '' : code));
}

// ------------------------------------------------------------------ bridge

/**
 * The run currently owning the bridge: `{ engine, stopRequested }`, or null
 * between runs. Bridge calls from leftover coroutines of a finished run see
 * null and throw SIM_STOPPED, so stragglers die at their next call.
 * @type {{engine: import('../core/engine.js').Engine, stopRequested: boolean}|null}
 */
let activeRun = null;

/** Throw the stop sentinel when no run is active or a stop was requested. */
function checkStop() {
  if (!activeRun || activeRun.stopRequested) throw new Error('SIM_STOPPED');
}

/**
 * Turn engine error codes into messages a kid can act on. The SIM_STOPPED
 * sentinel passes through untouched so Python can recognize a clean stop.
 * @param {*} err
 * @returns {Error}
 */
function toBridgeError(err) {
  const msg = err && err.message !== undefined ? String(err.message) : String(err);
  if (msg === 'SIM_STOPPED') return err instanceof Error ? err : new Error('SIM_STOPPED');
  if (msg.startsWith('NO_DEVICE:')) {
    return new Error(`Oops - ${msg.slice(10).trim()}. Open the Build tab to check what is plugged into each port.`);
  }
  if (msg.startsWith('NO_DRIVE:')) {
    return new Error('Oops - this robot has no drive motors set up. Open the Build tab and choose the two drive motor ports.');
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Wrap a sync engine call: check stop, call, map errors. */
function sync(fn) {
  return (...args) => {
    checkStop();
    try {
      return fn(activeRun.engine.api, ...args);
    } catch (err) {
      throw toBridgeError(err);
    }
  };
}

/**
 * Wrap an engine call that returns a sim-time promise. The action starts NOW
 * (so fire-and-forget works like on a real hub); the returned promise carries
 * mapped errors and never surfaces as an unhandled rejection if ignored.
 */
function async_(fn) {
  return (...args) => {
    checkStop();
    let p;
    try {
      p = fn(activeRun.engine.api, ...args);
    } catch (err) {
      throw toBridgeError(err);
    }
    const out = Promise.resolve(p).then(
      (v) => v,
      (err) => { throw toBridgeError(err); }
    );
    out.catch(() => { /* fire-and-forget: rejection already handled above */ });
    return out;
  };
}

/**
 * The `_simjs` module registered into Pyodide. NOTE: never return null or
 * undefined-able values to Python (Pyodide 0.28 maps JS null to `jsnull`,
 * not None) — nulls are converted here (e.g. distance -> -1, ports -> '').
 */
const bridge = {
  // run control
  stop_requested: () => !activeRun || activeRun.stopRequested,
  // Macrotask yield via MessageChannel: unlike setTimeout(0), it is NOT
  // throttled to 1 Hz in hidden/backgrounded tabs, so control loops keep
  // their cadence when the user switches away mid-run.
  next_tick: (() => {
    const ch = new MessageChannel();
    let queue = [];
    ch.port1.onmessage = () => {
      const resolvers = queue;
      queue = [];
      for (const r of resolvers) r();
    };
    return () => new Promise((resolve) => {
      if (queue.push(resolve) === 1) ch.port2.postMessage(0);
    });
  })(),
  sim_time: sync(() => activeRun.engine.getState().t),

  // robot info
  drive_info: sync(() => {
    const d = activeRun.engine.getRobotConfig().drive || {};
    return {
      wheelDiameterCm: Number(d.wheelDiameterCm) || 5.6,
      trackWidthCm: Number(d.trackWidthCm) || 11.2,
      maxDegPerSec: Number(d.maxDegPerSec) || 970,
    };
  }),
  drive_ports: sync(() => {
    const d = activeRun.engine.getRobotConfig().drive || {};
    return [d.leftPort || '', d.rightPort || ''];
  }),

  // single motors (speeds already converted to percent on the Python side)
  motor_run: sync((api, port, pct) => api.motorRun(port, pct)),
  motor_stop: sync((api, port) => api.motorStop(port)),
  motor_speed: sync((api, port) => api.motorGetSpeed(port)),
  motor_position: sync((api, port) => api.motorGetPosition(port)),
  motor_run_for_degrees: async_((api, port, pct, deg) => api.motorRunForDegrees(port, pct, deg)),

  // drive base
  set_drive_ports: sync((api, l, r) => api.setDrivePorts(l, r)),
  reset_drive_ports: sync((api) => api.resetDrivePorts()),
  move_start: sync((api, steering, pct) => api.moveStart(steering, pct)),
  move_start_tank: sync((api, l, r) => api.moveStartTank(l, r)),
  move_stop: sync((api) => api.moveStop()),
  move_for_cm: async_((api, cm, pct, steering) => api.moveForCm(cm, pct, steering)),
  move_tank_for_cm: async_((api, cm, l, r) => api.moveTankForCm(cm, l, r)),

  // hub + sensors
  gyro_yaw: sync((api) => api.gyroYaw()),
  gyro_reset: sync((api) => api.gyroReset()),
  display_write: sync((api, text) => api.displayWrite(text)),
  display_image: sync((api, name) => api.displayImage(name)),
  display_set_pixel: sync((api, x, y, b) => api.displaySetPixel(x, y, b)),
  display_get_pixel: sync((api, x, y) => api.displayGetPixel(x, y)),
  display_clear: sync((api) => api.displayClear()),
  color_name: sync((api, port) => api.colorName(port)),
  reflected: sync((api, port) => api.reflected(port)),
  distance_mm: sync((api, port) => {
    const cm = api.distanceCm(port);
    return cm == null ? -1 : Math.round(cm * 10);
  }),
  force_decinewtons: sync((api, port) => Math.round(api.forceNewtons(port) * 10)),
  force_pressed: sync((api, port) => !!api.forcePressed(port)),

  // time + sound
  wait_seconds: async_((api, sec) => api.waitSeconds(sec)),
  beep: async_((api, freq, sec) => api.beep(freq, sec)),
};

// ------------------------------------------------------- python bootstrap

/**
 * Defined once in Pyodide's global scope: rebuilds the `_spikesim_runtime`
 * module from source, giving every run a clean slate (fresh sys.modules
 * entries, empty motor pairs, no stashed coroutines, offsets cleared).
 */
const BOOT_DEF_PY = `
def __spikesim_boot__(src):
    import sys, types
    mod = types.ModuleType('_spikesim_runtime')
    mod.__file__ = '<spikesim>'
    exec(compile(src, '<spikesim>', 'exec'), mod.__dict__)
    sys.modules['_spikesim_runtime'] = mod
    return mod
`;

/**
 * The SPIKE 3 runtime, in Python. Re-executed for every run by
 * __spikesim_boot__. Keep this free of backticks and dollar-brace (it lives
 * in a JS template literal) — no f-strings, string + concatenation only.
 */
const BOOTSTRAP_PY = `"""SpikeSim SPIKE 3 runtime (one fresh copy per run) - see docs/CONTRACT.md."""

import ast as _ast
import asyncio as _asyncio
import inspect as _inspect
import sys as _sys
import time as _time
import types as _types

import _simjs

_USER_FILE = '<program>'
_TICK_NAME = '__spikesim_tick__'
_PORTS = ('A', 'B', 'C', 'D', 'E', 'F')
_PI = 3.141592653589793


class SimStopped(BaseException):
    """Raised inside the program when the user presses Stop.

    Subclasses BaseException on purpose: a kid's 'except Exception:' cannot
    swallow the Stop button. NOT SystemExit - asyncio Tasks re-raise
    SystemExit into the event loop (noisy unhandled rejections); plain
    BaseException subclasses are stored as the task result instead.
    """


def _check_stop():
    if _simjs.stop_requested():
        raise SimStopped()


def _map_exc(e):
    """Bridge (JS) exception -> Python exception; Stop sentinel stays special."""
    msg = str(e)
    if 'SIM_STOPPED' in msg:
        return SimStopped()
    if msg.startswith('Error: '):
        msg = msg[7:]
    return RuntimeError(msg)


def _sync(fn, *args):
    """Call a bridge function; JS errors become friendly Python errors."""
    try:
        return fn(*args)
    except SimStopped:
        raise
    except Exception as e:
        raise _map_exc(e) from None


class _Awaitable:
    """Awaitable around a JS sim-time promise. The action has ALREADY started,
    so forgetting the await still does the thing (like a real hub)."""

    __slots__ = ('_p',)

    def __init__(self, p):
        self._p = p

    def __await__(self):
        return self._wait().__await__()

    async def _wait(self):
        try:
            return await self._p
        except Exception as e:
            raise _map_exc(e) from None


def _start(fn, *args):
    """Start an async bridge call now; return an awaitable handle for it."""
    return _Awaitable(_sync(fn, *args))


def _num(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(what + ' should be a number (got ' + type(value).__name__ + ')')
    return value


def _clamp(v, lo, hi):
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


_DRIVE = _simjs.drive_info()
_MAX_DPS = float(_DRIVE.maxDegPerSec)
_WHEEL_CM = _PI * float(_DRIVE.wheelDiameterCm)


def _v2p(velocity):
    """SPIKE 3 velocity (deg/s) -> engine speed percent."""
    return _clamp(_num(velocity, 'velocity') / _MAX_DPS * 100.0, -100.0, 100.0)


def _steer(steering):
    return int(_clamp(_num(steering, 'steering'), -100, 100))


def _port_arg(p):
    if isinstance(p, str) and p.upper() in _PORTS:
        return p.upper()
    if isinstance(p, int) and not isinstance(p, bool) and 0 <= p <= 5:
        return _PORTS[p]
    raise ValueError(repr(p) + ' is not a port. Use port.A .. port.F from the hub module.')


def _module(name, **attrs):
    m = _types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    _sys.modules[name] = m
    return m


# ---------------------------------------------------------- background tasks

_pending_runs = []   # unconsumed runloop.run(...) handles
_spawned = []        # asyncio futures for run_for_time / move_for_time tails


def _silence(fut):
    # Retrieve (and drop) the exception so asyncio never logs
    # 'Task exception was never retrieved' for fire-and-forget calls.
    if fut.cancelled():
        return
    try:
        fut.exception()
    except Exception:
        pass


class _TaskHandle:
    """Awaitable for an already-scheduled background task."""

    __slots__ = ('_fut',)

    def __init__(self, fut):
        self._fut = fut

    def __await__(self):
        return self._fut.__await__()


def _spawn(coro):
    fut = _asyncio.ensure_future(coro)
    fut.add_done_callback(_silence)
    _spawned.append(fut)
    return _TaskHandle(fut)


async def _timed_stop(duration_ms, stop_fn):
    # On Stop the await raises SimStopped and the engine has already braked
    # every motor, so skipping stop_fn then is correct.
    await _start(_simjs.wait_seconds, max(0.0, _num(duration_ms, 'duration') / 1000.0))
    stop_fn()


# --------------------------------------------------------- cooperative tick

# Injected at the top of every loop body that may await (module level and
# async defs). Checks the stop flag on EVERY iteration and yields to the
# browser at most every ~12 ms, so tight robot loops stay responsive without
# slowing compute-heavy loops to the frame rate.
_TICK_EVERY = 0.012
_last_yield = _time.monotonic()


async def _tick():
    global _last_yield
    _check_stop()
    now = _time.monotonic()
    if now - _last_yield >= _TICK_EVERY:
        _last_yield = now
        await _simjs.next_tick()


# --------------------------------------------------------------------- hub

def _ms_reset_yaw(angle=0):
    # A non-zero offset is not supported by the simulator and is ignored.
    _sync(_simjs.gyro_reset)


def _ms_tilt_angles():
    # (yaw, pitch, roll) in decidegrees; yaw clockwise-positive per contract.
    return (int(round(_sync(_simjs.gyro_yaw) * 10)), 0, 0)


_IMAGE_NAMES = ('HEART', 'HEART_SMALL', 'HAPPY', 'SAD', 'YES', 'NO',
                'ARROW_N', 'ARROW_S', 'ARROW_E', 'ARROW_W', 'SQUARE',
                'SQUARE_SMALL', 'DIAMOND', 'TRIANGLE', 'DUCK', 'SMILE')


def _lm_write(text):
    _sync(_simjs.display_write, str(text))


def _lm_off():
    _sync(_simjs.display_write, '')


def _lm_clear():
    _sync(_simjs.display_clear)


def _lm_show_image(image):
    _sync(_simjs.display_image, str(image))


def _lm_set_pixel(x, y, intensity=100):
    # SPIKE 3 intensity is 0..100; the engine grid is 0..9.
    b = int(round(_clamp(_num(intensity, 'intensity'), 0, 100) / 100.0 * 9))
    _sync(_simjs.display_set_pixel, int(x), int(y), b)


def _lm_get_pixel(x, y):
    b = int(_sync(_simjs.display_get_pixel, int(x), int(y)))
    return int(round(b / 9.0 * 100))


def _snd_beep(freq=440, ms=200, volume=100):
    f = _num(freq, 'freq')
    return _start(_simjs.beep, f, max(0.0, _num(ms, 'ms') / 1000.0))


def _btn_pressed(button=0):
    return False  # the simulated hub has no physical buttons


hub = _module('hub')
hub.port = _module('hub.port', A='A', B='B', C='C', D='D', E='E', F='F')
hub.motion_sensor = _module('hub.motion_sensor',
                            reset_yaw=_ms_reset_yaw, tilt_angles=_ms_tilt_angles)
hub.light_matrix = _module('hub.light_matrix', write=_lm_write, off=_lm_off,
                           clear=_lm_clear, show_image=_lm_show_image,
                           set_pixel=_lm_set_pixel, get_pixel=_lm_get_pixel)
for _img in _IMAGE_NAMES:
    setattr(hub.light_matrix, 'IMAGE_' + _img, _img)
hub.sound = _module('hub.sound', beep=_snd_beep)
hub.button = _module('hub.button', LEFT=0, RIGHT=1, pressed=_btn_pressed)


# ------------------------------------------------------------------ runloop

async def _shield_exit(aw):
    # Keep raw SystemExit (sys.exit()) inside the coroutine: asyncio Tasks
    # re-raise it into the event loop, which shows up as unhandled-rejection
    # noise. SimStopped carries the same meaning without the re-raise.
    try:
        return await aw
    except SystemExit:
        raise SimStopped() from None


class _RunHandle:
    """Returned by runloop.run(...). Lazy: the coroutines only start when the
    handle is awaited - either by the user ('await runloop.run(...)') or by
    run_program() after the last line of the script (the normal
    'runloop.run(main())' pattern). Lazy start keeps two sequential
    runloop.run(...) calls sequential, like on a real hub."""

    __slots__ = ('_aws', '_fut', '_consumed')

    def __init__(self, aws):
        self._aws = list(aws)
        self._fut = None
        self._consumed = False

    def _gather(self):
        if self._fut is None:
            self._fut = _asyncio.gather(*[_shield_exit(a) for a in self._aws])
        return self._fut

    def __await__(self):
        self._consumed = True
        return self._gather().__await__()


def _rl_run(*functions):
    for f in functions:
        if not _inspect.isawaitable(f):
            raise TypeError('runloop.run(...) needs called coroutines, like runloop.run(main())')
    h = _RunHandle(functions)
    _pending_runs.append(h)
    return h


def _rl_sleep_ms(duration):
    return _start(_simjs.wait_seconds, max(0.0, _num(duration, 'duration') / 1000.0))


async def _rl_until_wait(function, timeout_ms):
    start = _sync(_simjs.sim_time)
    while True:
        _check_stop()
        if function():
            return True
        if timeout_ms is not None and (_sync(_simjs.sim_time) - start) * 1000.0 >= timeout_ms:
            return True  # timing out just stops the waiting, like SPIKE 3
        await _start(_simjs.wait_seconds, 0.02)


def _rl_until(function, timeout_ms=None):
    if not callable(function):
        raise TypeError('runloop.until(...) needs a function, like runloop.until(lambda: sensor_sees_red())')
    if timeout_ms is not None:
        _num(timeout_ms, 'timeout_ms')
    return _rl_until_wait(function, timeout_ms)


runloop = _module('runloop', run=_rl_run, sleep_ms=_rl_sleep_ms, until=_rl_until)


# -------------------------------------------------------------------- motor

_rel_offset = {}


def _mot_run(port, velocity, **_kw):
    _sync(_simjs.motor_run, _port_arg(port), _v2p(velocity))


def _mot_stop(port, **_kw):
    _sync(_simjs.motor_stop, _port_arg(port))


def _mot_velocity(port):
    return int(round(_sync(_simjs.motor_speed, _port_arg(port))))


def _mot_relative_position(port):
    p = _port_arg(port)
    return int(round(_sync(_simjs.motor_position, p) - _rel_offset.get(p, 0.0)))


def _mot_reset_relative_position(port, position=0):
    # The engine position is not writable; track an offset here instead.
    p = _port_arg(port)
    _rel_offset[p] = _sync(_simjs.motor_position, p) - _num(position, 'position')


def _mot_absolute_position(port):
    return int(round(_sync(_simjs.motor_position, _port_arg(port)))) % 360


def _mot_run_for_degrees(port, degrees, velocity, **_kw):
    p = _port_arg(port)
    pct = _v2p(velocity)
    d = _num(degrees, 'degrees')
    if pct < 0:  # SPIKE rule: direction = sign(degrees) x sign(velocity)
        d, pct = -d, -pct
    return _start(_simjs.motor_run_for_degrees, p, pct, d)


def _mot_run_for_time(port, duration, velocity, **_kw):
    p = _port_arg(port)
    _sync(_simjs.motor_run, p, _v2p(velocity))
    return _spawn(_timed_stop(duration, lambda: _sync(_simjs.motor_stop, p)))


motor = _module(
    'motor',
    run=_mot_run, stop=_mot_stop, velocity=_mot_velocity,
    relative_position=_mot_relative_position,
    reset_relative_position=_mot_reset_relative_position,
    absolute_position=_mot_absolute_position,
    run_for_degrees=_mot_run_for_degrees, run_for_time=_mot_run_for_time,
)


# --------------------------------------------------------------- motor_pair

_pairs = {}


_active_pair = None  # which pair the drive base currently points at


def _mp_pair(pair, left, right):
    global _active_pair
    if pair not in (0, 1, 2):
        raise ValueError('pair should be motor_pair.PAIR_1, PAIR_2 or PAIR_3')
    lp = _port_arg(left)
    rp = _port_arg(right)
    if lp == rp:
        raise ValueError('The two motors of a pair must be on different ports')
    # Point the movement motors at these ports for the rest of the run, exactly
    # as written: left argument = left wheel. Errors kindly if a port has no
    # motor. (This also makes steering honor the pairing order — previously a
    # reversed pairing steered the wrong way.)
    _sync(_simjs.set_drive_ports, lp, rp)
    _pairs[pair] = (lp, rp)
    _active_pair = pair


def _mp_get(pair):
    global _active_pair
    entry = _pairs.get(pair)
    if entry is None:
        raise RuntimeError('Call motor_pair.pair(motor_pair.PAIR_1, <left port>, <right port>) before moving a pair.')
    # Several pairs can exist; re-point the drive base only when a DIFFERENT
    # pair moved last. Tracked Python-side so the single-pair common case (a
    # 50 Hz control loop) pays no extra JS-bridge crossing per move.
    if _active_pair != pair:
        _sync(_simjs.set_drive_ports, entry[0], entry[1])
        _active_pair = pair
    return entry


def _mp_move(pair, steering, *, velocity=360, **_kw):
    _mp_get(pair)
    _sync(_simjs.move_start, _steer(steering), _v2p(velocity))


def _mp_move_tank(pair, left_velocity, right_velocity, **_kw):
    _mp_get(pair)
    _sync(_simjs.move_start_tank, _v2p(left_velocity), _v2p(right_velocity))


def _mp_stop(pair, **_kw):
    _mp_get(pair)
    _sync(_simjs.move_stop)


def _mp_move_for_degrees(pair, degrees, steering, *, velocity=360, **_kw):
    _mp_get(pair)
    cm = _num(degrees, 'degrees') / 360.0 * _WHEEL_CM  # WHEEL degrees -> cm
    return _start(_simjs.move_for_cm, cm, _v2p(velocity), _steer(steering))


def _mp_move_tank_for_degrees(pair, degrees, left_velocity, right_velocity, **_kw):
    _mp_get(pair)
    cm = _num(degrees, 'degrees') / 360.0 * _WHEEL_CM
    return _start(_simjs.move_tank_for_cm, cm, _v2p(left_velocity), _v2p(right_velocity))


def _mp_move_for_time(pair, duration, steering, *, velocity=360, **_kw):
    _mp_get(pair)
    _sync(_simjs.move_start, _steer(steering), _v2p(velocity))
    return _spawn(_timed_stop(duration, lambda: _sync(_simjs.move_stop)))


motor_pair = _module(
    'motor_pair',
    PAIR_1=0, PAIR_2=1, PAIR_3=2,
    pair=_mp_pair, move=_mp_move, move_tank=_mp_move_tank, stop=_mp_stop,
    move_for_degrees=_mp_move_for_degrees,
    move_tank_for_degrees=_mp_move_tank_for_degrees,
    move_for_time=_mp_move_for_time,
)


# ---------------------------------------------------------- color + sensors

color = _module(
    'color',
    BLACK=0, MAGENTA=1, PURPLE=2, BLUE=3, AZURE=4, TURQUOISE=5,
    GREEN=6, YELLOW=7, ORANGE=8, RED=9, WHITE=10, UNKNOWN=-1,
)

_COLOR_CODES = {
    'black': 0, 'violet': 2, 'blue': 3, 'azure': 4,
    'green': 6, 'yellow': 7, 'red': 9, 'white': 10, 'none': -1,
}
_COLOR_RGB = {  # mirrors the engine's SPIKE color anchors (0..255 each)
    0: (15, 15, 18), 2: (145, 70, 210), 3: (40, 80, 220), 4: (90, 185, 235),
    6: (60, 165, 75), 7: (250, 205, 50), 9: (215, 60, 55), 10: (245, 245, 240),
}


def _cs_color(port):
    return _COLOR_CODES.get(_sync(_simjs.color_name, _port_arg(port)), -1)


def _cs_reflection(port):
    return int(round(_sync(_simjs.reflected, _port_arg(port))))


def _cs_rgbi(port):
    # Approximate: color anchor scaled to 0..1024, intensity from reflection.
    p = _port_arg(port)
    code = _COLOR_CODES.get(_sync(_simjs.color_name, p), -1)
    i = int(round(_clamp(_sync(_simjs.reflected, p), 0, 100) * 10.24))
    rgb = _COLOR_RGB.get(code)
    if rgb is None:
        return (i, i, i, i)  # nothing recognisable underneath
    return (rgb[0] * 4, rgb[1] * 4, rgb[2] * 4, i)


color_sensor = _module('color_sensor',
                       color=_cs_color, reflection=_cs_reflection, rgbi=_cs_rgbi)


def _ds_distance(port):
    return int(_sync(_simjs.distance_mm, _port_arg(port)))  # mm; -1 = out of range


distance_sensor = _module('distance_sensor', distance=_ds_distance)


def _fs_force(port):
    return int(_sync(_simjs.force_decinewtons, _port_arg(port)))  # decinewtons 0..100


def _fs_pressed(port):
    return bool(_sync(_simjs.force_pressed, _port_arg(port)))


force_sensor = _module('force_sensor', force=_fs_force, pressed=_fs_pressed)


# ------------------------------------------------------------ program runner

class _LoopYielder(_ast.NodeTransformer):
    """Inserts 'await __spikesim_tick__()' at the top of every loop body whose
    surrounding scope can await (module level or an async def)."""

    def __init__(self):
        self._can_await = [True]  # module level: top-level await is allowed

    def _sync_scope(self, node):
        self._can_await.append(False)
        self.generic_visit(node)
        self._can_await.pop()
        return node

    def _async_scope(self, node):
        self._can_await.append(True)
        self.generic_visit(node)
        self._can_await.pop()
        return node

    visit_FunctionDef = _sync_scope
    visit_ClassDef = _sync_scope
    visit_AsyncFunctionDef = _async_scope

    def _loop(self, node):
        self.generic_visit(node)
        if self._can_await[-1]:
            tick = _ast.Expr(value=_ast.Await(value=_ast.Call(
                func=_ast.Name(id=_TICK_NAME, ctx=_ast.Load()), args=[], keywords=[])))
            node.body.insert(0, tick)
        return node

    visit_While = _loop
    visit_For = _loop
    visit_AsyncFor = _loop


async def _drain():
    """Drive every runloop.run(...) the program did not await itself."""
    while _pending_runs:
        h = _pending_runs.pop(0)
        if h._consumed:
            continue
        h._consumed = True
        await h._gather()


def _close_future(fut):
    try:
        if fut.done():
            if not fut.cancelled():
                fut.exception()  # mark retrieved: no asyncio warning
        else:
            fut.cancel()
    except Exception:
        pass


def shutdown():
    """Called by the simulator when the run ends: cancel/silence leftovers."""
    while _pending_runs:
        h = _pending_runs.pop()
        if h._fut is not None:
            _close_future(h._fut)
        else:
            for aw in h._aws:
                close = getattr(aw, 'close', None)
                if close is not None:
                    try:
                        close()  # un-started coroutine: no 'never awaited' warning
                    except Exception:
                        pass
    while _spawned:
        _close_future(_spawned.pop())


async def run_program(code):
    """Compile + run one user program, then drive pending runloop.run(...)s."""
    tree = _ast.parse(code, filename=_USER_FILE, mode='exec')
    _LoopYielder().visit(tree)
    _ast.fix_missing_locations(tree)
    co = compile(tree, _USER_FILE, 'exec',
                 flags=_ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, dont_inherit=True)
    scope = {'__name__': '__main__', _TICK_NAME: _tick}
    try:
        result = eval(co, scope)
        if _inspect.iscoroutine(result):  # the module used top-level await
            await result
        await _drain()
    except SystemExit:  # sys.exit() = clean stop (see _shield_exit)
        raise SimStopped() from None
`;

// -------------------------------------------------------------- pyodide load

/** @type {Promise<object>|null} resolves to the (single) Pyodide instance */
let pyodidePromise = null;

/**
 * Forward a stdout/stderr chunk to the app console, one log line per line.
 * @param {string} text
 */
function emitUserLines(text) {
  for (const line of String(text).split('\n')) {
    emit('log', { text: line, level: 'user' });
  }
}

/**
 * Internal-only noise that must never reach the user console: SIM_STOPPED is
 * our private "Stop was pressed" sentinel, and asyncio logs "never retrieved"
 * bookkeeping for fire-and-forget calls (e.g. an un-awaited sound.beep) that
 * get cancelled by Stop. None of it is real program output.
 */
const STDERR_NOISE = /SIM_STOPPED|never retrieved|PyodideFuture|JsException|Task exception/;

/**
 * Forward a stderr chunk, dropping internal stop-bookkeeping lines.
 * @param {string} text
 */
function emitStderrLines(text) {
  for (const line of String(text).split('\n')) {
    if (STDERR_NOISE.test(line)) continue;
    if (line.trim() === '') continue;
    emit('log', { text: line, level: 'error' });
  }
}

/** @private Create + configure the Pyodide instance (called once). */
async function createRuntime() {
  const { loadPyodide } = await import('../../vendor/pyodide/pyodide.mjs');
  const py = await loadPyodide({ indexURL: 'vendor/pyodide/' });
  py.setStdout({ batched: emitUserLines });
  py.setStderr({ batched: emitStderrLines });
  py.registerJsModule('_simjs', bridge);
  py.runPython(BOOT_DEF_PY);
  return py;
}

/** @private Load Pyodide once; a failed load may be retried on the next call. */
function loadRuntime() {
  if (!pyodidePromise) {
    emit('log', { text: 'Loading the SPIKE 3 Python runtime…', level: 'info' });
    pyodidePromise = createRuntime().then(
      (py) => {
        emit('log', { text: 'SPIKE 3 Python runtime ready.', level: 'info' });
        return py;
      },
      (err) => {
        pyodidePromise = null; // allow a retry on the next run
        throw err;
      }
    );
  }
  return pyodidePromise;
}

/**
 * Warm up the Pyodide runtime in the background (~1-2 s once). Safe to call
 * repeatedly; every call shares the same load.
 * @returns {Promise<void>}
 */
export function preloadPyodide() {
  return loadRuntime().then(() => undefined);
}

// ---------------------------------------------------------------- run + stop

/**
 * Build a readable one-line message from a Python error, with the line number
 * of the last USER-code frame when the traceback has one (Pyodide tracebacks
 * include its own <exec>/bootstrap frames — those are skipped).
 * @param {*} err
 * @returns {string}
 */
function formatPythonError(err) {
  let raw;
  try {
    raw = String((err && err.message) || err);
  } catch {
    raw = 'Unknown Python error';
  }
  let line = null;
  const frameRe = /File "<program>", line (\d+)/g;
  let m;
  while ((m = frameRe.exec(raw)) !== null) line = m[1]; // innermost user frame
  const lines = raw.replace(/\s+$/, '').split('\n');
  const msg = (lines[lines.length - 1] || '').trim() || 'Python error';
  return line ? `${msg} (line ${line})` : msg;
}

/**
 * Map an execution error to the runPython result contract. Anything that is
 * (or wraps) the stop sentinel is a clean stop, never a user-visible error.
 * @param {*} err
 * @param {{stopRequested: boolean}} run
 * @returns {{ok: boolean, stopped?: boolean, error?: string}}
 */
function resultFor(err, run) {
  if (run.stopRequested) return { ok: true, stopped: true };
  const type = err && err.type; // Pyodide PythonError carries the Python class name
  if (type === 'SimStopped' || type === 'SystemExit') return { ok: true, stopped: true };
  const text = String((err && err.message) || err);
  if (text.includes('SIM_STOPPED')) return { ok: true, stopped: true };
  return { ok: false, error: formatPythonError(err) };
}

/**
 * @private Load the runtime, bootstrap fresh SPIKE 3 modules, run the program,
 * and clean up. Resolves with the result object; never rejects in practice.
 */
async function execute(code, engine, run) {
  let py;
  try {
    py = await loadRuntime();
  } catch (err) {
    return {
      ok: false,
      error: `Python runtime failed to load: ${(err && err.message) || err}`,
    };
  }

  // Adopt this run: the bridge reads the engine + stop flag from activeRun.
  activeRun = run;

  let rt = null;
  let result;
  try {
    const boot = py.globals.get('__spikesim_boot__');
    try {
      rt = boot(BOOTSTRAP_PY); // fresh module state for this run
    } finally {
      boot.destroy();
    }
    const runProgram = rt.run_program;
    try {
      await runProgram(String(code == null ? '' : code));
    } finally {
      runProgram.destroy();
    }
    result = run.stopRequested ? { ok: true, stopped: true } : { ok: true };
  } catch (err) {
    result = resultFor(err, run);
  } finally {
    // The run is over: any straggler coroutine dies at its next bridge call.
    run.stopRequested = true;
    if (rt) {
      try {
        const sd = rt.shutdown;
        sd();
        sd.destroy();
      } catch { /* nothing left to clean up */ }
      try { rt.destroy(); } catch { /* proxy already gone */ }
    }
    if (activeRun === run) activeRun = null;
  }
  return result;
}

/**
 * Run SPIKE 3-style Python (hub/runloop/motor_pair/... imports) against the
 * simulator on the Pyodide runtime.
 *
 * The returned promise NEVER rejects. It resolves with:
 *  - `{ok: true}` on a clean finish,
 *  - `{ok: true, stopped: true}` when stop() was called, the engine cancelled
 *    pending commands with Error('SIM_STOPPED'), or the program raised
 *    SystemExit,
 *  - `{ok: false, error}` on a Python error, with a kid-readable message and
 *    the user-code line number.
 *
 * `stop()` interrupts promptly: every bridge call (sync sensor reads
 * included) checks the flag, awaited sim promises are rejected by
 * engine.cancelAll('stop') (app.js calls it), and the injected loop tick
 * checks the flag every iteration — a tight `while True:` robot loop stops
 * well within ~100 ms.
 *
 * @param {string} code Python source (SPIKE 3 API)
 * @param {import('../core/engine.js').Engine} engine live Engine instance
 * @returns {{promise: Promise<{ok: boolean, stopped?: boolean, error?: string}>, stop: () => void}}
 */
export function runPython3(code, engine) {
  const run = { engine, stopRequested: false };
  const stop = () => { run.stopRequested = true; };
  const promise = execute(code, engine, run).catch((err) => ({
    ok: false,
    error: `Unexpected simulator error: ${(err && err.message) || err}`,
  }));
  return { promise, stop };
}
