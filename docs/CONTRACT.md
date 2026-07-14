# SpikeSim — Architecture Contract (v1)

This file is the **single source of truth** for module interfaces. Every module must
export EXACTLY the names and signatures written here. If something is ambiguous,
follow the spirit of a LEGO SPIKE Prime educational simulator and keep it simple.

SpikeSim = browser-based LEGO SPIKE Prime-style robot simulator.
- Code the robot in **Blockly blocks** (SPIKE word-block style) or **Python** (SPIKE v2-style API, runs in-browser via Skulpt).
- Simulate on a 2D top-down map (canvas) and in 3D (three.js), with a map editor and a robot/attachment builder.
- Physics v1 is kinematic differential drive, but isolated so it can be swapped for a real physics engine later.
- 100% offline: all libraries are vendored under `vendor/`. No CDN, no build step, plain ES modules + a few UMD script tags.

## File tree & ownership

```
SpikeSim/
├── index.html               (DONE — do not modify)
├── server.js                (DONE)  static server, port 8790
├── start.bat                (DONE)
├── css/app.css              (DONE)
├── js/
│   ├── app.js               (DONE — glue; read it to see how your module is called)
│   ├── core/
│   │   ├── bus.js           (DONE — event bus, read it)
│   │   ├── defaults.js      AGENT-CORE  exports defaultRobot(), presetRobots(), fallbackMap()
│   │   │                                fallbackMap() = simple 160×100 mat, border:true, one line, one obstacle, start {x:20,y:80,headingDeg:0}
│   │   ├── engine.js        AGENT-CORE  Engine class (state, stepping, command API)
│   │   ├── physics.js       AGENT-CORE  diff-drive kinematics + collision (used by engine)
│   │   └── mapraster.js     AGENT-CORE  map JSON → offscreen canvas raster
│   ├── runtime/
│   │   └── pyrun.js         AGENT-PY    Skulpt bridge + embedded `spike` Python package
│   ├── blocks/
│   │   └── blocks.js        AGENT-BLOCKS custom Blockly blocks + Python generators + toolbox
│   ├── view/
│   │   ├── view2d.js        AGENT-2D    2D canvas renderer (pan/zoom, robot drag)
│   │   ├── mapeditor.js     AGENT-2D    map editing tools on top of View2D
│   │   └── view3d.js        AGENT-3D    three.js scene
│   └── ui/
│       └── builder.js       AGENT-BUILD robot/attachment builder panel
├── maps/
│   ├── index.json           AGENT-CONTENT  {"maps":[{"file","name","desc"}...]}
│   └── *.json               AGENT-CONTENT  4 preset maps (schema below)
├── examples/
│   ├── index.json           AGENT-CONTENT  {"python":[{"file","name"}...],"blocks":[{"file","name"}...]}
│   ├── python/*.py          AGENT-CONTENT
│   └── blocks/*.json        AGENT-CONTENT  Blockly serialization JSON
├── docs/
│   ├── CONTRACT.md          (this file)
│   └── TUTORIAL.md          AGENT-CONTENT
└── vendor/                  (DONE) three/, blockly/, skulpt/
```

Rules for all agents:
- Plain JavaScript ES modules (`export` / `import`), no TypeScript, no npm imports at runtime.
- JSDoc on every exported symbol. Reasonable comment density, no noise.
- Never `import` three/Blockly/Skulpt except as described in "Vendored libraries".
- Do not modify files marked DONE or owned by another agent.
- Errors thrown by the engine API use message prefixes given below; catch/report per your section.

## Conventions (memorize these)

- Units: **cm**, **degrees**, **seconds** (simulated time). Speeds given as **percent** (-100..100) at API boundaries.
- World frame (2D): origin top-left of the mat, **x → right, y → down** (canvas-style). Sizes in cm.
- Heading: degrees, **0° = facing +x (east)**, **positive = clockwise** on screen. Stored unwrapped internally; yaw reported wrapped to [-180, 180].
- Robot body frame: **+x = forward, +y = right side of robot**. Device offsets `(x, y)` are cm from robot center in this frame.
  World position of a device: `wx = rx + dx*cos(h) - dy*sin(h)`, `wy = ry + dx*sin(h) + dy*cos(h)` (h in radians).
- 3D mapping (three.js, y-up): `position3D = (x, 0, y2d)`; `mesh.rotation.y = -degToRad(headingDeg)`. Robot model must face **+x** at zero rotation. Forward vector in 3D = `(cos h, 0, sin h)`.
- SPIKE color names (exact strings): `'black','violet','blue','azure','green','yellow','red','white'`, plus `'none'` when nothing is detected. (Python `get_color()` returns `None` for none.)

## Vendored libraries

Loaded by index.html — available as globals to non-module scripts and to modules alike:
- `Blockly` (v13, blockly_compressed.js + blocks_compressed.js + msg/en.js), `python` (python_compressed.js → use `python.pythonGenerator`). Media path: `'vendor/blockly/media/'`.
- `Sk` (Skulpt 1.2: skulpt.min.js + skulpt-stdlib.js). Python 3 mode: `Sk.configure({ __future__: Sk.python3, ... })`.
- three.js is an ES module via import map: `import * as THREE from 'three'` and `import { OrbitControls } from 'three/addons/controls/OrbitControls.js'`. **Only view3d.js imports three.**

## js/core/bus.js (already written — use it exactly)

```js
import { bus, emit, on } from '../core/bus.js';
emit('log', { text: 'hi', level: 'info' });   // levels: 'info' | 'error' | 'user'
on('map-changed', (detail) => { ... });        // returns an unsubscribe function
```
Event names used across the app:
| event | detail | emitted by |
|---|---|---|
| `log` | `{text, level}` | anyone (engine api print, pyrun errors, app) |
| `display` | `{text}` | engine (light matrix write) |
| `beep` | `{freq, sec}` | engine |
| `run-state` | `{running, reason?}` | app.js only |
| `sim-reset` | `{}` | engine.reset() |
| `map-changed` | `{}` | engine.loadMap() |
| `robot-changed` | `{}` | engine.loadRobot() |

## Robot config schema (JSON-serializable)

