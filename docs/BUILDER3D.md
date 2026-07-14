# Builder 3D — interactive 3D robot building (spec)

Goal: in the SPIKE workshop app's Build tab, a **3D builder** where the user grabs parts from a
palette and places them onto the robot with the mouse — motors, sensors, and decorative LEGO
bricks — with stud-grid snapping, port auto-assignment, easy editing, and **named saves**. The
existing form editor stays as an "Advanced" sub-tab. Everything continues to drive the SAME robot
config schema (docs/CONTRACT.md) so the whole sim (engine, SPIKE Python, Blocks, 2D/3D views,
challenges) keeps working unchanged.

## Schema addition: decorative bricks (visual only)

Robot config gains an optional `bricks` array (engine passthrough like `model`):
```json
"bricks": [ { "x": 2.4, "y": -1.6, "z": 0, "wCm": 3.2, "lCm": 1.6, "hCm": 1.0, "color": "#D01012" } ]
```
- x,y = cm offsets in the body frame (+x forward, +y right), the brick's CENTER; z = stack level
  in cm ABOVE the chassis deck (0 = resting on the deck). w = along x, l = along y.
- Purely visual: physics/sensors ignore bricks. Cap 60 bricks. Engine `loadRobot` must pass the
  array through (sanitize: finite numbers, sane sizes 0.4–12 cm, valid hex color, cap).
- Rendering: view3d draws each brick as a RoundedBox (radius 0.12) with **LEGO studs on top**
  (small cylinders, 0.8 cm pitch); view2d draws top-view rounded rects with faint stud dots.
  Bricks belong to the chassis-visuals group (replaced by a custom `model`, like hub/deck).

## js/ui/builder3d.js — `export class Builder3D`

```js
new Builder3D(hostEl, engine)   // builds ALL its DOM inside hostEl (#builder3d-host)
activate()    // re-read engine.getRobotConfig() into a working copy; start rendering
deactivate()  // stop render loop
resize()
// Programmatic API (used by tests AND by the UI internally — keep behavior identical):
place(kind, xCm, yCm, opts?) -> id|null   // kind: 'motor'|'color'|'distance'|'force'|'brick'
select(id) ; getSelected() ; setPort(port) ; setFacing(deg) ; setArmLen(cm) ; setBrickColor(hex)
moveSelected(xCm, yCm) ; deleteSelected()
apply() -> boolean          // validate + engine.loadRobot(copy) + localStorage['spikesim.robot']
getConfig() -> deep copy of the working copy
saveAs(name) ; loadSaved(name) ; listSaved() -> string[]   // localStorage['spikesim.robotBuilds']
```

### Layout (all DOM self-built inside hostEl; inject a scoped <style id="builder3d-styles">)
- Left strip (~150px): **parts palette** — big friendly buttons with emoji/mini-icons:
  ⚙ Motor + arm · 🎨 Color sensor · 👀 Distance sensor · 🔘 Force sensor · 🧱 Brick 2×4 ·
  🧱 Brick 2×2 · ▬ Beam 1×6. Below: brick color swatches (red/yellow/blue/green/white/gray).
- Center: the 3D canvas (three.js, own renderer + OrbitControls; render only while active).
- Right strip (~190px): **inspector** for the selected part — port dropdown (only FREE ports +
  its own), facing ° (distance/force), arm cm (motor), brick color, position readout (x,y in cm),
  Delete button. When nothing selected: friendly hint text.
- Bottom bar: ✓ **Apply to robot** (green; disabled + reason line when invalid) · Revert ·
  name input + 💾 Save · "My builds" dropdown (loads) · ⤓ Export JSON · ⤒ Import JSON.
- Also on the bottom bar: **move motors**: "L wheel: [port] R wheel: [port]" dropdowns (same
  role-re-normalization rules as the form builder — read js/ui/builder.js `_normalizeDriveDevices`
  and mirror the behavior; duplicating the small logic is fine).

### 3D scene
- Light studio matching the app (bg #F2F5F9 gradient, soft key light). A stud-grid ground plate
  (light gray) under the robot at deck-shadow scale. The robot is rendered FROM THE WORKING COPY
  (not engine state): chassis box in config color w/ wheels at the configured drive layout, hub,
  and every device/brick — reuse simple primitives (this is the EDITOR view; it does not import
  view3d.js — keep it self-contained and lightweight, boxes/cylinders are fine but neat: azure
  tires/white rims, white hub w/ dark screen, device identities per ART.md).
- Camera: orbit (damped), home position ~3/4 view; double-click empty space = re-home.

### Interaction (must be RELIABLE — this is the core of the feature)
- **Place**: click a palette part → placement mode (palette button highlights, cursor ghost).
  Pointermove raycasts onto the placement plane (chassis deck height) and onto existing bricks'
  top faces (for stacking). Ghost = semi-transparent part mesh snapped to the 0.8 cm stud grid,
  clamped to chassis footprint +4 cm margin. Invalid spots (device overlap < 1.2 cm apart, no
  free port for devices) tint the ghost red. Click = place: devices get the NEXT FREE PORT
  (badge appears), bricks stack (z = top of whatever brick is under the cursor, else 0).
  ESC or right-click cancels placement mode. Placing another copy stays in placement mode
  (rapid building); clicking the palette button again exits.
- **Select**: click a placed part → yellow outline (scale-up ghost or emissive tint) + inspector
  fills. Click empty space deselects.
- **Move**: drag a selected part — same plane raycast + snap + clamp; devices keep their port.
  OrbitControls must be disabled during a part drag and re-enabled after (critical!).
- **Port badges**: every device shows a floating letter badge (sprite w/ canvas texture, e.g. a
  small white circle with the port letter). Selected device's badge highlights. Clicking a badge
  selects the device.
- **Wheels/move motors**: the two drive wheels render with their port letters; clicking a wheel
  selects a pseudo-part whose inspector shows the L/R port dropdowns.
- Keyboard: Delete/Backspace removes selection; ESC cancels/deselects.

### Validation + Apply
Same rules as the form builder (unique ports, drive ports distinct motors, sane numbers). Show
one friendly reason line when invalid. Apply → engine.loadRobot(copy) + persist. After Apply,
emit('log', "Robot updated — new build applied 🛠") and the 2D/3D sim views must show the new
build (they already listen to 'robot-changed').

### Saves
`localStorage['spikesim.robotBuilds']` = `{ "<name>": <robot config>, ... }` (NOT the sandbox's
'spikesim.builds' key). Save with the name input (default = config.name). Loading a build
replaces the working copy + selects nothing + re-renders. Export/Import = JSON file download /
file-input (same as the form builder).

## Integration (orchestrator does this — agents do NOT touch these files)
index.html: inside #pane-build add a small sub-tab switcher (🧱 3D Builder | ⚙ Advanced form) +
`<div id="builder3d-host">`; app.js instantiates Builder3D and toggles the two editors; CSS for
the switcher in css/app.css. Build tab default = 3D builder.

## Verification bar
- node --check passes; no Math.random (deterministic ghost/snap).
- Programmatic proof (the orchestrator runs in-browser): place('color', 6, 2) → id + auto port;
  place('brick', 0, 0) ×2 stacked (second gets z>0); setPort/setFacing work; apply() → engine
  config contains the new device + bricks; saveAs('test')/listSaved()/loadSaved('test') round-trip;
  the sim 2D/3D views show the new parts after apply.
- Visual proof: screenshots — palette, ghost placement, port badges, selected-part inspector,
  bricks with studs stacked on the bot.
