# SpikeSim Art Direction (v1.2 visual overhaul)

One coherent look across 2D and 3D: **LEGO education competition table** — clean, warm plastic
on a dark stage, high contrast against the dark UI. This spec is the shared source of truth for
the visual agents. FUNCTION IS FROZEN: every existing behavior, public method, event
subscription, interaction (drag/pan/zoom/editor overlay), and the sensor pipeline must survive
untouched. Visual code only.

Hard rules:
- No external assets. Procedural only: offscreen-canvas textures, vertex colors, materials.
- 60 fps target: no post-processing passes, shadow maps ≤ 2048, share materials/geometries where
  possible, no per-frame allocations in hot paths (reuse vectors/canvases).
- Determinism: NO `Math.random()` — derive variation from indices/positions.
- The raster from `mapraster.js` is SENSOR GROUND TRUTH — do not change mapraster.js. Any grain,
  vignette, or decoration happens on a SEPARATE decorated copy used only for display
  (2D base draw / 3D mat texture): draw the raster onto a decor canvas, then overlay effects.
- Palette anchors: UI bg `#14161c`, panel `#1c1f27`, accent `#f5c518` (LEGO yellow),
  stage `#0e1016`, table slab `#2b2f3a`, plastic border grey `#c9cdd6`.

## 3D scene (view3d.js)

- Renderer: `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 1.1`,
  `outputColorSpace = SRGBColorSpace`, PCFSoft shadows, antialias (already on).
- Background: subtle vertical gradient canvas texture `#0d0f14 → #1a1f2b` (scene.background),
  gentle fog matched to the horizon color.
- Stage: large dark plane under everything (`#0e1016`, roughness 1) with a faint radial dot-grid
  texture fading to nothing by ~2 mats out.
- Table: the mat sits on a slab — mat footprint + 14 cm margin, 6 cm thick, `#2b2f3a`
  roughness .85, slight bevel look (RoundedBoxGeometry, radius 1.5). A darker inset band around
  the mat edge (drawn into the mat decor texture as a 1.5 cm outer frame) fakes contact AO.
- Mat: decorated texture = raster + 2–3% alpha paper-grain noise + very subtle vignette. Redraw
  decor when the raster changes ('map-changed'). anisotropy 4.
- Border walls (map.border): matte plastic `#c9cdd6`, roughness .6, RoundedBox, with a slightly
  lighter top face (second material or vertex tint).