```json
{
  "name": "Driving Base",
  "chassis": { "lengthCm": 14, "widthCm": 11, "heightCm": 9, "color": "#f5c518" },
  "drive": {
    "leftPort": "A", "rightPort": "B",
    "wheelDiameterCm": 5.6, "trackWidthCm": 11.2,
    "maxDegPerSec": 970, "accelDegPerSec2": 4000
  },
  "devices": [
    { "port": "A", "type": "motor", "role": "drive-left" },
    { "port": "B", "type": "motor", "role": "drive-right" },
    { "port": "C", "type": "motor", "role": "attachment",
      "attachment": { "kind": "arm", "lengthCm": 8, "x": 6, "y": 0 } },
    { "port": "D", "type": "color",    "x": 6,  "y": 0 },
    { "port": "E", "type": "distance", "x": 7.5, "y": 0, "headingDeg": 0 },
    { "port": "F", "type": "force",    "x": 7.5, "y": 0, "headingDeg": 0 }
  ]
}
```
- Ports: `'A'..'F'`, each used at most once. Device `type`: `'motor' | 'color' | 'distance' | 'force'`.
- Motor `role`: `'drive-left' | 'drive-right' | 'attachment'`. Attachment motors may carry an
  `attachment` object (`kind`: `'arm'` v1; `lengthCm`; mount point `x`,`y` in body frame).
- Color sensor points down (samples mat under `(x,y)`). Distance/force sensors face `headingDeg`
  relative to robot forward (default 0).
- `defaults.js` exports `defaultRobot()` returning exactly the config above, plus
  `presetRobots()` → `[{name, config}, ...]` with 3 presets: "Driving Base" (no arm, just sensors),
  "Line Follower" (two color sensors at x=6, y=±2), "Grabber Bot" (the full config above).

## Map schema (JSON-serializable)

```json
{
  "name": "Line Track",
  "widthCm": 236, "heightCm": 114,
  "background": "#e9e5da",
  "border": true,
  "walls": [ { "x1": 30, "y1": 40, "x2": 90, "y2": 40, "heightCm": 10 } ],
  "lines": [ { "color": "#111111", "widthCm": 2.5, "points": [[20,60],[60,30],[120,30]] } ],
  "zones": [ { "x": 10, "y": 10, "w": 30, "h": 30, "color": "#d94040", "label": "Base" } ],
  "obstacles": [ { "x": 100, "y": 50, "w": 10, "h": 10, "heightCm": 8, "color": "#3b6fd4", "movable": false } ],
  "start": { "x": 20, "y": 95, "headingDeg": 0 }
}
```
- `border: true` = solid walls around the mat edge (FLL table style). All arrays optional (treat missing as `[]`).
- Lines/zones are flat paint (color sensor sees them; nothing collides). Walls/obstacles are solid
  (collision + distance-sensor raycasts). Obstacles are axis-aligned boxes, `x,y` = top-left corner. `movable` is reserved for later — treat all obstacles as static in v1.
- `start` = robot start pose (robot center).

## AGENT-CORE — engine.js, physics.js, mapraster.js, defaults.js

### mapraster.js
```js
export const RASTER_SCALE = 4; // px per cm
/** Render a map JSON to a canvas (creates one if omitted). Draws background,
 *  zones, lines, obstacle footprints, wall strokes. NO robot, NO grid. */
export function rasterizeMap(mapJson, canvas?) → HTMLCanvasElement
```
Painting order: background → zones → lines → obstacles (flat fill) → walls (4px dark stroke).
This canvas is BOTH the color-sensor ground truth and the 2D/3D base texture, so keep it clean
(no labels — zone `label` text is drawn only by View2D as an overlay, not in the raster).

### physics.js
```js
/** Pure functions; no state. Engine owns state. */
export function stepDrive(pose, leftDegPerSec, rightDegPerSec, drive, dt) → {x, y, headingDeg}
export function circleSegmentPushOut(cx, cy, r, x1, y1, x2, y2) → {x, y, hit} // corrected center
export function circleRectPushOut(cx, cy, r, rect) → {x, y, hit}
export function raycast(map, ox, oy, angleDeg, maxCm) → {distCm, hit} // walls, obstacles, border
```
Diff drive: wheel deg/s → cm/s via `PI * wheelDiameterCm * (degPerSec/360)`; `v=(vl+vr)/2`,
`omega=(vr-vl)/trackWidthCm` (rad/s, and with y-down this yields clockwise-positive heading — verify sign so that `start_tank(50, -50)` turns RIGHT/clockwise: left wheel forward + right wheel backward must increase headingDeg).

### engine.js
```js
export class Engine {
  constructor()                       // starts with defaultRobot() and no map
  loadRobot(configJson)               // deep-copies, validates, rebuilds motor/device state, emits 'robot-changed'
  loadMap(mapJson)                    // deep-copies, re-rasters, then reset(); emits 'map-changed'
  reset()                             // pose = map.start, motors/timer/yaw/trail cleared, cancelAll('reset'), emits 'sim-reset'
  step(dtSeconds)                     // clamps dt to 0.25, substeps internally at 1/240 s
  cancelAll(reason)                   // reject ALL pending api promises with Error('SIM_STOPPED') AND brake all motors to 0
  getState() → state                  // LIVE object (do not mutate from outside)
  getMapCanvas() → HTMLCanvasElement  // current raster (RASTER_SCALE px/cm)
  getRobotConfig() → json             // deep copy
  getMapJson() → json                 // deep copy
  setPose(x, y, headingDeg)           // for drag placement / editor
  api                                 // command object, see table
}
```

`state` shape (live, updated every step):
```js
{
  t,                                   // sim seconds since reset
  pose: { x, y, headingDeg },          // headingDeg unwrapped
  map, robot,                          // the loaded JSON (engine's own copies)
  trail: [[x,y], ...],                 // appended every >0.5cm of travel, cap 4000
  motors: { A: { posDeg, degPerSec }, ... },   // one entry per motor port
  sensors: { D: { type:'color', color:'red', reflected: 87 },
             E: { type:'distance', cm: 34.2 },        // cm: number|null
             F: { type:'force', newtons: 0, pressed: false }, ... },
  attachments: { C: { kind:'arm', angleDeg } },       // angleDeg = motor posDeg (arm rotates with motor)
  collided: false,                     // true on any wall/obstacle contact this step
  display: ''                          // last light-matrix text
}
```

`engine.api` — all speeds are **percent** (-100..100, clamped; converted internally via
`drive.maxDegPerSec`), distances signed cm, degrees signed (+ = clockwise). Promises resolve on
**sim time** (they advance only inside `step()`), reject with `Error('SIM_STOPPED')` on `cancelAll`.
A new motor/move command **supersedes** a pending run-for on the same motor(s): the superseded
promise RESOLVES early (never rejects).

