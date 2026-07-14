# MODEL-IMPORT — wiring `js/view/model-loader.js` into the app

Integration guide for the V1.1 AGENT-MODEL feature (custom robot 3D models).
`js/view/model-loader.js` is already written and self-contained. Three small,
surgical edits wire it up; each snippet below is ready to paste and anchored to
a line **quoted verbatim from the current file**. Apply them in order.

Feature recap (CONTRACT.md → V1.1 addendum, AGENT-MODEL):

- Robot config gains an optional key:
  `"model": { "file": "models/mybot.glb", "scaleCmPerUnit": 1, "yawDeg": 0, "xCm": 0, "yCm": 0, "zCm": 0 }`
- In the 3D view the loaded model **replaces only the hub box + screen**;
  wheels, sensors and the arm stay procedural (they animate from engine state).
- Load failure → friendly `emit('log', …)` (done inside model-loader.js) and
  the box chassis stays. Loaded files are cached per path.

---

## Edit 0 (REQUIRED FIRST) — `js/core/engine.js`: pass `model` through loadRobot

`Engine.loadRobot()` rebuilds the config from an explicit allowlist, so without
this edit the `model` key is **stripped** and neither the 3D view nor the
builder ever sees it again (`getRobotConfig()` returns the engine's copy).

Anchor — in `loadRobot(configJson)`, the end of the `robot` object literal
(currently lines 162–163):

```js
      devices: [],
    };
```

Insert **immediately after** that `};`:

```js
    // v1.1 (AGENT-MODEL): optional 3D model reference — passed through as-is;
    // only the 3D view reads it. Kept only when it names a file.
    if (src.model && typeof src.model === 'object' && typeof src.model.file === 'string' && src.model.file) {
      robot.model = src.model; // src is already a deep copy
    }
```

Notes:
- `src` is the deep-copied input (`const src = … deepCopy(configJson) …`), so
  no aliasing of caller data.
- engine.js is also being edited by AGENT-MOVABLE (map/movables paths). This
  anchor sits in `loadRobot`, which that work does not touch; if the line
  numbers have shifted, match on the quoted `devices: [],` + `};` pair inside
  the `const robot = {` literal.

---

## Edit 1 — `js/view/view3d.js`: async model swap in `_rebuildRobot`

### 1a. Import

Anchor — the current import block (file top, lines 16–18):

```js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { on, emit } from '../core/bus.js';
```

Insert **after** the `bus.js` import line:

```js
import { loadRobotModel } from './model-loader.js';
```

### 1b. Race-guard token — top of `_rebuildRobot`

Anchor — the method opening (currently lines 317–319):

```js
  /** Rebuild the robot group from engine.getRobotConfig(). */
  _rebuildRobot() {
    disposeTree(this._robot);
```

Insert **immediately after** the `  _rebuildRobot() {` line (i.e. before
`disposeTree(this._robot);`):

```js
    // v1.1 (AGENT-MODEL): every rebuild invalidates any in-flight model load
    // from a previous rebuild — including rebuilds for robots WITHOUT a model,
    // so a stale async load can never attach to the wrong robot.
    this._modelToken = (this._modelToken || 0) + 1;
```

This must be unconditional and must run before the method's early
`if (!cfg || !cfg.chassis) return;` — placing it as the first statement
guarantees both. (No constructor edit needed: `(this._modelToken || 0)`
self-initializes.)

### 1c. Async load + swap — bottom of `_rebuildRobot`

Anchor — the method's final line (currently line 392):

```js
    this._robot.traverse((o) => { if (o.isMesh) o.castShadow = true; });
```

Insert **immediately before** that line:

```js
    // v1.1 (AGENT-MODEL): optional custom 3D model. Loads async; on success
    // it replaces ONLY the hub box + screen — wheels, sensors and arm remain
    // procedural so they keep animating from engine state.
    if (cfg.model && cfg.model.file) {
      const token = this._modelToken;
      loadRobotModel(cfg.model).then((group) => {
        // Async-race guard: if the robot was rebuilt while the file was
        // loading, `token` is stale — drop this result (loadRobotModel keeps
        // its own cache, so nothing is wasted). null = load failed and
        // model-loader.js already logged a friendly message; keep the box.
        if (!group || token !== this._modelToken) return;
        this._robot.remove(hub, screen);
        hub.geometry.dispose();
        hub.material.dispose();
        screen.geometry.dispose();
        screen.material.dispose();
        this._robot.add(group);
      });
    }
```

Notes:
- The closure uses the local consts `hub` and `screen` created earlier in
  `_rebuildRobot` (the two meshes under `// --- hub: chassis box in the config
  color + white "screen" on top ------`). Do not rename them.
- No `catch` needed: `loadRobotModel` never rejects (resolves null on failure).
- The next `_rebuildRobot()` disposes the swapped-in model via the existing
  `disposeTree(this._robot)`. The loader's cache holds its own template object;
  disposing a clone's shared geometry only drops GPU buffers, which three.js
  re-uploads on next use — the documented-safe pattern already used in this
  file ("Safe on shared resources").

---

## Edit 2 — `js/ui/builder.js`: model-file input in "Chassis & drive"

Both insertions are inside `_buildChassisSection()`. Only `model.file` is
editable in the UI; the other model params (`scaleCmPerUnit`, `yawDeg`,
`xCm/yCm/zCm`) are edited via Export/Import JSON for now — the binding below
preserves them when the file name changes.

### 2a. The input element

Anchor — inside `_buildChassisSection()` (currently line 395):

```js
    const portSelect = (side, key) => {
```

Insert **immediately before** that line:

```js
    // v1.1 (AGENT-MODEL): optional 3D model file, shown in the 3D view.
    // Empty string removes the model key entirely (contract). Other model
    // params (scale/yaw/offsets) are JSON-only for now — preserve them.
    const modelInput = el('input', {
      type: 'text',
      value: (this.copy.model && this.copy.model.file) || '',
      placeholder: 'models/mybot.glb',
      title: 'Optional 3D model (.glb/.gltf/.stl) drawn instead of the box chassis in the 3D view — see models/README.md',
      style: { width: '190px' },
      oninput: (e) => {
        const file = e.target.value.trim();
        if (file) this.copy.model = Object.assign({}, this.copy.model, { file });
        else delete this.copy.model;
        this._afterFieldChange();
      },
    });
```

### 2b. The row in the section

Anchor — the end of `_buildChassisSection()`'s return array (currently
lines 425–426):