- Lights: Hemisphere (#dfe6ff sky, #23201a ground, 0.75) + key Directional (#fff4e0, 1.8) from
  45° casting shadows (2048, tuned frustum) + rim Directional (#7aa2ff, 0.5) from behind-left,
  no shadows. Kill any remaining flat/default look.
- **Robot (the star — must read as a SPIKE bot):**
  - Chassis: RoundedBoxGeometry (radius 0.8) in config color, MeshPhysicalMaterial
    (roughness .5, clearcoat .25) — plastic, not clay.
  - Hub: white rounded box on top, slightly smaller than chassis, with a **live 5×5 light
    matrix**: a small canvas texture on the hub top face; emissive-yellow rounded pixels on a
    dark panel. Render `engine.getState().display` with a built-in 3×5 pixel font (A–Z, 0–9,
    space; unknown chars → hollow square). One char shown at a time; if text is longer than
    1 char, marquee-step every 0.35 s of sim time. Empty display → dim idle grid of dots.
  - Wheels: dark rubber tire (`#17181c`, roughness .9, cylinder) + light-grey hub cap
    (roughness .35, metalness .15) with a painted 5-spoke pattern (canvas texture) so rotation
    is visible. Keep exact wheel spin logic/sign.
  - Rear caster: grey ball in a darker socket cup.
  - Distance sensor: white rounded plate + two black cylinder "eyes" with a faint blue emissive
    iris ring — the classic SPIKE face.
  - Color sensor: short black cylinder pointing down, emissive bottom disc = live reading
    (keep existing per-frame color update).
  - Force sensor: red rounded cap on a dark base.
  - Arm: yellow beam (RoundedBox) with dark "pin hole" circles painted on its sides via canvas
    texture; keep pivot behavior.
  - Soft blob shadow: a radial-gradient sprite under the chassis (in addition to the cast
    shadow) so the robot always feels grounded.
- Crates (movables): RoundedBoxGeometry, MeshStandardMaterial roughness .55, top face ~8%
  lighter than sides (vertex colors or a 2-material split), deterministic ±4% lightness
  variation by index, small blob-shadow sprite under each that follows it every frame.
- Custom model path (model-loader) must keep working exactly as-is.
- Keep: movables sync, robot pose/wheel/arm updates, follow cam, dispose discipline,
  'map-changed'/'robot-changed' rebuilds, resize, activate/deactivate contract, render().

## 2D view (view2d.js)

- Outside the mat: `#0e1016` with a faint dot grid (2 px dots every ~8 cm in world space, alpha
  0.05, drawn cheaply from the visible range only).
- Mat: drop shadow (soft dark blur ~24 px equivalent) + 1 px light frame; base draw uses a
  decorated copy of the raster (grain + vignette like 3D, built once per 'map-changed').
- Robot top view (redraw, same data sources):
  - Chassis: rounded rect, vertical-ish gradient of the config color (lighter top-left), dark
    outline 1.5 px.
  - Hub: white rounded square with the **live 5×5 matrix** (same pixel font + marquee rule as
    3D; share the logic if convenient — a tiny exported helper in one file the other imports is
    allowed, put it in view2d.js and import from view3d.js OR duplicate ~40 lines, your call —
    but the two views must show the same pixels for the same state).
  - Wheels: dark rounded rects with 3 tread notches that scroll with `motors[port].posDeg` so
    wheel motion is visible in 2D too.
  - Devices: color sensor = ring + live color fill; distance sensor = two-dot eyes + ray;
    force = red nub. Arm: beam with rounded end + painted pin holes.
- Distance ray: dashed line with soft gradient (bright at sensor, faded at hit), small ✕ at the
  hit point, cm label in a dark rounded pill with light text.
- Trail: fading gradient stroke — head near-opaque accent `#f5c518`, tail transparent; width
  2.5 px; draw in ≤ 32 alpha-stepped segment batches (not per-point strokes).
- Movables: slightly rounded rects, soft drop shadow, darker bottom-right inner edge, 1 px
  outline.
- Zones: translucent fill (as now, from raster) but labels become pill badges (dark bg, light
  text, 10 px, centered).
- Start marker: keep ghost chevron, restyle to thin outline + accent tint.
- Collision: keep the red inset border flash; also pulse the robot outline red while collided.
- Keep: pan/zoom math, robot drag + shift-rotate, `overlay.draw` hook (editor depends on it),
  fitToMap logic incl. the _fitSize guard, DPR handling, screenToWorld/worldToScreen exactness.

## UI polish (css/app.css only — no HTML/id changes)

- Buttons: subtle top-light gradient, 1 px inner highlight, hover lift (translateY(-1px) +
  shadow), active press.
- Panels: radius 12 (already) + very subtle outer shadow; tabs get a soft active glow.
- Thin dark scrollbars (webkit) for console/builder/editor.
- Console: level colors unchanged; add 2 px left border accent per level line.
- Toolbar: faint bottom gradient; brand text gets accent underline glow on hover. Nothing that
  shifts layout metrics enough to disturb canvas sizing.

## Accurate SPIKE Prime part reference (v1.3 — researched from official sources)

From LEGO Education's official Technic Large Hub tech spec (45601) and part references
(newelementary.com SPIKE Prime element review; LEGO Education product pages):

- **Hub (45601): L 88.0 × W 56.0 × H 32.0 mm, white body.** Top face, matrix-upright
  orientation: **5×5 LED matrix of 25 WHITE LEDs** (warm-white, 10-step dimmable) in the
  upper-middle of the top face; **button cluster below the matrix**: a white pill/oval rocker
  (Left/Right buttons) with a **round white Center button** in the middle that has a subtle
  **RGB LED ring** (render as faint azure glow ring when "on"); a small **Bluetooth button with
  its own tiny LED** near the top-left corner; 4 small corner screws; **micro-USB on the top
  short edge**. **Ports: 3 dark LPF2 sockets per long side** — left column top→bottom A, C, E;
  right column B, D, F — with tiny moulded port letters beside each socket.
- **Wheels (part 39367, "57 × 14, 4 spokes"): WHITE 4-spoke rim + MEDIUM AZUR rubber tire**
  (≈ `#45b5d8`) — SPIKE Prime tires are azure-blue, NOT black. Ø 5.6 cm matches the default
  robot config.
- **Motors**: white bodies with a light-grey round end-cap bearing a **rotation zero-mark**
  (small notch/arrow). On a driving base the two motors lie sideways, wheels mounted directly
  on their output; render a visible white motor body inboard of each drive wheel.
- **Distance sensor (45604)**: white housing, **two large black round "eyes"**, with **white
  LED light segments around the eyes, divided into 4 individually-lightable segments (two
  upper, two lower arcs)** — render faint warm segments, not blue irises.
- **Color sensor (45605)**: white square housing with a dark round face/lens; it **glows white
  when active** (3 internal LEDs) — keep the live reading as the lens/emissive color but add a
  faint white illumination ring.
- **Force sensor (45606)**: white body with a **black round plunger tip** (not red).
- **SPIKE Prime accent palette** (structural parts): Bright Yellow frames, Medium Azur,
  Bright Reddish Violet/Magenta connectors — the arm beam staying Bright Yellow is canon.
- The hub model's proportions must follow 88:56:32 (scaled to sit nicely on the configured
  chassis) regardless of chassis size.

2D top view should mirror the same identity cues: white hub with warm-white matrix, azure
tires, white-bodied sensors (distance = black eyes on white; force = black tip).

## v1.4 — SPIKE-software LIGHT re-theme (the whole workshop app)

The user finds the dark UI "horrid" and wants it to feel like the real LEGO SPIKE software:
**bright, white, friendly, rounded** (see also their Rover Lab design's warmth). This re-themes
the SPIKE workshop (index.html + css/app.css + Blockly theme + 2D/3D views). FUNCTION IS FROZEN —
visual values only; every id/class/API/behavior/sensor path stays identical.

### Palette (new values for the EXISTING CSS variables — keep the variable names!)
```
--bg:       #F2F5F9    app background (near-white, cool)
--panel:    #FFFFFF    panels / toolbar
--panel-2:  #F5F7FB    inset fields, inputs, tab pills
--border:   #E2E7F0    hairlines
--text:     #232A36    primary text
--text-dim: #77839A    secondary text
--accent:   #FFC900    LEGO/SPIKE yellow (pair with dark text #232A36 on yellow)
--run:      #2FB56B    Run green   --stop: #EF5350   --error: #D64545   --user: #1B78C2
```
Feel: radius 12–14 everywhere, soft shadows `0 2px 10px rgba(35,50,90,.08)`, buttons white with
1px border + hover lift, active tab = white pill with a soft yellow underline/glow, toolbar white
with a hairline bottom border. Hub display strip STAYS dark (#20242E inset, warm-white LED text) —
a real hub screen, nice contrast. Console: light bg (#FBFCFE); log colors legible on light
(info #77839A, user #1B78C2, error #D64545). Sweep css/app.css for ALL hardcoded dark hexes
(#14161c/#1c1f27/#171a21/#10121a/#0e1016 etc.) incl. the HELP & ONBOARDING section — nothing dark
may remain except the hub display strip. Python editor: white bg, dark text, subtle gutter.

### Blockly (js/blocks/blocks.js — theme block only)
Light SPIKE look: toolboxBackgroundColour #FFFFFF, toolboxForegroundColour #232A36,
flyoutBackgroundColour #F5F7FB, flyoutForegroundColour #232A36, flyoutOpacity 1,
workspaceBackgroundColour #FBFCFE, scrollbarColour #C9D2E0. Category/block colors unchanged.

### 2D view (js/view/view2d.js)
Light stage: outside-the-mat backdrop = warm paper `#E9ECF2` with the dot grid at rgba(60,80,120,.10);
mat drop shadow softened for light bg; zone label pills = white bg, dark text, hairline border;
distance-ray cm pill likewise; trail stays accent yellow but slightly darker (#E5B400) for
contrast on the pale mat; collision flash unchanged. Robot sprite ACCURACY cues (the unfinished
v1.3 2D pass): **azure tires (#45b5d8) on white rims** with the tread notches kept, white hub,
**warm-white (#ffeecb) matrix pixels** (idle grid dim gray), sensors with white bodies (distance =
black eyes on white plate, force = black tip). Start chevron + editor overlay colors adjusted for
light bg. No API/behavior changes; raster untouched.

### 3D view (js/view/view3d.js)
Bright studio: background gradient soft sky `#DCE9F7 → #F4F7FB`, fog matched; stage floor light
`#E3E7EE` with the dot grid at low contrast; table slab light neutral `#CBD2DD`; hemisphere light
up to ~1.0 with sky #ffffff/ground #cfd4da; key light warm #fff6e6 ~1.6; rim subtle. Keep ACES,
shadows (soften intensity so they're gray not black), all models/materials/behavior as-is (the
accurate robot already landed in 3D). Goal: cheerful daylight, not a night garage.

Verification bar: node --check each file; no Math.random; screenshots of Blocks/Python/2D/3D/Build
must read as ONE bright, friendly app; every feature still works (drag, editor overlay, matrix,
sensors, movables).

## v1.5 — 3D robot ASSEMBLY fix + Build feature polish

Close-up inspection (bright theme, arm raised) shows concrete 3D defects to fix in view3d.js:
1. **Arm clips through the hub**: the beam pivots through the hub body from its center. Fix: the
   attachment is an ASSEMBLY at its configured mount (attachment.x, attachment.y): a small white
   SPIKE medium-motor body (rounded box ~3.5×3×3.5 cm with a light-grey circular end-cap) fixed to
   the chassis, plus the yellow Technic beam pivoting from the motor's axle — the beam's END is at
   the axle (pivot at beam end, not center), swinging up/forward without intersecting hub/chassis
   (place the mount clear of the hub footprint; if the configured x,y collides with the hub, nudge
   the assembly outward/sideways deterministically and keep the pivot axis lateral).
2. **Wheels swallowed**: only slivers of the azure tires show. Fix: wheels sit clearly outboard —
   tire outer face proud of the chassis side by ≥40% of tire width, correct radius from config,
   white rim + spokes visible, chassis narrowed/wheel wells implied if needed (visual only; physics
   untouched).
3. **Caster half-buried**: rear caster ball should sit in a visible socket below the chassis tail.
4. **Blank chassis**: add subtle LEGO character — a Technic-beam side texture (painted hole dots),
   a thin top deck line, front bumper chamfer. Keep config color + size.
5. **Devices must read at a glance at their configured offsets**: color sensor = white square
   housing with a dark down-lens visible from the side (slightly proud below chassis), live color
   glow kept; distance = the white two-eye face at its (x,y,facing); force = white body/black tip.
   Multiple sensors of the same type (e.g. two colors: E down + B front) must ALL appear.
6. Keep: bright studio, materials, matrix/button hub top, movables, model-loader swap, follow cam,
   dispose discipline, every public API. Rebuild on 'robot-changed' must reflect ANY Build change
   (add/remove device, moved offsets, drive-port swap) — verify by loading two different configs.

Build tab (js/ui/builder.js) polish — function verified working, make it clearer:
- Rename labels only (no id/API changes): "left wheel port"/"right wheel port" →
  "move motor L (left wheel)" / "move motor R (right wheel)" — this is how SPIKE kids think of it.
- Ensure drive-port dropdown changes re-role devices cleanly (existing logic — verify), preview
  canvas reflects new drive ports immediately, and the arm/device dots render correctly on the
  light canvas. Sensor "face °" only for distance/force (as-is). Keep everything else.

## v1.6 — LEGO-DETAIL pass (researched from LEGO's official tech-spec photos)

Make the 3D robot read as REAL LEGO SPIKE Prime hardware. References (official LEGO Education
tech-spec PDFs, product photos inspected 2026-07-12):

**Exact part looks:**
- **Medium/Large Angular Motor (45603/45602)**: WHITE rounded-box body; on the wheel side a round
  white boss holding a **MEDIUM-AZURE circular rotating disc** (≈#45B5D8) with a dark **crosshole**
  (+ shape) in the center and a small white zero-mark dot at 12 o'clock; an **azure square
  building-interface cap** on the opposite end/top; **two rows of black pin holes** along the body
  flanks; a flat white ribbon cable exiting the rear (cable optional, short stub OK). Drive wheels
  mount DIRECTLY on the azure disc.
- **Distance Sensor (45604)**: white brick body; the FRONT is a **black rounded face plate**
  spanning both eyes; two large dark "eyes" with **concentric ring detail** (speaker-mesh look)
  and **white (4000 K) LED segments around each eye — two upper, two lower arcs**; black pin-hole
  side panels; flat cable on top (stub OK).
- **Color Sensor (45605)**: small white square module (~2×2 studs face) with a **black round
  bezel + dark lens** centered, thin white illumination ring; pin holes through the sides.
- **Force Sensor (45606)**: white oblong body with a **black round plunger tip** on a short black
  collar.
- **Hub (45601)**: as v1.3 spec, ADD: recessed **black LPF2 port sockets** (rounded-square)
  with tiny port letters on both long sides, a **speaker grille** (dot row) on one side, a faint
  battery seam line near the bottom, slightly inset matrix window with a dark bezel.
- **Wheel (39367)**: white rim with **4 round spoke cutouts** + medium-azur tire (57×14) with a
  shallow center groove; small hub cap with crosshole mark.
- **Driving Base construction**: the hub rides on a **BRIGHT-YELLOW Technic frame** — model the
  chassis as a studless Technic frame: yellow beams (rounded ends) with **real through-holes**
  (dark short cylinders with a subtle ring rim) along the visible outer beams, magenta/azure
  pin accents (2–3 small pins), NOT a solid slab. The two drive motors lie flat inboard of the
  wheels with their azure discs facing out to the wheels. Caster = steel-grey ball in a white
  cup at the rear.
- **Palette**: Bright Yellow ≈ #FFCF00, Medium Azur ≈ #45B5D8, Magenta accent ≈ #C6197F,
  White plastic ≈ #F4F5F7, Technic hole inner ≈ #20242B.

**Performance budget**: prefer a few real cylinders for the outer visible holes + painted holes
on inner faces; share geometries/materials; total robot ≤ ~150 meshes. No Math.random.

Apply to BOTH 3D scenes: the sim view (js/view/view3d.js) and the 3D builder editor
(js/ui/builder3d.js — its palette ghosts + placed parts + chassis should match the same look).
Function frozen in both (APIs, interactions, badges, model-loader swap, movables, matrix).

## v1.6b — CRISP LEGO pass (why it still reads "toy-approximation", and the fix)

User verdict on v1.6: "sensors are overlapping and it doesn't look like LEGO." Defaults are fixed
(devices are now physically separated — never re-introduce stacked positions). The remaining gap
is GEOMETRY DISCIPLINE. Apply to BOTH 3D scenes (view3d.js sim + builder3d.js editor):

1. **Crisp edges, not blobs**: LEGO ABS has near-sharp edges with tiny chamfers. All RoundedBox
   radii for structural parts drop to 0.06–0.12 cm (hub may keep 0.25). Nothing soap-bar shaped.
2. **Open Technic frame**: the chassis is a rectangular RING (like the real 11×19 frame) — four
   beams of EXACTLY 0.8 cm square cross-section forming an open rectangle you can SEE THROUGH in
   the middle; the hub bridges across it on two short standoffs (0.4 cm tall) so a thin shadow
   gap shows under the hub. One mid crossbeam under the hub for believability. Real through-holes
   (Ø 0.48 cm, EXACT 0.8 cm pitch) along all visible beams. Deck: a thin (0.2 cm) yellow plate
   only over the rear half (bricks/arm seat there); front half stays open frame.
3. **Module discipline**: every part dimension snaps to the 0.8 cm LEGO module: hub EXACTLY
   8.8×5.6×3.2 sitting flat; medium motor body 4.0×2.4×2.4 (5×3×3 modules) + boss + disc Ø 1.8;
   distance sensor brick 5.6×2.4×2.4 with the black face plate 5.6×2.4; color sensor 1.6×1.6×2.0;
   force sensor 2.4×1.6×1.6 + plunger Ø 0.8. Wheels Ø from config (5.6 default), tire width 1.4.
4. **Materials**: plastic gloss — roughness ~0.35, clearcoat 0.15 for colored parts; white
   #F4F5F7; Bright Yellow #FFCF00; azure #45B5D8; near-black #1B1E24. Slight metalness 0 —
   LEGO is never metallic.
5. **No overlaps ever**: device housings must fit within a 2.4 cm footprint circle; if two
   configured devices are closer than 2.6 cm, offset the SECOND one visually by +1.3 cm laterally
   (deterministic, order = port letter) and never intersect meshes.
6. Keep every behavior + the v1.6 identities (azure dials w/ crosshole, goggle plate, port
   letters, live matrix, spin sources, model swap, bricks, badges, interactions). Budget ≤160.

## Verification bar (both agents)

`node --input-type=module --check` passes; no new globals; no changes to any exported signature;
grep your diff for `Math.random` (must be absent); state every visual feature you added in your
final notes so the integrator can screenshot-verify it.