| member | behavior |
|---|---|
| `motorRun(port, speedPct)` | run continuously |
| `motorStop(port)` | brake to 0 |
| `motorRunForDegrees(port, speedPct, degrees)` → Promise | uses \|speed\|, sign of degrees; resolves when swept, then brakes |
| `motorGetPosition(port)` → deg | accumulated (signed, unwrapped) |
| `motorGetSpeed(port)` → deg/s | current |
| `moveStart(steeringPct, speedPct)` | SPIKE steering: `s>=0 → left=v, right=v*(1-s/50)`; mirror for `s<0` |
| `moveStartTank(leftPct, rightPct)` | |
| `moveStop()` | both drive motors brake |
| `moveForCm(cm, speedPct, steeringPct=0)` → Promise | distance by **wheel odometry** (average of the two wheels) |
| `moveTankForCm(cm, leftPct, rightPct)` → Promise | |
| `turnDegrees(degrees, speedPct)` → Promise | spin in place (tank ±v) until heading delta reached |
| `gyroYaw()` → deg | wrapped [-180,180], relative to last reset |
| `gyroReset()` | |
| `distanceCm(port)` → number\|null | raycast, max 200cm, null beyond |
| `colorName(port)` → string | `'none'` if unclear; sample raster 3×3 under sensor, snap to nearest SPIKE color |
| `reflected(port)` → 0..100 | luminance of sample |
| `forcePressed(port)` → bool | contact within ~1cm in sensor facing |
| `forceNewtons(port)` → 0..10 | proportional to penetration |
| `timerSec()` → number / `timerReset()` | sim-time stopwatch |
| `waitSeconds(sec)` → Promise | sim-time |
| `waitUntil(fn)` → Promise | `fn` (JS bool thunk) checked each substep |
| `print(text)` | `emit('log', {text, level:'user'})` |
| `displayWrite(text)` | sets state.display, clears the grid, `emit('display',{text})` + `emit('matrix',{grid})` |
| `displayImage(image)` | named image / 25-array / `'09090:...'` pattern → `state.matrix`, `emit('matrix',{grid})` |
| `displaySetPixel(x,y,b)` | light pixel (x,y in 0..4) at brightness 0..9, `emit('matrix',{grid})` |
| `displayGetPixel(x,y)` → 0..9 | read one pixel |
| `displayClear()` | all pixels off + text cleared, `emit('matrix',{grid})` + `emit('display',{text:''})` |
| `beep(freqHz, sec)` → Promise | `emit('beep',{freq,sec})`, resolve after sim `sec` |

Light matrix: `state.matrix` is a 25-int (0..9) row-major grid; the UI renders it as a 5×5 LED grid (`emit('matrix',{grid})`). Built-in image names: HEART, HEART_SMALL, HAPPY, SAD, YES, NO, ARROW_N/S/E/W, SQUARE, SQUARE_SMALL, DIAMOND, TRIANGLE, DUCK, SMILE.

Errors: unknown/mismatched port → throw `Error("NO_DEVICE: no <type> on port <P>")` synchronously.
Movement commands throw `Error('NO_DRIVE: drive motors not configured')` if drive ports lack motors.

