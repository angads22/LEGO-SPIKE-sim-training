# SpikeSim — Repo Context

**Rover Lab (2026-07-11):** a separate, self-contained **grid-robot programming toy** at
`rover.html` + `js/rover.js`, imported from a claude.ai Design project ("Robot Simulator.dc.html")
via the DesignSync MCP tool (re-fetch that project to pull design updates). Cozy cream/green UI
(Fredoka/Nunito). The design was upgraded to a **dual Blocks ↔ Python** editor — SPIKE-software
style — and `rover.js` is a faithful vanilla-JS port of the design's own component logic: a 12×8
playground, an interactive block workspace (colorful blocks with +/− steppers, add/reorder/delete,
a Repeat container) AND a syntax-highlighted Python editor with `forward(n)`/`turn_left()`/`scan()`/
`led("cyan")`/`repeat(n):` etc.; the two modes convert to each other. Top-down + iso 3D canvas
views, examples (Sweep/Square/Zigzag), star goal + rocks, run/step/pause/reset, activity console.
Fully working (blocks run, pen trails, collision, HUD) and no physics — reliable for kid
challenges. Independent of the physics app. To refresh from the design: DesignSync get_file →
re-port. The un-escaped design is cached in the scratchpad (`rover_design_full.html`).

**Builder 3D (2026-07-11):** the Build tab now has TWO sub-editors — **🧱 3D Builder** (default;
`js/ui/builder3d.js`, spec `docs/BUILDER3D.md`): grab parts from a palette (motor+arm, color/
distance/force sensors, LEGO bricks 2×4/2×2/beam in 6 colors) and place them on the bot in 3D with
stud-grid ghost snapping; devices auto-assign the next free port (floating port badges, click to
change); drag to move, click wheel = set move motors L/R; named saves in
localStorage['spikesim.robotBuilds'] + Export/Import; Apply → engine.loadRobot. Robot config gained
an optional `bricks` array (engine passthrough, visual-only, rendered with studs in 2D+3D sim
views). Programmatic API (place/select/setPort/apply/saveAs/...) — verified live end-to-end.
`⚙ Advanced form` = the old BuilderPanel.

**Front door (2026-07-11): `index.html` = the full SPIKE workshop** (js/app.js — the original
kinematic SpikeSim). This is the app for the real SPIKE workflow and it WORKS: **Build tab**
configures ports A–F (add/remove motor/color/distance/force + `motor (attachment)` arm; presets
Driving Base / Line Follower / Grabber Bot; Apply reconfigures the live robot — verified), **Blocks**
generate real SPIKE Python (`from spike import …`), **Python** is the SPIKE 3 library (`from hub
import port`, `motor_pair`…) run via Pyodide, plus maps, challenges, 2D/3D. Cross-nav links in its
toolbar → `sandbox.html` (physics vehicle sandbox, formerly index.html) and `rover.html` (Rover Lab).
The physics sandbox moved to `sandbox.html`; `legacy.html` remains a copy of the SPIKE app.