```js
      el('div', { className: 'row' }, [portSelect('left', 'leftPort'), portSelect('right', 'rightPort')]),
    ];
```

Insert a new row **between** those two lines (i.e. as the last array element):

```js
      el('div', { className: 'row' }, [el('label', {}, ['3D model file (optional) ', modelInput])]),
```

Notes:
- Matches the file's existing patterns: `el()` helper, `oninput` +
  `this._afterFieldChange()` (validation + preview redraw, no focus-stealing
  re-render), row/label layout like the color picker.
- `validateRobot()` needs no change — it ignores unknown keys, so Apply stays
  gated only by the existing rules. Apply already saves `this.copy` (including
  `model`) to localStorage; with Edit 0 in place the key round-trips through
  `engine.loadRobot()` → `getRobotConfig()`, so the field survives
  activate()/revert().

---

## Edit 3 — `models/README.md`

Already created (user-facing instructions + roadmap note). Nothing to wire —
just confirm it exists at the repo root's `models/` folder so the placeholder
path in the builder tooltip resolves.

## Verify (manual, ~2 min)

1. `node server.js` → http://localhost:8790 (server.js already serves .glb;
   .gltf/.stl are text/octet-stream, which the loaders accept).
2. Drop any small `.glb` into `models/` (e.g. `models/test.glb`).
3. Build tab → Chassis & drive → "3D model file (optional)" → `models/test.glb`
   → Apply → 3D tab: model replaces the yellow box; wheels still spin, color
   disc still glows; robot drives normally.
4. Set the field to `models/nope.glb` → Apply: console shows the friendly
   "Could not load 3D model …" line and the box chassis stays.
5. Clear the field → Apply: box chassis returns (Export JSON shows no `model`
   key).
6. Rapid-fire Apply twice (model ↔ no model) — no duplicate/stale model
   attaches (token guard).