Motor model: target speed with accel limiting (`drive.accelDegPerSec2`). Collision: robot ≈ circle
(radius = `hypot(lengthCm, widthCm)/2 * 0.92`) pushed out of walls/obstacles/border each substep;
wheels can slip (odometry keeps counting when blocked — document, it's how run-for still finishes).
When no program is running the sim still steps (motors decay to their commanded speeds, normally 0).

## AGENT-PY — runtime/pyrun.js

```js
/** Run SPIKE-style Python. Returns { promise, stop }.
 *  promise resolves {ok:true} on clean end, {ok:false, error:string} on Python error,
 *  and {ok:true, stopped:true} when stop() was called. NEVER rejects.
 *  stop() interrupts promptly (flag checked by Skulpt yield handler) and engine.cancelAll('stop') is
 *  called by app.js — treat Error('SIM_STOPPED') bubbling out of a suspension as a clean stop. */
export function runPython(code, engine) → { promise, stop }
```
Implementation requirements:
- `Sk.configure({ output, uncaughtException, __future__: Sk.python3, read, killableWhile: true, killableFor: true, yieldLimit: 100 })`; run via `Sk.misceval.asyncToPromise(() => Sk.importMainWithBody('<stdin>', false, code, true), { '*': interruptHandler })`.
- `output` → `emit('log', {text, level:'user'})` (strip trailing newline per call is fine).
- Python tracebacks → `{ok:false, error}` with a readable message incl. line number (`err.toString()` + `err.traceback` if present).
- Register a native JS module `_sim` via `Sk.builtinFiles['src/lib/_sim.js']` (string containing
  `var $builtinmodule = function(name){...}`) that wraps `engine.api`. Async api calls return
  `Sk.misceval.promiseToSuspension(promise)`. Sync calls remap via `Sk.ffi.remapToPy`.
- Register the `spike` package as Python source in `Sk.builtinFiles`:
  `'src/lib/spike/__init__.py'` and `'src/lib/spike/control.py'`, implementing the API below on top of `_sim`.
- The engine instance is handed to the module via a module-scoped variable in pyrun.js (e.g. set
  `pyrun._engine = engine` before configure; the `_sim` builtin closes over pyrun's scope — since
  builtinFiles is a string, expose the engine on `Sk.simEngine = engine` and read that inside the module source).

### The `spike` Python API (SPIKE v2 style — this is what users learn)

```python
from spike import PrimeHub, Motor, MotorPair, ColorSensor, DistanceSensor, ForceSensor
from spike.control import wait_for_seconds, wait_until, Timer

hub = PrimeHub()
hub.motion_sensor.get_yaw_angle()      # int, [-180,180]
hub.motion_sensor.reset_yaw_angle()
hub.light_matrix.write("HI")           # shows on the sim hub display
hub.light_matrix.off()
hub.speaker.beep(60, 0.2)              # MIDI note (freq = 440*2**((n-69)/12)), seconds; blocks for the duration

m = Motor('C')                         # NO_DEVICE error if port isn't a motor
m.run_for_rotations(1, speed=None); m.run_for_degrees(90); m.run_for_seconds(0.5)
m.start(speed=None); m.stop(); m.set_default_speed(50)   # default default = 50
m.get_position()          # 0..359
m.get_degrees_counted()   # signed, unwrapped
m.get_speed()             # percent (deg/s ÷ maxDegPerSec × 100, rounded)

mp = MotorPair()                       # defaults to the robot's configured drive ports
mp = MotorPair('A', 'B')               # explicit is also allowed (validated)
mp.move(30, 'cm', steering=0, speed=None)      # units: 'cm','in','rotations','degrees','seconds'
mp.move_tank(30, 'cm', left_speed=None, right_speed=None)
mp.start(steering=0, speed=None); mp.start_tank(50, 50); mp.stop()
mp.set_default_speed(50)
mp.turn(90, speed=None)                # SIM EXTENSION (not real SPIKE): gyro turn, + = right/clockwise

cs = ColorSensor('D'); cs.get_color()            # 'red'/... or None
cs.get_reflected_light()                          # 0..100
ds = DistanceSensor('E'); ds.get_distance_cm()   # float or None
ds.get_distance_inches()
fs = ForceSensor('F'); fs.is_pressed(); fs.get_force_newton()

t = Timer(); t.now(); t.reset()        # sim seconds
wait_for_seconds(1.5)
wait_until(lambda: cs.get_color() == 'red')      # poll ~every 20ms of sim time
```
Unit conversions in Python: `'in'` = 2.54 cm; `'rotations'/'degrees'` are WHEEL rotations/degrees →
cm via `pi * wheelDiameterCm` (read wheel diameter via a `_sim.drive_info()` call returning
`{wheelDiameterCm, trackWidthCm, maxDegPerSec}`); `'seconds'` = run then stop after that sim time.
Speeds `None` → the object's default speed (per-object, default 50).
Negative amount or negative speed = backward (SPIKE behavior: sign of amount × sign of speed).

## AGENT-BLOCKS — blocks/blocks.js

```js
export function initBlocks(hostEl) → workspace   // Blockly.inject with zelos renderer
export function generatePython(workspace) → string  // COMPLETE runnable program (see rules)
export function serialize(workspace) → object       // Blockly.serialization.workspaces.save
export function deserialize(workspace, obj)         // ...load (clears first)
export function loadStarter(workspace)              // small demo: start → set speed 40 → move 20cm → turn 90 → beep
```
Inject options: `{ renderer:'zelos', media:'vendor/blockly/media/', toolbox, trashcan:true, zoom:{controls:true, wheel:true, startScale:0.75}, grid:{spacing:24, length:2, snap:true} }`.
Register generators as `python.pythonGenerator.forBlock['<type>'] = (block, generator) => ...`.

generatePython rules:
- Header (always):
  ```python
  from spike import PrimeHub, Motor, MotorPair, ColorSensor, DistanceSensor, ForceSensor
  from spike.control import wait_for_seconds, wait_until, Timer
  hub = PrimeHub()
  mp = MotorPair()
  timer = Timer()
  ```
  plus one constructor line per port actually used by sensor/motor blocks, scanned from the
  workspace: `motor_c = Motor('C')`, `color_d = ColorSensor('D')`, `distance_e = DistanceSensor('E')`, `force_f = ForceSensor('F')` (variable = `<kind>_<port lowercase>`).
- Body: only stacks headed by a `spike_start` hat, concatenated in workspace order. Other orphan stacks ignored. No hat → return header + `# add a "when program starts" block`.
- Call `generator.init(workspace)` first and include `generator.finish('')` variable preamble if non-empty.

### Block catalog (exact type names, field/input names, generated Python)

Toolbox categories (colors): Motors `#0090F5`, Movement `#FF4FA7`, Light `#9B6AF6`,
Sensors `#28C1E8`, Control `#FFBF00`, Operators `#41C978`, Variables (built-in dynamic category).

**Movement** (all statement blocks unless noted)
| type | message & fields | python |
|---|---|---|
| `spike_start` | HAT "when program starts" (nextStatement only, no prev) | (none — marks program entry) |
| `spike_move_cm` | "move [DIR: FWD/BACK] [DIST:number-input] cm" | `mp.move(D, 'cm')` where D = DIST or -DIST |
| `spike_turn` | "turn [DIR: RIGHT/LEFT] [DEG:number-input] degrees" | `mp.turn(DEG)` / `mp.turn(-DEG)` |
| `spike_move_start` | "start moving [STEER:number-input] steering" | `mp.start(STEER)` |
| `spike_move_tank` | "start tank left [L:number] right [R:number]" | `mp.start_tank(L, R)` |
| `spike_move_stop` | "stop moving" | `mp.stop()` |
| `spike_set_move_speed` | "set movement speed to [PCT:number] %" | `mp.set_default_speed(PCT)` |

**Motors**
| `spike_motor_run_for` | "[PORT: A..F] run [DIR: CW/CCW] for [VAL:number] [UNIT: ROT/DEG/SEC]" | `motor_p.run_for_rotations(±VAL)` / `run_for_degrees` / `run_for_seconds` |
| `spike_motor_start` | "[PORT] start motor [DIR: CW/CCW]" | `motor_p.start()` / `motor_p.start(-motor_p_speed)`  → simpler: `motor_p.start()` with sign folded: generate `motor_p.start(-abs_default)`? NO — generate `motor_p.start()` for CW and `motor_p.start(-100000)`? — **Decision: generate `motor_p.start()` (CW) / `motor_p.start(-motor_p._default_speed if False else None)` is silly. Use: CW → `motor_p.start()`, CCW → `motor_p.start(-motor_p.get_default_speed())` — so `Motor` must expose `get_default_speed()`.** AGENT-PY: add `get_default_speed()` to Motor and MotorPair. |
| `spike_motor_stop` | "[PORT] stop motor" | `motor_p.stop()` |
| `spike_motor_set_speed` | "[PORT] set motor speed [PCT:number] %" | `motor_p.set_default_speed(PCT)` |
| `spike_motor_position` | (output Number) "[PORT] motor degrees" | `motor_p.get_degrees_counted()` |

**Light**
| `spike_display_write` | "display write [TEXT:input(any)]" | `hub.light_matrix.write(str(TEXT))` |
| `spike_display_image` | "display image [IMG: image dropdown]" | `hub.light_matrix.show_image('IMG')` |
| `spike_display_off` | "turn off display" | `hub.light_matrix.off()` |
| `spike_beep` | "beep note [NOTE:number] for [SEC:number] s" | `hub.speaker.beep(NOTE, SEC)` |
| `spike_print` | "print [VALUE:input(any)]" | `print(VALUE)` |

**Functions** — toolbox category `custom: 'PROCEDURE'` (Blockly's built-in `procedures_*`
def/call blocks). `generatePython()` also runs `blockToCode` on every `procedures_defnoreturn`
/`procedures_defreturn` top block so the `def`s land in the preamble (orphan stacks that are
not `spike_start` hats are otherwise skipped).

**Sensors** (output blocks except reset)
| `spike_color` | (output String) "[PORT] color" | `str(color_p.get_color())` |
| `spike_is_color` | (output Boolean) "[PORT] sees [COLOR: dropdown of the 8 colors + none]" | `(color_p.get_color() == 'COLOR')` — for `none` compare `is None` |
| `spike_reflected` | (output Number) "[PORT] reflected light" | `color_p.get_reflected_light()` |
| `spike_distance` | (output Number) "[PORT] distance cm" | `(distance_p.get_distance_cm() or 999)` |
| `spike_force_pressed` | (output Boolean) "[PORT] pressed?" | `force_p.is_pressed()` |
| `spike_yaw` | (output Number) "yaw angle" | `hub.motion_sensor.get_yaw_angle()` |
| `spike_reset_yaw` | "reset yaw" | `hub.motion_sensor.reset_yaw_angle()` |
| `spike_timer` | (output Number) "timer" | `timer.now()` |
| `spike_reset_timer` | "reset timer" | `timer.reset()` |

**Control**
| `spike_wait_seconds` | "wait [SEC:number-input] seconds" | `wait_for_seconds(SEC)` |
| `spike_wait_until` | "wait until [COND:input(Boolean)]" | `wait_until(lambda: bool(COND))` |
| `spike_forever` | "forever [DO:statements]" | `while True:` + body (+ `pass` if empty) |
plus Blockly built-ins in the toolbox: `controls_repeat_ext`, `controls_whileUntil`, `controls_if`
(Control), `logic_compare`, `logic_operation`, `logic_negate`, `logic_boolean`, `math_number`,
`math_arithmetic`, `math_random_int`, `text`, `text_join` (Operators), Variables category.

Number fields use shadow `math_number` inputs (so kids can drop reporters in). PORT fields are
dropdowns A–F (field name `PORT`). Keep block text short like real SPIKE blocks.

## AGENT-2D — view/view2d.js + view/mapeditor.js

```js
export class View2D {
  constructor(canvasEl, engine)
  render()                      // one frame; app.js calls this in its rAF when 2D tab is active
  resize()                      // match canvas to its CSS size * devicePixelRatio
  fitToMap()                    // center & fit map with 5% margin
  screenToWorld(clientX, clientY) → [xCm, yCm]
  setRobotDragEnabled(bool)     // drag robot to move; SHIFT+drag rotates. Calls engine.setPose. Default ON; app disables while running.
  overlay                      // {draw: null|fn(ctx2d, view)} — mapeditor installs its overlay here
  worldToScreen(x, y) → [px, py]
  pxPerCm                      // current zoom (number, getter)
}
```
Rendering each frame: engine.getMapCanvas() drawn with pan/zoom transform → zone labels →
start-pose marker → trail (fading polyline) → robot (chassis rounded-rect in config color, two
wheels, direction chevron, devices as colored dots: color sensor shows the color it currently
reads, distance sensor draws its ray to hit point with distance text, force sensor red nub, arm
attachment as a rotating beam using `state.attachments`) → red flash border when `state.collided`.
Pan = drag empty space; zoom = wheel (0.5..20 px/cm, zoom to cursor). Call `fitToMap()` on first
render and on 'map-changed'.

```js
export class MapEditor {
  constructor(view2d, engine, toolbarEl)  // builds its buttons/inputs inside toolbarEl
  activate()   // shows tools, hooks pointer events on the 2D canvas (capture phase before View2D pan)
  deactivate()
}
```
Tools: **select/move** (drag walls/obstacles/zones; DEL key deletes selection), **wall** (drag a
segment), **line** (click to add points, double-click/Enter to finish; color+width inputs),
**zone** (drag rect + color), **obstacle** (drag rect), **start** (click sets position, drag sets
heading), **erase** (click object). Buttons: Clear all, Undo (single-level is fine),
Export JSON (download), Import JSON (file input), Save as… (prompt name → localStorage
`spikesim.maps.custom`, then `emit('log',…)` confirmation). Every edit applies via
`engine.loadMap(updatedJson)` (note: this resets the robot — acceptable in edit mode) and edits
work on a deep copy from `engine.getMapJson()`. Draw selection/handles via `view2d.overlay.draw`.

## AGENT-3D — view/view3d.js

```js
export class View3D {
  constructor(hostEl, engine)   // lazy: build scene on first activate()
  activate(); deactivate()      // renderer.setAnimationLoop inside activate, null on deactivate
  resize()
  setFollow(bool)               // follow-cam behind robot vs free OrbitControls
}
```
- `import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js'`.
- Ground: `PlaneGeometry(widthCm, heightCm)` with `CanvasTexture(engine.getMapCanvas())`, laid flat
  (rotation.x = -PI/2), positioned so texture aligns with world coords: world (x,y) → 3D (x, 0, y); set `texture.colorSpace = THREE.SRGBColorSpace`, `texture.needsUpdate = true` on 'map-changed' (also rebuild walls).
- Walls/obstacles: boxes at their heightCm, subtle materials. Border walls when `map.border`.
- Robot: THREE.Group rebuilt on 'robot-changed' from engine.getRobotConfig(): yellow hub box with
  white screen face, black cylinder wheels at ±trackWidth/2 (rotate around their axle with
  `state.motors[drivePort].posDeg`), rear caster ball, devices from config (distance = white box
  with two dark 'eyes' cylinders, color = small cube pointing down with an emissive dot of the
  currently-read color, force = red cylinder nub), arm = beam from mount point rotating with
  `state.attachments[port].angleDeg` around the Y.. no — around the robot's lateral (pitch) axis, like a forklift.
- Each frame: group.position/rotation from state.pose (see 3D mapping), wheel spin, arm angle,
  camera follow if enabled (lerp to a point 35cm behind + 25cm above robot, lookAt robot).
- Lights: hemisphere + one directional with shadows (2048 map). Background: subtle dark gradient or
  `scene.background = new THREE.Color(...)` matching app theme. Soft shadow under robot ok.
- Handle host resize via ResizeObserver → resize().

## AGENT-BUILD — ui/builder.js

```js
export class BuilderPanel {
  constructor(hostEl, engine)   // build DOM inside hostEl (it's a scrollable panel)
  activate(); deactivate()      // refresh from engine.getRobotConfig() on activate
}
```
Working copy pattern: edit a deep copy; **Apply** button → `engine.loadRobot(copy)` +
`localStorage['spikesim.robot'] = JSON.stringify(copy)`; **Revert** re-reads engine.
Sections:
1. **Presets** dropdown (from `presetRobots()`) + Apply preset.
2. **Chassis & drive**: number inputs for chassis length/width/height, color picker; wheel
   diameter, track width, max speed (deg/s), acceleration; drive port letters (two dropdowns).
3. **Ports A–F table**: per port a type dropdown (— / motor (attachment) / color / distance /
   force) + params (arm length for motor; x, y, facing for sensors).
4. **Top-down preview canvas** (~300px): chassis outline with stud grid (1 stud = 0.8cm), wheels,
   devices as draggable dots — drag to reposition (updates x/y inputs live). Click a device to select.
5. **Import/Export JSON** buttons + robot name text input.
Validate before Apply (ports unique, drive ports are motors, numbers in sane ranges 1..50cm);
show problems inline in red; refuse Apply until valid.

## AGENT-CONTENT — maps/, examples/, docs/TUTORIAL.md

Maps (schema above, be precise — these are loaded unvalidated):
1. `line-track.json` — 200×120cm, white-ish mat, closed rounded-rectangle black line loop
   (widthCm 2.5) made of ~12 points, a red zone "Start", start pose ON the line facing along it, `border:false`, no walls.
2. `fll-table.json` — 236×114cm FLL-style: `border:true`, 3 colored mission zones, 3-4 box
   obstacles, a short interior wall, start in bottom-left "Base" zone.
3. `maze.json` — 200×200cm, `border:true`, interior walls forming a simple maze (≥8 wall
   segments, corridors ≥30cm wide, solvable by right-hand rule), green "Goal" zone, start at entrance.
4. `playground.json` — 236×114cm open mat, 2 obstacles, one black line strip, one of each zone
   color, `border:true`. Good default. List it FIRST in maps/index.json.
`maps/index.json`: `{"maps":[{"file":"playground.json","name":"Playground","desc":"..."}, ...]}`.

Python examples (use ONLY the spike API from this contract; each ≤40 lines, kid-readable comments):
`drive_square.py`, `line_follow.py` (two-state bang-bang on reflected light, forever loop),
`maze_right_hand.py` (distance sensor + turns), `arm_demo.py` (drive, raise/lower arm motor C, beep).
`examples/index.json`: `{"python":[{"file":"drive_square.py","name":"Drive a square"},...],
"blocks":[{"file":"drive_square.json","name":"Drive a square (blocks)"}]}`.

Blocks example `examples/blocks/drive_square.json` — Blockly serialization JSON, EXACTLY this
structure (repeat 4×: move 30cm, turn 90°):
```json
{"blocks":{"languageVersion":0,"blocks":[{"type":"spike_start","x":40,"y":40,"next":{"block":{
 "type":"controls_repeat_ext","inputs":{"TIMES":{"shadow":{"type":"math_number","fields":{"NUM":4}}},
 "DO":{"block":{"type":"spike_move_cm","fields":{"DIR":"FWD"},"inputs":{"DIST":{"shadow":{"type":"math_number","fields":{"NUM":30}}}},
 "next":{"block":{"type":"spike_turn","fields":{"DIR":"RIGHT"},"inputs":{"DEG":{"shadow":{"type":"math_number","fields":{"NUM":90}}}}}}}}}}}]}}
```
(Field/input names MUST match the block catalog.)
`docs/TUTORIAL.md`: friendly walkthrough — run first program in blocks, read the generated Python,
switch to Python tab, sensors, line following, editing maps, building attachments. ~150 lines.

## app.js integration (already written — for reference)

- Boot: Engine → loadRobot(localStorage robot ?? defaultRobot) → fetch maps/index.json → loadMap(saved or first) → init views/blocks/editor → restore code from localStorage → rAF loop.
- rAF: `engine.step(wallDt * speed)`; render active view (2D render() / 3D runs its own loop).
- Run (Blocks tab): `generatePython(workspace)` → show in preview → `runPython(code, engine)`.
  Run (Python tab): textarea value → `runPython`. Stop: `handle.stop(); engine.cancelAll('stop')`.
- Console shows `log` events (user/info/error styling), hub display line shows `display` text,
  `beep` plays via WebAudio oscillator (sine, gain 0.1).
- localStorage keys: `spikesim.python`, `spikesim.blocks`, `spikesim.robot`, `spikesim.maps.custom`, `spikesim.ui`.

---

# V1.1 addendum — SPIKE 3 runtime, movable objects, challenges, 3D models

V1 is built and browser-verified. V1.1 adds four features. Everything in V1 above still holds;
these sections extend it. The user's real programs look like this (THE acceptance test — this
exact style must run):

