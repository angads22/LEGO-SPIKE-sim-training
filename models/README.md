# models/ — custom robot 3D models

Drop your own robot model files in this folder and SpikeSim will draw them in
the **3D view** instead of the standard yellow box.

Supported formats:

| format | notes |
|---|---|
| `.glb` / `.gltf` | best choice — keeps its colors/materials (export from Blender, BrickLink Studio, etc.) |
| `.stl` | loads as plain grey plastic (no color info in STL files) |

## How to use one

1. Copy your file here, e.g. `models/mybot.glb`.
2. In SpikeSim open the **Build** tab → *Chassis & drive* → type the path into
   **"3D model file (optional)"**: `models/mybot.glb`.
3. Press **✓ Apply to robot**, then open the **3D** tab.

The model replaces only the chassis box and screen — wheels, sensors and the
arm are still drawn by the simulator so they keep moving. The 2D view and the
physics are unchanged (the sim still uses your chassis/wheel measurements from
the Build tab, so keep those roughly matching your model).

Clearing the text field and pressing Apply brings the box chassis back. If the
file can't be found or read, SpikeSim tells you in the console and keeps the
box robot — nothing breaks.

## Size, facing and position

The model is automatically centered on the robot and set down on the mat.
SpikeSim works in **centimeters** and the robot's nose points along **+x**.
If your model shows up huge, tiny, or facing sideways, tune it via **Export
JSON** in the Build tab: edit the `model` object, then **Import JSON** + Apply:

```json
"model": {
  "file": "models/mybot.glb",
  "scaleCmPerUnit": 1,
  "yawDeg": 0,
  "xCm": 0,
  "yCm": 0,
  "zCm": 0
}
```

| field | meaning | typical values |
|---|---|---|
| `scaleCmPerUnit` | how many cm one model unit is | glTF authored in meters → `100`; STL in millimeters → `0.1` |
| `yawDeg` | spin the model so its front faces forward | `90`, `180`, `-90` (positive = clockwise from above) |
| `xCm` / `yCm` | nudge forward / to the right | small values like `-1.5` |
| `zCm` | lift up (or sink down) | e.g. `0.5` |

Models are cached after the first load, so re-applying is instant.

## Roadmap

This folder is the groundwork for **electronics simulation**: a later version
plans virtual LEDs, servos and custom sensors defined alongside your model and
bridged into the simulator's engine bus — so a custom-built robot can light up
and react just like its blocks/Python program says.
