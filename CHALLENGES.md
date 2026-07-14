# SpikeSim Challenges

Challenges are self-contained missions: picking one from the **Challenge** menu in the
toolbar loads a purpose-built robot, a purpose-built map, and SPIKE 3-style Python starter
code, then watches the simulation and checks off goals as you achieve them. When every goal
is met you get a `🏆 CHALLENGE COMPLETE!` in the console (and a beep).

- Pick a challenge → the robot, map, and starter code are applied and the Python tab opens.
- Press **▶ Run** — every starter program runs as-is (it just doesn't solve the mission yet).
- Stuck? Pick **💡 Next hint** at the bottom of the Challenge menu (or run
  `spikesim.challenges.hint()` in the browser devtools console). Hints escalate gradually.
- **⟲ Reset** puts the robot and all crates back and re-arms the goals for another attempt.
- Picking the blank entry ("Pick a challenge…") or another challenge stops the goal checker.

## Ask Claude for a new challenge

This is the intended workflow for growing the challenge library:

1. **Describe the mission to Claude** in a SpikeSim session, e.g. *"Make a challenge where
   the robot uses the distance sensor to find a gap in a wall, drives through it, and parks
   in a garage zone."* Mention the skills it should teach (line following, gyro turns,
   sensors, pushing) and roughly how hard it should be.
2. **Claude writes one file** `challenges/<slug>.json` containing map + robot + starter code
   + goals + hints (schema below), **adds an entry** to `challenges/index.json`, and
   verifies the JSON parses and every coordinate is in-bounds.
3. **Claude coaches, it does not solve.** While you work on a challenge, Claude's job is
   guidance: explain what to sense, suggest which API call fits, help debug *your* code.
   It should not paste a complete solution unless you explicitly give up and ask for one.
   The `hints` array in the JSON is written the same way — each hint reveals one more step
   of the *approach*, never the finished program.

## File layout

```
challenges/
├── index.json        the menu: {"challenges":[{"file","name","blurb"}, ...]}
└── color-push.json   one file per challenge (schema below)
```

### challenges/index.json

```json
{
  "challenges": [
    { "file": "color-push.json", "name": "Color Courier", "blurb": "One-line teaser shown as a tooltip." }
  ]
}
```

## Challenge JSON schema

```json
{
  "name": "Color Courier",
  "blurb": "One-line teaser (menu tooltip, fallback brief).",
  "brief": "Multi-line mission text logged to the console on select.\nEach line becomes one console line.",
  "map": { },
  "robot": { },
  "starterCode": "python source as one string",
  "goals": [ ],
  "hints": [ "hint 1", "hint 2", "..." ]
}
```

| field | type | meaning |
|---|---|---|
| `name` | string | Shown in the Challenge menu and the console banner. |
| `blurb` | string | One-liner for `index.json` / tooltips. |
| `brief` | string | The mission briefing, logged line-by-line on select. |
| `map` | object | Full **map JSON** (schema in `docs/CONTRACT.md`). Loaded via `engine.loadMap`. |
| `robot` | object | Full **robot config JSON** (schema in `docs/CONTRACT.md`). Loaded via `engine.loadRobot` *before* the map. |
| `starterCode` | string | SPIKE 3-style Python placed in the Python editor. **Must run as-is** (it may simply not complete the goals). |
| `goals` | array | Goal objects (below). All must be satisfied for 🏆. |
| `hints` | array of strings | Escalating hints (aim for ~6: what to sense → how to decide → how to act → tuning). |

On select the manager applies, in order: `setRobot(robot)` → `setMap(map)` →
`setPython(starterCode)` → activate the Python tab → log `brief` + numbered goals + hint
teaser → start the goal checker.

### Goal types

```json
{ "type": "movable-in-zone", "color": "yellow", "zone": "Left Bin", "label": "Yellow crate delivered" }
{ "type": "robot-in-zone",   "zone": "Base",    "label": "Robot back in Base" }
```

- **`movable-in-zone`** — satisfied while *any* movable obstacle (`"movable": true` in
  `map.obstacles`) whose fill color snaps to the SPIKE color name `color` has its **center**
  inside the zone rect whose `label` equals `zone`.
- **`robot-in-zone`** — satisfied while the robot's center is inside the labelled zone.
- `label` is the human text used for the `✔` log line (falls back to a generated one).