```python
from hub import port
import runloop, motor_pair
import color_sensor, color

motor_pair.pair(motor_pair.PAIR_1, port.C, port.D)
DOWN = port.E
FRONT = port.B
TARGET = 50
GAIN = 0.5

async def passive_push_left():
    await motor_pair.move_for_degrees(motor_pair.PAIR_1, 80, -30, velocity=200)
    ...

async def mainp():
    while True:
        seen = color_sensor.color(FRONT)
        if seen == color.YELLOW or seen == color.GREEN:
            await passive_push_left()
        reflection = color_sensor.reflection(DOWN)
        error = reflection - TARGET
        motor_pair.move(motor_pair.PAIR_1, int(error * GAIN), velocity=200)

runloop.run(mainp())
```

## AGENT-SPIKE3 — js/runtime/pyrun3.js (Pyodide-based SPIKE 3 runtime)

Pyodide 0.28 is vendored at vendor/pyodide/ (pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm,
python_stdlib.zip, pyodide-lock.json). Load with
`import { loadPyodide } from '../../vendor/pyodide/pyodide.mjs'` and
`loadPyodide({ indexURL: 'vendor/pyodide/' })`. Load ONCE, cache the instance module-level.

```js
export function isSpike3(code) → bool      // /^\s*(from|import)\s+(hub|runloop|motor_pair|motor|color_sensor|distance_sensor|force_sensor|color)\b/m
export function preloadPyodide() → Promise // idle warmup; safe to call repeatedly
export function runPython3(code, engine) → { promise, stop }   // same result contract as runPython:
                                           // resolves {ok:true} | {ok:true,stopped:true} | {ok:false,error} — NEVER rejects
```