**v2 (2026-07-10):** the **physics build-and-drive vehicle sandbox** (planck.js/Box2D) now lives at
`sandbox.html` → `js/sandbox.js` (was index.html). The SPIKE coding app is at `index.html`/`legacy.html`
(reachable via the "Robot Lab (code)" link). Contract: `docs/SANDBOX.md`. Stage 1 DONE + browser-
verified: drive a **race car** (accelerates + drifts), **robot** (differential, spins in place),
or **slot car** (laps an oval, flies off if you don't brake into the curve) with real physics;
keyboard + gamepad; one-click vehicle switching; 2D top-down + 3D chase views (proper models, not
"clay"). New files: `js/core/world.js`+`arenas.js`, `js/vehicles/*`, `js/control/input.js`,
`js/view/arena2d.js`+`arena3d.js`, `js/sandbox.js`, `css/sandbox.css`, `vendor/planck/`. Sim pauses
when the tab is unfocused (normal rAF throttling). Stages 2+: snap-together builder (Build mode
stub), racing/laps (Race mode stub), wiring Blocks/Python onto the physics robot, visual polish.

**What (v1, now legacy.html):** LEGO SPIKE Prime-style robot simulator in the browser. Code the robot in Scratch-style
blocks (Blockly) or real SPIKE v2-style Python (Skulpt, in-browser), simulate on a map in 2D
(canvas) and 3D (three.js), draw custom maps (walls/lines/zones/obstacles), and build the robot
with attachments (arm motors, color/distance/force sensors on ports A–F).

**Why:** Train Python + block coding the way SPIKE Prime teaches it, without the hardware.
Long-term: general robot prototyping sandbox with real physics (engine API is isolated in
`js/core/physics.js` so a Rapier/WASM backend can swap in later).

**Run:** `start.bat` (or `node server.js`) → http://localhost:8790. Fully offline — Blockly,
Skulpt, and three.js are vendored under `vendor/`. Zero build step, zero runtime deps.

**Status:** v1 built 2026-07-09, v1.1 built 2026-07-10 (Claude-orchestrated multi-agent builds).
v1.3 (2026-07-10): accuracy + friendliness. 3D robot rebuilt to real SPIKE Prime specs
(researched from LEGO's official 45601 tech spec — 88×56×32mm white hub, 5×5 warm-white LED
matrix upper-middle, button cluster w/ azure RGB ring, LPF2 port sockets A–F, **azure tires on
white 4-spoke rims**, white motor bodies, distance-sensor LED arcs, black force plunger). Added
`js/ui/help.js` (first-run welcome overlay + tabbed ❓ Help modal w/ Quick start / Coding /
in-app Tutorial render / Challenges), a runtime badge showing which Python dialect Run will use,
and `docs/ART.md` "Accurate SPIKE Prime part reference". Fit button re-homes the 3D camera.
5 SPIKE 3 test programs in `examples/` (spike3_*.py: square w/ gyro turns, sensor watch, line
follow, light+sound show, wander/avoid). Fixed a stderr leak: Stop mid-`sound.beep` no longer
prints SIM_STOPPED/PyodideFuture noise (pyrun3.js `emitStderrLines` filter).
v1.2 (2026-07-10): visual overhaul per `docs/ART.md` — 3D: ACES tone mapping, table-slab stage,
3-light rig, SPIKE-style robot with **live 5×5 light matrix** (renders `light_matrix.write()`),
spoked wheels, blob shadows, rounded crates; 2D: decorated mat (grain/shadow/frame), dot-grid
stage, matrix + tread animation on the robot, pill zone badges, fading trail; CSS polish.
`docs/ART.md` is the art direction spec; the raster stays sensor ground truth (decor is a copy).
v1.1 added: **SPIKE 3 Python runtime** (Pyodide/CPython — `from hub import port`, `runloop`,
async/await, the dialect the user actually writes; auto-detected in the Python tab, Skulpt still
runs blocks/SPIKE 2), **pushable crates** (`movable: true` obstacles), **challenge system**
(`challenges/` + Challenge dropdown + goal checker + hints; see CHALLENGES.md for the
ask-Claude-for-a-challenge workflow), and **3D model import** (.glb/.stl via `models/`,
`js/view/model-loader.js`). User's competition-style program (C/D drive, color-triggered pushes,
P-controller line follow) verified running verbatim.

## Key files

| Path | What |
|---|---|
| `docs/CONTRACT.md` | Architecture + every module interface (source of truth) |
| `docs/TUTORIAL.md` | Learn-to-use walkthrough |
| `js/core/engine.js` | Sim engine: state, stepping, command API (percent speeds, cm, deg) |
| `js/core/physics.js` | Kinematic diff-drive + collision — swap point for real physics |
| `js/runtime/pyrun.js` | Skulpt bridge + embedded `spike` Python package (SPIKE v2 API) |
| `js/blocks/blocks.js` | SPIKE-style Blockly blocks → generates the same Python API |
| `js/view/view2d.js` + `mapeditor.js` | 2D view + map editor |
| `js/view/view3d.js` | three.js 3D view (follow cam) |
| `js/ui/builder.js` | Robot/attachment builder |
| `maps/`, `examples/` | Preset maps (line track, FLL table, maze, playground) + example programs |

## Conventions (don't break)

- Units cm/deg/sec; world y-down; heading 0°=east, clockwise-positive. 3D: (x, 0, y), yaw = -heading.
- Speeds cross module boundaries as percent (-100..100).
- Everything talks through `js/core/bus.js` events (`log`, `map-changed`, `robot-changed`, …).
- localStorage keys prefixed `spikesim.`.