### Checker semantics (what the code actually does)

- Polls `engine.getState()` every **500 ms**.
- Zones are looked up **by `label` in the currently loaded map** — if the user switches to a
  map without those labels, the checker keeps running harmlessly and simply never completes.
- Each goal logs `✔ <label>` **once** and stays **latched** (a crate drifting back out of a
  bin later does not un-check it).
- All goals latched → `🏆 CHALLENGE COMPLETE!` + a beep (880 Hz, 0.4 s), once.
- **`sim-reset`** (⟲ Reset, or any map load) **re-arms** every goal, so each attempt re-logs
  its progress.
- Crate colors are matched by snapping the movable's hex fill to the nearest SPIKE anchor
  (squared-RGB distance). Anchors (keep any crate/zone paint choices honest against these):

  | name | RGB | | name | RGB |
  |---|---|---|---|---|
  | `black` | 15, 15, 18 | | `green` | 60, 165, 75 |
  | `violet` | 145, 70, 210 | | `yellow` | 250, 205, 50 |
  | `blue` | 40, 80, 220 | | `red` | 215, 60, 55 |
  | `azure` | 90, 185, 235 | | `white` | 245, 245, 240 |

## Design notes for challenge authors (learned building Color Courier)

Numbers below assume the standard 14×11 cm chassis, 5.6 cm wheels, 11.2 cm track.

- **Units/frames:** cm, degrees, seconds; world origin top-left, **y grows downward**;
  heading 0° = east, **positive = clockwise**. A robot heading east has its *right* side
  toward the bottom of the screen.
- **Collision circle:** the robot body is a circle of radius `hypot(length, width)/2 × 0.92`
  ≈ **8.19 cm** for the standard chassis. Pushed crates are held exactly at this radius.
- **The front-sensor "touch read" trick:** a down-pointing color sensor at body `(8.5, 0)`
  sits ~0.3 cm *outside* the collision circle, so it reads a crate's color **only while the
  robot is actually pushing it**. For this to work the crate must overlap the robot's driving
  path: point-in-footprint is exact, so leave **≥ 1.5 cm of overlap** between the crate and
  the path the robot really drives.
- **P-controller line followers track the LEFT edge** of the line (with
  `steering = (reflection - 50) * GAIN` and positive steering = right turn). With a 2.5 cm
  line the robot's center rides ~**1.25 cm left of the line's centerline**. Place touch-read
  crates relative to *that* path, not the painted centerline.
- **Line bend limits:** at `GAIN 0.5` the max correction is ~±21 steering → minimum turning
  radius ~21 cm. Keep polyline bends ≤ **~18° per vertex** with segments ≥ 10 cm, or the
  follower loses the edge.
- **Pushing physics:** crates are plowed straight ahead while contact is frontal and shed
  sideways when the robot arcs. A pushed crate's *center* rides ~12 cm ahead of the robot's
  center. Keep **deposit targets within ~5–8 cm** of where crates sit — long escorted pushes
  are unreliable and frustrating.
- **Zone paint is visible to color sensors.** Keep zone fills pale (they should snap to
  `white`) unless a goal *wants* the robot to detect them.
- **Starter code must be runnable.** Keep an `await runloop.sleep_ms(20)` inside sensor
  loops so the simulator advances between readings. Convention: drive on **C (left) / D
  (right)**, DOWN color sensor on **E**, FRONT color sensor on **B**, distance on **A** —
  this mirrors the real robot this simulator is modeled on.
- **Verify before shipping:** JSON parses; every line point, crate, zone, and the start pose
  are inside `widthCm × heightCm`; the start pose lies ON the line heading along it; crate
  hexes snap to the intended SPIKE names.

## The first challenge: Color Courier (`color-push.json`)

A 236×114 bordered mat with an S-curve line. Four 8×8 crates sit across the line's right
edge: yellow and green on the north crest (their **Left Bin** is at the top edge), red and
blue on the south trough (their **Right Bin** is at the bottom edge). The starter program
line-follows with a reflection P-controller; the player adds the FRONT-sensor color branch
and writes `push_left()` / `push_right()` arc maneuvers from `move_for_degrees` chunks —
the classic passive-push pattern.