Implementation:
- Bridge: `pyodide.registerJsModule('_simjs', bridge)` where bridge wraps `engine.api` (see table
  below) plus `drive_info()`, and a `check_stop()` that throws when the stop flag is set. Async
  engine promises: Pyodide converts JS Promises to awaitables automatically — Python `await`s them.
- The SPIKE 3 modules (hub, runloop, motor, motor_pair, color, color_sensor, distance_sensor,
  force_sensor) are written in PYTHON as one bootstrap source string, executed once per run before
  the user code, registering each module in sys.modules (fresh each run so state doesn't leak).
  Port constants: port.A..port.F = 'A'..'F' (opaque to user code).
- Run user code with `await pyodide.runPythonAsync(userCode)` (top-level await works; runloop.run
  drives coroutines). stdout/stderr → emit('log', {text, level:'user'}) line-buffered
  (pyodide setStdout({batched})). Python exception → {ok:false, error: short message + line number}
  (strip pyodide frames from the traceback; show the user-code line).
- Stop: stop() sets a JS flag; every bridge call checks it and rejects/throws SimStopped; engine
  promise rejections with Error('SIM_STOPPED') → raise SimStopped in Python; runPython3 maps
  SimStopped (and SystemExit) → {ok:true, stopped:true}. Known limit: a CPU-bound loop that never
  awaits can't be interrupted (needs SharedArrayBuffer) — document in a comment; every real robot
  loop awaits or calls sensors, and sensor bridge calls also check_stop() so `while True:
  color_sensor.color(...)` IS stoppable (make sync bridge getters check_stop too — they throw
  SimStopped synchronously, propagating as a Python exception... which user try/except could
  swallow; acceptable v1).
- Each run: re-run the bootstrap (fresh module state, unpaired pairs), engine NOT reset (matches V1).

### SPIKE 3 API subset (exact semantics)

| module.member | maps to |
|---|---|
| `hub.port.A..F` | 'A'..'F' |
| `hub.motion_sensor.reset_yaw(v=0)` | engine.api.gyroReset() (v!=0 unsupported, ignore) |
| `hub.motion_sensor.tilt_angles()` | `(round(yaw*10), 0, 0)` decidegrees, yaw clockwise-positive from engine.api.gyroYaw() |
| `hub.light_matrix.write(s)` / `.off()` | displayWrite(str(s)) / displayWrite('') |
| `hub.light_matrix.show_image(img)` | displayImage(str(img)); `IMAGE_*` constants are the image names |
| `hub.light_matrix.set_pixel(x,y,intensity=100)` | displaySetPixel(x,y, round(intensity/100*9)); intensity 0..100 |
| `hub.light_matrix.get_pixel(x,y)` → 0..100 | round(displayGetPixel(x,y)/9*100) |
| `hub.light_matrix.clear()` | displayClear() |
| `hub.sound.beep(freq=440, ms=200, volume=100)` | awaitable → engine.api.beep(freq, ms/1000); safe to call without await (fire and forget) |
| `hub.button.pressed(b)` | False (stub), button.LEFT=0 RIGHT=1 |
| `runloop.run(*coros)` | asyncio-gather them to completion (use pyodide's running loop — implement as `async def _runner(): await asyncio.gather(*coros)` stored so the JS side awaits it; simplest: runloop.run stores the gather coroutine and the bootstrap appends `await __spikesim_pending__()` — figure out the cleanest way for `runloop.run(main())` as the LAST line of sync user code to actually drive the loop under runPythonAsync; document your approach) |
| `runloop.sleep_ms(ms)` | await engine.api.waitSeconds(ms/1000) — SIM time |
| `runloop.until(fn, timeout_ms=None)` | poll fn() every 20ms sim time; True → return; timeout → return anyway |
| `motor.run(p, velocity)` | motorRun(p, velocity/maxDegPerSec*100) — velocity in deg/s everywhere in SPIKE 3 |
| `motor.stop(p)` | motorStop(p) |
| `motor.velocity(p)` | motorGetSpeed(p) deg/s rounded |
| `motor.relative_position(p)` | motorGetPosition(p) rounded |
| `motor.reset_relative_position(p, to=0)` | track an offset in Python (engine position is not writable) |
| `motor.absolute_position(p)` | motorGetPosition(p) mod 360, 0..359 |
| `motor.run_for_degrees(p, degrees, velocity)` awaitable | motorRunForDegrees(p, vel→pct, degrees) |
| `motor.run_for_time(p, ms, velocity)` awaitable | motorRun + waitSeconds + motorStop |
| `motor_pair.PAIR_1/2/3` | 0/1/2 |
| `motor_pair.pair(id, left, right)` | validate: both ports must be the robot's configured drive ports (either order); else friendly RuntimeError naming the configured ports and the Build tab |
| `motor_pair.move(id, steering, *, velocity=360)` | moveStart(steering, vel→pct) |
| `motor_pair.move_tank(id, lv, rv)` | moveStartTank(lv→pct, rv→pct) |
| `motor_pair.stop(id)` | moveStop() |
| `motor_pair.move_for_degrees(id, degrees, steering, *, velocity=360)` awaitable | degrees are WHEEL degrees → cm = deg/360*π*wheelDiameterCm → moveForCm(cm, pct, steering) |
| `motor_pair.move_tank_for_degrees(id, degrees, lv, rv)` awaitable | moveTankForCm(cm, l→pct, r→pct) |
| `motor_pair.move_for_time(id, ms, steering, *, velocity)` awaitable | moveStart + waitSeconds + moveStop |
| `color.BLACK..WHITE, UNKNOWN` | BLACK=0 MAGENTA=1 PURPLE=2 BLUE=3 AZURE=4 TURQUOISE=5 GREEN=6 YELLOW=7 ORANGE=8 RED=9 WHITE=10 UNKNOWN=-1 |
| `color_sensor.color(p)` | engine colorName → code (black→0, violet→2, blue→3, azure→4, green→6, yellow→7, red→9, white→10, none→-1) |
| `color_sensor.reflection(p)` | reflected(p) int |
| `color_sensor.rgbi(p)` | approximate (r,g,b,i) each 0..1024 from the reflected/color sample |
| `distance_sensor.distance(p)` | cm*10 → mm int; null → -1 |
| `force_sensor.force(p)` | newtons*10 → decinewtons int 0..100 |
| `force_sensor.pressed(p)` | forcePressed(p) |

vel→pct conversion: `clamp(velocity_dps / drive.maxDegPerSec * 100, -100, 100)` via drive_info().

## AGENT-MOVABLE — pushable objects (engine.js, physics.js, mapraster.js, view2d.js, view3d.js, mapeditor.js touch-ups)

Map obstacles with `"movable": true` become pushable crates:
- Engine: loadMap splits static vs movable obstacles. Raster EXCLUDES movables (they move; the
  raster is static ground truth). `state.movables = [{ id, x, y, w, h, heightCm, color }]` (live
  top-left cm positions). reset() restores original positions from the map JSON.
- Physics substep (after robot push-out vs statics): robot circle vs movable AABB overlap → push
  the BOX by the overlap along the minimum-penetration axis (robot keeps its motion). Then clamp
  the box: map bounds (minus border), static obstacles, walls (segment vs AABB — coarse is fine:
  clamp per-axis), other movables (stop at contact, no chaining force). If the box cannot move
  (pinned), push the ROBOT out instead so nothing overlaps.
- Sensors: color sensor — if the sample point is inside a movable footprint, return that box's
  color (snap its hex to the SPIKE color anchors) and a reflected value from its luminance;
  otherwise raster as before. Distance raycast and force contact include movables at their live
  positions.
- view2d: draw movables every frame from state.movables (fill, dark outline, small drop shadow),
  NOT from the raster. view3d: one box mesh per movable, positions updated every tick, rebuilt on
  'map-changed'.
- mapeditor: the Obstacle tool gets a 'movable' checkbox next to the color input; select/erase
  hit-test movables exactly like static obstacles (they all live in map.obstacles JSON — only the
  engine treats them differently).

## AGENT-CHALLENGE — js/ui/challenges.js + challenges/ + CHALLENGES.md

```js
export class ChallengeManager {
  constructor(engine, hooks)  // hooks = { selectEl, setMap(json), setRobot(json), setPython(code), activatePythonTab() }
  loadIndex() → Promise       // fetch challenges/index.json, fill selectEl options, wire onchange
  clear()                     // stop goal checker
}
```
- On select: setRobot(challenge.robot) → setMap(challenge.map) → setPython(challenge.starterCode)
  → activatePythonTab() → emit('log') the brief + numbered goals + first hint teaser. Start a
  500 ms goal checker (setInterval) reading engine.getState(): each goal satisfied → log
  `✔ <label>` once; all satisfied → log `🏆 CHALLENGE COMPLETE!` + emit('beep', {freq: 880, sec: 0.4}).
  Switching challenge or selecting blank stops/replaces the checker. Goals re-arm on 'sim-reset'.
- Challenge JSON: `{ name, blurb, brief, map: <map JSON>, robot: <robot config JSON>,
  starterCode: <SPIKE 3 python string>, goals: [...], hints: [strings] }`
  Goal types: `{type:'movable-in-zone', color:'yellow', zone:'Left Bin', label}` (movable whose
  SPIKE-snapped color matches, center inside the zone rect with that label) and
  `{type:'robot-in-zone', zone:'Base', label}`.
- challenges/index.json: `{"challenges":[{"file":"color-push.json","name":"Color Courier","blurb":"..."}]}`
- First challenge `color-push.json` — "Color Courier", built for the user's real program style:
  236×114 mat, border true; a long black line (2.5 wide) with a gentle S-curve along the middle;
  4 movable crates (8×8, heightCm 8) sitting just off the line's right side spaced along it:
  yellow, green, red, blue; 'Left Bin' zone (30×20, top edge mid) and 'Right Bin' zone (30×20,
  bottom edge mid); start pose at the line's west end ON the line heading east. Robot: drive
  motors on C (left) and D (right) — THE USER DRIVES C/D — color sensor DOWN on E at (x 6, y 0),
  color sensor FRONT on B at (x 8.5, y 0) (reads a crate's color at touch — document this in the
  brief), force sensor on F at (x 8.5, y 2)? NO — keep F free; distance sensor on A at (x 7.5, y 0)
  pointing forward. Wheel 5.6, track 11.2. starterCode: SPIKE 3 skeleton with pair(C,D), DOWN/FRONT
  constants, TARGET/GAIN, an empty `async def push_left()` / `push_right()` with TODO comments, and
  a mainp() P-controller line-follow loop missing the color logic (marked `# TODO`), ending in
  runloop.run(mainp()). Goals: yellow→Left Bin, green→Left Bin, red→Right Bin, blue→Right Bin.
  6 hints, escalating: what to sense → how to branch on color constants → steering sign for a push
  arc → use move_for_degrees with steering like passive_push patterns.
- CHALLENGES.md (repo root): the workflow — "describe a challenge to Claude; it writes a new
  challenges/*.json + index entry and coaches you through solving it (guidance-first, not
  solutions)". Document the JSON schema fully for future sessions.

## AGENT-MODEL — 3D model import groundwork (view3d.js, builder.js touch-ups, models/)

- Robot config gains optional `"model": { "file": "models/mybot.glb", "scaleCmPerUnit": 1,
  "yawDeg": 0, "xCm": 0, "yCm": 0, "zCm": 0 }`. Extensions .glb/.gltf (GLTFLoader) and .stl
  (STLLoader, grey MeshStandardMaterial) — loaders vendored at
  'three/addons/loaders/GLTFLoader.js' and 'three/addons/loaders/STLLoader.js'.
- view3d._rebuildRobot: when model present → async load; on success replace the chassis+screen
  visual with the model (wheels, sensors, arm still drawn from config); center the model on the
  chassis, +x forward after yawDeg, scaled by scaleCmPerUnit; castShadow on all meshes. On failure
  → emit('log', friendly) and keep the box chassis. Cache loaded models by file path.
- builder: in Chassis & drive section add a '3D model file (optional)' text input bound to
  config.model.file (empty string removes the model key; other model params only via JSON for now).
- models/README.md: drop .glb/.stl files here; how to reference from the Build tab; note the
  electronics-simulation roadmap (virtual LEDs/servos/custom sensors bridged into the engine bus,
  planned for a later version).

## app.js / index.html (mine — for reference)

- Toolbar now has `#sel-challenge`. app.js: ChallengeManager wired with hooks; runtime router:
  Python tab code where isSpike3(code) → runPython3, else Skulpt runPython (blocks ALWAYS Skulpt);
  preloadPyodide() warmup ~2 s after boot.

## DOM ids (index.html — already written)

`#btn-run #btn-stop #btn-reset #speed-slider #speed-label #sel-map #sel-example #btn-edit-map`
`#tab-blocks #tab-python` (editor tabs) — panes `#blockly-host`, `#python-pane` (contains `#python-editor` textarea + `#python-preview` pre)
`#tab-2d #tab-3d #tab-build` (sim tabs) — panes `#pane-2d` (contains `#canvas-2d` + `#mapeditor-toolbar`), `#pane-3d` (`#view3d-host`), `#pane-build` (`#builder-host`)
`#btn-fit #btn-follow #console #hub-display`
