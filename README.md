# 🤖 SpikeSim

A LEGO SPIKE Prime-style robot simulator that runs entirely in your browser — no internet needed.
Code the robot with **Scratch-style blocks** or **real Python** (SPIKE v2-style API), watch it run
on a map in **2D and 3D**, draw your own maps, and build the robot with custom **attachments and
sensors**.

## Quick start

```
double-click start.bat        (or: node server.js)
→ opens http://localhost:8790
```

Press **▶ Run** to run the starter block program. Drag blocks around and watch the generated
Python update live underneath — that's the same program you could type in the Python tab.

## What's inside

| Tab | What it does |
|---|---|
| **Blocks** | SPIKE-style word blocks (Blockly). Generates real Python, shown live below the workspace. |
| **Python** | Write SPIKE v2-style Python (`from spike import MotorPair`, …). Runs in-browser via Skulpt. |
| **2D** | Top-down sim view: trail, sensor rays, live color readings. Drag the robot to place it (Shift+drag rotates). |
| **3D** | three.js view of the same sim. 🎥 Follow chases the robot. |
| **Build** | Robot builder: wheel size, track width, and devices on ports A–F — arm motors, color/distance/force sensors. |
| **✏ Edit map** | Draw walls, lines, color zones, obstacles; set the start pose; save/export maps. |

Speed slider runs the sim from 0.25× to 8×. Everything autosaves to the browser (programs, robot,
custom maps).

- **Tutorial:** [docs/TUTORIAL.md](docs/TUTORIAL.md)
- **Architecture / module contracts:** [docs/CONTRACT.md](docs/CONTRACT.md)

## Python APIs (what you learn transfers to a real SPIKE)

**SPIKE 3** (the current app's Python — real CPython via Pyodide, full async/await; auto-detected
when your code imports `hub`/`runloop`/`motor_pair`):

```python
from hub import port
import runloop, motor_pair, color_sensor

motor_pair.pair(motor_pair.PAIR_1, port.C, port.D)

async def main():
    await motor_pair.move_for_degrees(motor_pair.PAIR_1, 360, 0, velocity=300)
    print(color_sensor.reflection(port.E))

runloop.run(main())
```

**SPIKE 2 legacy** (what the blocks generate; runs on Skulpt):

```python
from spike import PrimeHub, MotorPair, ColorSensor
mp = MotorPair()          # uses the drive ports from your robot build
mp.move(30, 'cm')
mp.turn(90)               # sim extension: gyro turn (real SPIKE needs start_tank + yaw)
print(ColorSensor('D').get_color())
```

## Challenges

Pick one from the **Challenge** dropdown — it loads a mission map, the right robot, starter code,
goals, and hints (💡 in the same dropdown). Crates marked `movable` can be pushed for real.
Want a new challenge? Describe it to Claude — see [CHALLENGES.md](CHALLENGES.md).

## Roadmap

- Real physics backend (Rapier/WASM) behind the same engine API — `js/core/physics.js` is
  deliberately isolated so it can be swapped
- More robot types (arms with collision, grabbers, non-SPIKE robots)
- Electronics simulation (virtual LEDs/servos/custom sensors on the engine bus)
- Custom robot 3D models: **already supported** — drop a `.glb`/`.stl` in `models/` and set it
  in the Build tab (see `models/README.md`)

## Tech

Zero-build, zero-runtime-dependency web app. Vendored: [Blockly](https://github.com/google/blockly)
(blocks), [Skulpt](https://skulpt.org/) (Python in the browser), [three.js](https://threejs.org/) (3D).
Node is only used as a static file server.
