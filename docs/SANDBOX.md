# SpikeSim v2 — Physics Sandbox Contract (Stage 1)

SpikeSim is becoming a **physics build-and-drive vehicle sandbox**: build vehicles (robot, race
car, slot car), drive them with real physics (keyboard/gamepad) or code them, and race. This
contract defines **Stage 1: real physics + drivable vehicles + instant switching**, which must
BOOT and DRIVE end-to-end. Later stages add the snap-together builder, racing/laps, coding-on-
physics, and the visual glow-up. Physics engine: **planck.js (Box2D)**, vendored at
`vendor/planck/planck.mjs` (import `* as planck`).

The existing SPIKE app (index.html, js/app.js, the kinematic engine, blocks, runtimes, challenges)
STAYS ON DISK untouched and still reachable at `legacy.html` (Stage-1 integration renames the old
`index.html` → `legacy.html` and ships a NEW `index.html` for the sandbox). Do not delete old files.

## Golden rules

- Plain ES modules, no build step, offline. JSDoc exports. No `Math.random` in render/physics hot
  paths (determinism); if randomness is needed, seed it explicitly.
- Physics runs at a FIXED timestep with an accumulator (never step by a raw frame dt). Rendering
  reads interpolated/current physics state; rendering NEVER mutates physics.
- The app must run on its OWN requestAnimationFrame loop and behave correctly in a normally
  focused browser (the #1 requirement — "it must actually work"). When the tab is hidden, pause
  cleanly; on focus, resume without a giant catch-up step.
- After each .js: `cd "D:/Marvin/06 Repos/SpikeSim" && node --input-type=module --check < "<file>"`.

## Units, coordinates, scale

- Physics is **MKS**: meters, kilograms, seconds, radians. `gravity = (0,0)` (top-down).
- World plane: planck `(x, y)`, **y-up**, angle in radians **CCW-positive** (planck default).
- A race car ≈ 4 m long × 2 m wide; a robot ≈ 0.25 m; a slot car ≈ 0.15 m. Arenas are sized in
  meters (car arena ~40×24 m; robot pad ~4×3 m). Keep bodies within Box2D's happy 0.1–10 m range.
- **Camera** converts world meters → screen pixels: `{ x, y, ppm (pixels per meter), rotation }`.
  2D canvas is y-DOWN, so screen `sy = cy + (cam.y - wy) * ppm` (flip y); `sx = cx + (wx - cam.x) * ppm`.
- **3D mapping** (three.js, y-up world height): physics `(x, y)` → 3D `(x, 0, -y)`, and a body's
  angle θ → `mesh.rotation.y = θ` (CCW about +Y). Forward (+x local) stays +x. Document this in
  view3d.

## js/core/world.js — AGENT-CORE

```js
export const FIXED_DT = 1 / 60;
export class PhysicsWorld {
  constructor()                       // new planck world, gravity (0,0), contact listener
  loadArena(arenaDef)                 // build static walls/ground from an arena def (below); clears vehicles
  addVehicle(vehicle)                 // register a Vehicle (it creates its own bodies via world.pl)
  removeVehicle(vehicle)
  step(realDtSeconds)                 // accumulate; run N fixed FIXED_DT steps (cap N≈5 to avoid spiral)
  get pl()                            // the planck World (vehicles/arena create bodies on it)
  raycastClosest(x1,y1,x2,y2)         // → {hit, point:{x,y}, fraction, normal} | {hit:false} (for sensors)
  reset()                             // arena reset + every vehicle.reset()
  vehicles                            // array
  contacts                            // set/list of current touching fixture pairs (for collision fx)
}
```
- `step`: `this._acc += dt; while (this._acc >= FIXED_DT && n++ < 5) { for v of vehicles v.preStep(FIXED_DT); world.step(FIXED_DT, 8, 3); this._acc -= FIXED_DT } ` then `for v of vehicles v.postStep()`.
- Contact listener records touching pairs so views can flash collisions and slot cars can detect walls.

### Arena def (JSON-able)
```js
{ name, widthM, heightM, wall: true,
  walls: [ {x1,y1,x2,y2, thickM=0.2} ],       // extra interior walls (meters)
  slot:  [ [x,y], ... ],                        // OPTIONAL closed polyline = slot-car groove centerline
  road:  { widthM }                             // OPTIONAL: visual road width around the slot/track
  start: { x, y, angleRad } }
```
Provide `defaultArena()` (open 40×24 arena, walls) and `slotOvalArena()` (a closed oval `slot`
polyline ~30×18 with `road.widthM≈3`, plus outer walls) in `js/core/arenas.js` (AGENT-CORE).

## js/vehicles/*.js — AGENT-CORE (base + 3 types)

Base contract every vehicle implements:
```js
export class Vehicle {
  // spec = { type, name, color, ...tunables }
  constructor(world, spec, pose /*{x,y,angleRad}*/)
  applyControls(input)      // input = normalized ControlInput (below); set actuator targets
  preStep(dt)               // called before each physics substep: apply tire friction/forces
  postStep()                // after substep: update cached state, skid marks
  reset(pose?)              // teleport to start pose, zero velocities
  getState()                // { x, y, angleRad, speedMps, wheels:[{x,y,angleRad,spin}], skids:[...], extra }
  destroy()                 // remove all bodies/joints from the world
  bodies                    // for the renderer: list of {kind, fixtures} to draw generically if wanted
  spec                      // the spec (renderers read color/type/dims)
}
```

`ControlInput` (from js/control): `{ throttle:-1..1, brake:0..1, steer:-1..1, handbrake:0..1,
boost:0..1, leftTrack:-1..1, rightTrack:-1..1 }` (robot uses leftTrack/rightTrack; car/slot use
throttle/brake/steer). Zeroed when idle.

### RaceCar (js/vehicles/racecar.js) — classic Box2D top-down car
- Chassis dynamic body (Box ~4×2 m, density tuned to ~1200 kg total). 4 tire bodies (small boxes)
  joined to chassis: front two via **RevoluteJoint** (steerable, limited ±~35°), rear two rigid.
  Each tire, in preStep: (1) kill LATERAL velocity via impulse up to a grip limit `maxLateralImpulse`
  (exceeding it = slip/drift); (2) apply drive force along tire forward from `throttle`, brake/
  reverse from `brake`; (3) mild rolling resistance + drag. Steering lerps toward `steer*maxAngle`.
  Handbrake reduces rear lateral grip (donuts). Tune so it feels lively but controllable at ~15–25 m/s.
- getState().wheels gives 4 wheel world poses + spin (integrate spin from wheel forward speed) for
  the renderer; skids: push contact points when a tire's lateral slip exceeds a threshold (cap list).

### SlotCar (js/vehicles/slotcar.js) — spline-follow with fly-off (pragmatic, robust)
- NOT a full planck body while slotted. Model: parametric distance `s` along the arena `slot`
  polyline (precompute cumulative length + a sampler `posAt(s)→{x,y,tangentAngle,curvature}`).
  State: `s`, `speed` (m/s). preStep: `speed += (throttle*accel - drag*speed - brake*brakeDecel)*dt`,
  clamp ≥0; `s += speed*dt` (wrap around the loop). Lateral (centripetal) demand
  `a_lat = speed^2 * |curvature|`; if `a_lat > maxLatAccel` → **DE-SLOT**: create a free dynamic
  planck body at the current pose with velocity = tangent*speed, set `slotted=false`; it then
  slides/tumbles under friction until reset. While slotted, getState() returns the slot pose; when
  de-slotted, returns the free body pose (and a `crashed:true` flag). Throttle-only (ignore steer).
- A short guide-pin visual offset is fine. Keep it stable at all speeds; never NaN.

### Robot (js/vehicles/robot.js) — differential drive via physics
- Chassis dynamic body (Box ~0.25×0.2 m). Two drive wheels (left/right at ±half-track): each
  preStep applies a forward force from its track target (`leftTrack`/`rightTrack`, −1..1 → force)
  and kills lateral velocity (grip) like a tire; result is real diff-drive with momentum/skid.
  Optional rear caster (low-friction point). This is the vehicle the CODE API will later drive
  (Stage 2); Stage 1 just needs it drivable by leftTrack/rightTrack from the keyboard.
- getState().wheels = 2 wheel poses+spin.

Provide `js/vehicles/index.js` exporting `createVehicle(world, spec, pose)` that dispatches on
`spec.type` ('racecar'|'slotcar'|'robot') and `presetVehicles()` → 3 ready specs (nice colors/tunes).

## js/control/input.js — AGENT-IO

```js
export class InputManager {
  constructor(targetEl)     // attaches keydown/keyup on window, reads Gamepad API each poll()
  poll()                    // → ControlInput for THIS frame, mapping keys+gamepad to the fields
  setScheme(type)           // 'car' | 'robot' | 'slot' — chooses which keys map to what
  enabled = true
  destroy()
}
```
- Car scheme: ArrowUp/W=throttle, ArrowDown/S=brake+reverse, ArrowLeft/A & ArrowRight/D=steer,
  Space=handbrake, Shift=boost. Robot scheme: W/S = both tracks fwd/back, A/D = turn (differential),
  or ar/right-hand keys per-track. Slot scheme: Up/W or Space = throttle only.
- Gamepad (Gamepad API): left stick X = steer, right trigger (button 7)/A = throttle, left trigger
  (6)/B = brake; robot: sticks → tracks. Poll defensively (no controller = keyboard only). Never throw.
- Also expose on-screen touch buttons hookup via `bindButton(el, field, value)` so the UI can wire
  pedals (AGENT-SHELL builds the buttons; input just needs a way to inject their state — provide
  `setVirtual(field, value)` merged into poll()).

## js/view/arena2d.js — AGENT-2D  (NEW file; do not touch old view2d.js)

```js
export class Arena2D {
  constructor(canvasEl, world)   // pan/zoom camera, follow toggle
  render()                       // one frame from world state
  resize(); fitArena(); setFollow(bool); screenToWorld(cx,cy); worldToScreen(x,y);
  camera                         // {x,y,ppm,rotation}
}
```
- Draw: dark stage + subtle grid; arena floor (asphalt tone) + road/slot ribbon if present
  (draw the `slot` polyline as a wide ribbon with lane edges + dashed center); walls (concrete);
  each vehicle from getState() with a PROPER top-view: race car = rounded body in spec.color with
  windshield, 4 tires (steer the front two by wheel angle), headlight/taillight tint; slot car =
  small kart with a guide flag; robot = rounded chassis + 2 wheels + direction arrow. Skid marks =
  dark translucent segments (cap ~600). Speed HUD (m/s → km/h) bottom-left. Collision flash. Camera
  follows the active vehicle in drive mode (lerp); free pan/zoom otherwise. 60fps, cache gradients.

## js/view/arena3d.js — AGENT-3D  (NEW file; do not touch old view3d.js)

```js
export class Arena3D {
  constructor(hostEl, world)
  activate(); deactivate(); resize(); setFollow(bool); render()
}
```
- three.js (import `* as THREE from 'three'`, OrbitControls). ACES tone mapping, gradient sky,
  hemisphere + key + rim lights, soft shadows. Ground plane (asphalt), road ribbon mesh for the
  slot/track, wall boxes. Vehicles as real-ish low-poly models built procedurally: race car =
  tapered rounded body (use RoundedBoxGeometry, vendored) + cabin + 4 cylinder tires (front steer)
  + spoiler; slot car = small kart; robot = the SPIKE-ish bot (reuse ideas, don't import old file).
  Follow cam behind the active vehicle (chase). Physics (x,y)→(x,0,-y), rotation.y=angle. Rebuild
  vehicle meshes when the active vehicle changes; dispose properly. Runs via setAnimationLoop only
  when the 3D tab is active. Lazy-build; _failed guard for no-WebGL.

## index.html + js/sandbox.js + css/sandbox.css — AGENT-SHELL  (NEW; keep old app.js/css)

New app shell. `index.html` loads `js/sandbox.js` (module) and `css/sandbox.css`, plus the vendored
libs (three importmap already exists in old index.html — replicate the importmap + add nothing that
breaks offline). Layout: a top toolbar + a big sim stage (2D/3D tabs) + a slim HUD; NO code editor
in Stage 1 (link to `legacy.html` for the SPIKE coding app via a "Robot Lab (code)" button).

Toolbar (ids): `#mode-drive #mode-build #mode-race` (Build/Race are stubs in Stage 1 that show a
"coming soon" toast — but present), a **Vehicle picker** `#veh-robot #veh-racecar #veh-slotcar`
(big icon buttons — ONE CLICK switches the active vehicle instantly, swapping arena when needed:
slot car → slotOvalArena, others → defaultArena), `#btn-reset`, `#tab-2d #tab-3d`, `#btn-fit`,
`#btn-follow`, and a link `#link-legacy` → legacy.html. On-screen pedals for touch (throttle/brake/
steer) shown in drive mode. A speed/HUD readout.

`js/sandbox.js` responsibilities:
- Build `PhysicsWorld`, load default arena, create the default vehicle (race car), Arena2D + Arena3D,
  InputManager. rAF loop: `world.step(dt); input each frame → activeVehicle.applyControls(input);
  render active view`. Pause on `visibilitychange` hidden; resume clean (reset the dt clock).
- Vehicle picker: destroy old vehicle, load the right arena, create the new vehicle at arena.start,
  set input scheme, re-fit camera. Instant, no reload.
- Follow cam on by default in drive mode. Fit button reframes. Reset re-places the vehicle.
- Keep it dependency-light and robust; wrap risky calls; never let one bad frame kill the loop.

## STAGE 2 — Build / Race / Code / Visual polish

Stage 1 is DONE and verified. Stage 2 adds four features as **plug-in modules**. The shell
(`js/sandbox.js`) has been refactored to own the loop + vehicle lifecycle and expose an extension
**ctx**. Feature modules export `init(ctx)`, **self-inject their own UI** (append to
`ctx.stage`/`ctx.toolbar`/document.body — DO NOT edit index.html), and register modes/hooks. The
orchestrator adds each `init` to `SANDBOX_FEATURES` in sandbox.js (you don't edit sandbox.js).

### ctx (what every feature receives) — already implemented in sandbox.js
```
ctx = {
  world, arena2d, arena3d, input, stage, toolbar,
  getActiveVehicle(), getActiveSpec(), getActiveType(),
  selectVehicle(type),                    // switch to a preset ('racecar'|'robot'|'slotcar')
  loadVehicleSpec(spec, {arena?, pose?}), // create the active vehicle from a custom spec (Build output)
  loadArena(arenaDef),                    // swap the arena, re-place the vehicle (Race tracks)
  presetSpec(type), arenas:{defaultArena, slotOvalArena},
  registerMode(name, {onEnter(ctx), onExit(ctx)}),  // then a #mode-<name> button (or your own) calls ctx.setMode(name)
  setMode(name), getMode(),
  onFrame(fn(dt, activeVehicle)) -> unregister,      // per-frame hook (runs after controls, before render)
  onExt('vehicle-changed'|'mode-changed'|'reset', fn),
  showToast(msg), fitCameras(), setInputScheme(s),
}
```
Rules for all Stage-2 agents: self-injected UI must match `css/sandbox.css` styling (dark, accent
`#f5c518`), be hidden unless the feature's mode is active (toggle in onEnter/onExit), and never
break Drive mode. Syntax-check every file. No index.html/sandbox.js edits. New dirs are fine.

### AGENT-BUILD — js/build/parts.js + js/build/build.js  (export `init(ctx)` from build.js)
A "putting things together" builder. Read js/vehicles/racecar.js, robot.js, slotcar.js to learn
each type's spec tunables (the DEFAULTS keys: mass/engine power/grip/wheel size/color/etc.) — Build
produces a spec with those keys that `ctx.loadVehicleSpec(spec)` instantiates.
- `init(ctx)`: registerMode('build', {onEnter,onExit}); build a Build panel (appended to ctx.stage,
  hidden until build mode) with: (1) a base picker (Race Car / Robot / Slot Car); (2) a **part grid**
  — a chassis silhouette onto which the user drags parts from a palette (wheels ×size, engine/motor
  ×power, body panels, weight blocks, spoiler, grip tires) that SNAP to grid cells; (3) live derived
  **stats** (top speed / accel / grip / weight) computed from the placed parts, feeding the spec
  tunables; (4) a **Drive it** button → ctx.loadVehicleSpec(builtSpec) + ctx.setMode('drive'); (5)
  Save/Load the build to localStorage `spikesim.builds`. Also add a "Build" flow reachable from the
  existing #mode-build button (it calls ctx.setMode('build') already). Keep parts + stat math in
  parts.js (pure, testable). A live mini-preview (canvas) of the vehicle is a plus.
- The built spec MUST be valid for createVehicle (correct `type` + tunable keys the vehicle reads);
  verify by calling ctx.loadVehicleSpec on a couple of built specs in a scratch check.

### AGENT-RACE — js/race/tracks.js + js/race/race.js  (export `init(ctx)` from race.js)
- tracks.js: 2-3 race track arena defs (extend the Stage-1 arena def) — e.g. a road circuit and a
  figure-8 — each with `road`/`walls`, a `startFinish:{x1,y1,x2,y2}` line and ordered
  `checkpoints:[{x1,y1,x2,y2}]` (meters). Also a slot-track variant. Provide `raceTracks()` → list
  of {name, arena}.
- race.js `init(ctx)`: registerMode('race', {onEnter,onExit}); a Race panel (track picker + lap
  count select + Start/Stop) and a race HUD (current lap, lap time, best lap, last lap). onEnter:
  ctx.loadArena(selectedTrack.arena). Register ctx.onFrame to detect the active vehicle crossing the
  startFinish line **in order after hitting all checkpoints** (segment-crossing test on the vehicle
  center between last and current position) → count a lap, record split, update best. ctx.onExt('reset')
  restarts the clock; 'vehicle-changed' re-arms. A countdown 3-2-1-GO on Start is a nice touch.
  Ghost/replay is optional. Keep lap detection robust (no double-count; require forward crossing).

### AGENT-CODE — js/code/robotapi.js + js/code/code.js  (export `init(ctx)` from code.js)
Bring coding to the PHYSICS robot (SPIKE 3 Python — the user's dialect — via the vendored Pyodide
at vendor/pyodide/pyodide.mjs). Do NOT reuse the old js/runtime/pyrun3.js (it drives the old
kinematic engine); build a fresh, small bridge that drives the physics robot vehicle through
ctx.getActiveVehicle().applyControls() (registered as a frame hook while a program runs — it runs
after input so code wins) and reads getState() + ctx.world.raycastClosest() for sensors.
- robotapi.js: a controller that, given the robot vehicle + world, exposes async primitives:
  drive straight for N cm (odometry from getState position/wheel spin), turn N degrees (gyro from
  getState().angleRad), set track speeds, stop, distance-ahead (raycast from robot pose+heading),
  and a tick() the frame hook calls to advance the current motion. Pure-ish, no DOM.
- code.js `init(ctx)`: registerMode('code', {onEnter: switch to robot + show a code panel, onExit:
  hide + stop program}). INJECT a `#mode-code` toolbar button (into ctx.toolbar) AND wire its click
  to ctx.setMode('code') (the shell only pre-binds drive/build/race). Code panel: a Python textarea
  (a small SPIKE-3 starter that drives the robot), Run/Stop, and a console. Load Pyodide once
  (lazy), register a JS module bridging to robotapi, and provide a Python `spike`-ish module set:
  `from hub import port; import runloop, motor_pair, distance_sensor` with
  motor_pair.pair/move_for_degrees(cm via wheel odo? use CM here for simplicity: move_for_cm)/turn/
  start/stop and distance_sensor.distance(); runloop.run(main()). Keep it small but real: a program
  that line-follows-free / drives a square / avoids a wall must run and move the physics robot.
  Robust: Stop halts promptly; errors show in the panel; never leak internal stop errors to the user.
  Because this is the hardest feature, a WORKING subset (square drive + distance-based stop) that
  genuinely moves the robot is the bar; note anything deferred.

### AGENT-VISUAL — edits js/view/arena2d.js AND js/view/arena3d.js (owns them this stage)
Polish the look and add the shared decorations Race/Build depend on:
- Render arena `startFinish` (checkered line) and `checkpoints` (faint gates) when present in the
  arena def (Race sets these). Render skid marks the RaceCar already emits in getState().skids as
  dark rubber streaks that fade (cap already in core). Nicer 2D vehicle sprites (cleaner car body,
  headlights, proper tires; a crisper robot; a kart for the slot car). Better asphalt texture +
  subtle vignette; a start-line/road markings pass. 3D: improve materials/lighting a touch, add the
  startFinish + checkpoint meshes, and skid decals or trail. Keep 60fps and the exact public APIs
  (constructor, render, resize, fitArena, setFollow, setActiveVehicle, screenToWorld/worldToScreen,
  camera) — additive only. Do NOT change vehicle physics or getState shape.

## SPIKE LAB — make the SPIKE robot the correct, full centerpiece (priority)

The user is a SPIKE competitor: the SPIKE robot + its coding + sensors are the HEART of the app
(cars/racing are fun extras). Stage-2's Code feature proved SPIKE Python drives the physics robot,
but `move_for_cm(30)` drove ~18 m (a units bug) and never turned. Fix that and go full SPIKE, all
VERIFIED. Units reminder: physics is METERS; SPIKE uses **cm and degrees** at the API — convert at
the boundary. `move_for_cm(30)` MUST travel 0.30 m and stop; `turn(90)` MUST rotate 90°.

### AGENT-ROBOTCORE (sequential, headlessly verified — the keystone)
Owns: `js/vehicles/robot.js` (extend), `js/core/mat.js` (new), `js/core/arenas.js` (add
`robotMatArena()`), `js/robot/control.js` (new — control + sensors). Do not touch other files.
- **Robot devices**: extend the robot spec with SPIKE-style devices:
  `devices: [{port:'A',type:'motor',role:'drive-left'},{port:'B',...'drive-right'},
  {port:'C',type:'motor',role:'attachment'},{port:'E',type:'color',x,y},{port:'D',type:'distance',x,y,headingDeg},
  {port:'F',type:'force',x,y,headingDeg}]` (x,y = offset in METERS from robot center, +x forward).
  Defaults: drive A/B, color E under front, distance D forward, force F front. getState() gains
  `motors:{A:{posDeg,speedDps}...}` (posDeg = accumulated wheel degrees from spin) and
  `sensors:{E:{type:'color',color:'red',reflected:0..100}, D:{type:'distance',cm:number|null},
  F:{type:'force',newtons,pressed}}` and `devices` (for the renderer), plus `angleRad` (gyro).
  Keep applyControls(leftTrack/rightTrack) working (manual driving) — the control layer sets those.
- **js/core/mat.js**: a mat def `{ bg:'#eae6da', lines:[{color,widthM,points:[[x,y]...]}],
  zones:[{color,x,y,wM,hM}] }` (world meters) and `sampleMat(mat, x, y) -> {colorName, reflected}`
  snapping to SPIKE colors (black/white/red/green/blue/yellow/…); off-mat → bg. Used by the color
  sensor AND the renderer. No canvas raster — compute point-vs-line/zone in world space.
- **arenas.js `robotMatArena()`**: a ~4×3 m mat arena (walls) carrying a `mat` (a black line loop
  to follow + a couple of color zones), `start` on the line. This is the robot's home arena.
- **js/robot/control.js**: `class RobotControl(vehicle, world)` with CLOSED-LOOP async primitives
  (drive with momentum, so target-then-brake): `driveForCm(cm, speedPct)` (odometry via getState
  position delta or wheel posDeg → cm; stops at target ±0.5 cm), `turnDeg(deg, speedPct)` (gyro
  from angleRad delta; + = clockwise; stops at ±2°), `setTracks(l,r)`, `stop()`, and sensor reads:
  `distanceCm(port)` (world.raycastClosest from the device world pose along its heading, max 200,
  null beyond), `color(port)`/`reflected(port)` (sampleMat under the device world pos),
  `force(port)`/`pressed(port)` (short raycast/contact), `yawDeg()` (gyro). A `tick(dt)` the frame
  hook calls to advance the active motion + resolve its promise. Unit-correct, never NaN.
- **VERIFY headlessly** (scratchpad Node + planck, deleted after; flip package.json type and
  restore): driveForCm(30) travels 0.30 m ±0.02 and stops; driveForCm(-20) reverses 0.20 m;
  turnDeg(90) → +90°±3 and stops; turnDeg(-90) → −90°; distanceCm sees a wall at the right cm;
  color() over a black line returns 'black', over the mat bg returns light; report the numbers.

### AGENT-SPIKEAPI (after ROBOTCORE — full SPIKE 3 Python)
Owns: `js/code/code.js` (REWRITE its Python bridge), `js/robot/spike_py.js` (the Python module
source). Build the FULL SPIKE 3 API over RobotControl (import js/robot/control.js), via vendored
Pyodide. Provide the real dialect: `from hub import port; import runloop, motor, motor_pair,
color_sensor, distance_sensor, force_sensor` with — motor_pair.pair/move_for_cm(cm,speed)/
move(steering,speed)/start/stop/turn(deg,speed); motor(port).run_for_degrees/run_for_seconds/
start/stop; color_sensor.color(port)/reflection(port); distance_sensor.distance_cm(port);
force_sensor.pressed(port)/force(port); hub.motion_sensor.get_yaw()/reset_yaw();
hub.light_matrix.write(); runloop.run(main()) + runloop.sleep_ms/until. Drive via a frame hook
calling control.tick(dt) (runs after input so code wins). Stop halts promptly; Python errors show
in the panel with a line number; internal stop sentinels never leak. Ship a good default program +
a couple of loadable examples (drive a square; line-follow using color_sensor.reflection). VERIFY
with real Pyodide (scratchpad) that the square program issues driveForCm(30)/turnDeg(90)×4 and a
color line-follow reads the sensor and steers — report the control trace.

### AGENT-ROBOTMODEL (parallel with SPIKEAPI) — accurate SPIKE look
Owns: `js/view/arena2d.js` + `js/view/arena3d.js` (additive; keep all public APIs + getState shape).
- Render `world.arena.mat` when present: bg, color zones, black line(s) — as the ground under the
  robot (2D and 3D). This is what the color sensor "sees", so draw it faithfully.
- Draw the robot as an ACCURATE SPIKE Prime bot (researched specs already in docs/ART.md v1.3):
  white 88:56:32 hub with a warm-white 5×5 light matrix (render getState() display text if present),
  azure tires on white rims, white-bodied sensors from getState().devices (distance = two black
  eyes, color = downward lens showing the live reading, force = black-tipped) at their offsets, and
  render the distance sensor's ray + a live reading. Keep the car/kart nice too. 60fps, additive only.

### SPIKE Lab integration (orchestrator, after the above)
- Make the **robot the DEFAULT vehicle** (boot selectVehicle('robot')); robot uses `robotMatArena()`.
- The vehicle picker order leads with Robot. Code mode already selects the robot.
- Verify end-to-end: robot on the mat; run the square program → drives a real ~30 cm square; run
  the line-follow → follows the black line using the color sensor; distance/force read correctly.
- Challenges + Blocks on the physics robot are the NEXT step after this (not in this build).

## SPIKE LAB FIXES + CHALLENGES (make it usable for real challenges)

Verified live: driveForCm/turnDeg are correct (30 cm square works), sensors read the mat. BUT the
robot is mis-calibrated for continuous/sensor driving: `motor_pair.move(0, 60)` drove the 0.28 m
robot at **11.8 m/s / 16 m**, tunneling through the 4 m arena walls. A SPIKE robot should crawl
(~0.3–0.5 m/s at full speed). That's why line-follow shoots off the line and stalls. Fix the
calibration, make line-follow reliably lap the mat, then add the challenge system.

### AGENT-ROBOTFIX (sequential keystone, headlessly verified) — owns:
`js/vehicles/robot.js`, `js/core/arenas.js` (robotMatArena mat), `js/robot/control.js` (if needed),
`js/code/code.js` + `js/robot/spike_py.js` (line-follow example + expose a set-code hook).
- **Calibrate the robot** (robot.js DEFAULTS): full tracks (100%) ≈ **0.4 m/s** top speed, brisk
  but controllable accel, enough lateral grip to hold a line, and mass/force so it never tunnels
  (at ≤0.5 m/s and 1/60 s substeps it moves <1 cm/step — walls must stop it). Percent→speed must be
  roughly linear so `move(0,30)` ≈ 0.12 m/s. Keep driveForCm/turnDeg working (re-verify 30 cm / 90°).
- **Tune the mat** (arenas.robotMatArena): make the follow line a **clean loop** with a width that a
  single downward color sensor can track (~4–6 cm), sensor centered; start ON the line's edge.
- **Make line-follow WORK**: tune the `spike_py.js` line-follow example (proportional on
  color_sensor.reflection over the line edge, sensible GAIN + slow speed) so the robot follows the
  black loop all the way around and returns near start. HEADLESSLY VERIFY (scratchpad Node + planck):
  drive the follow loop for ~60 s sim and assert the robot travels around the loop (covers the loop's
  bounding box, stays within ~8 cm of the line, returns near start) — report the path. Also re-assert
  move(0,100)≈0.4 m/s (NOT 11 m/s) and that a wall stops a full-speed robot (no tunneling).
- **Expose a set-code hook** for challenges: in code.js init add `ctx.code = { setProgram(src),
  run(), stop() }` (setProgram fills the editor; run/stop drive the existing Run/Stop). Document it.

### AGENT-CHALLENGES (after ROBOTFIX) — owns `js/challenges/*` only.
A challenge system on the physics robot, plugging into ctx. `init(ctx)`: register a 'challenges'
mode + inject a `#mode-challenge` toolbar button wired to ctx.setMode('challenge') (and/or a
Challenges dropdown). A challenge def = `{ name, blurb, mat (arena with a mat), robotSpec?,
starterCode (SPIKE 3), goals:[...], hints:[...] }`. Selecting one: ctx.loadArena(challenge.mat) (or
loadVehicleSpec robot with that arena), ctx.setMode('code')?? — no: stay in challenge mode but show
the code panel via ctx.code.setProgram(starterCode); log the brief + numbered goals. A goal checker
(ctx.onFrame, guarded to challenge mode) reads getState()/world to detect completion (robot-in-zone,
line-lap-completed via bounding-box coverage, color-read sequence, wall-stop), logs ✔ per goal and
🏆 on all-done. ctx.onExt('reset') re-arms. Ship 3 challenges: **Line Lap** (follow the loop back to
start), **Color Tour** (drive over red→green→blue zones in order using the color sensor), **Park It**
(drive forward and stop within N cm of the wall using the distance sensor). Coach-not-solve starters
(TODOs) + 4–6 hints each. A CHALLENGES panel + a "Load challenge" picker; matches css/sandbox.css.

### AGENT-ROBOTMODEL (parallel with CHALLENGES) — owns `js/view/arena2d.js` + `js/view/arena3d.js`.
(Resume of the SPIKE-Lab model agent.) Accurate SPIKE Prime bot per docs/ART.md v1.3 (white 88:56:32
hub + warm-white 5×5 matrix from getState().display, azure tires/white rims, white sensor bodies from
getState().devices with live readings, distance ray). Render world.arena.mat faithfully (2D + 3D) —
already partly works; make it clean and make the robot read as a real SPIKE. Additive only; keep all
public APIs + getState shape; keep the car/kart nice. 60 fps.

### Integration (orchestrator, after): verify a Line Lap challenge end-to-end (robot follows the loop
and the goal fires), Color Tour, and Park It — in the browser, driving the loop deterministically.

## Verification bar (Stage 1)

Boots with zero console errors; the race car DRIVES with arrow keys and drifts; the robot turns via
differential keys; the slot car laps the oval and FLIES OFF if you never brake into the hairpin;
vehicle switching is one click and instant; 2D and 3D both render the active vehicle; the loop runs
on native rAF (verify by focusing the tab, not only via a manual step-pump). State every feature in
your notes for screenshot/keypress verification.
