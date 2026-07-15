/**
 * SpikeSim — 3D view (three.js).
 *
 * Renders the loaded map (decorated mat texture on a table slab over a bright
 * studio stage, walls, obstacles) and the robot (SPIKE-style chassis + hub with a
 * live 5×5 light matrix, spoked wheels, sensors, arm) from live engine state.
 * Strictly read-only: this view NEVER steps the engine — app.js owns
 * stepping; the animation loop here only reads `engine.getState()` and draws.
 *
 * Art pass (docs/ART.md, v1.4 SPIKE-software LIGHT re-theme): ACES tone
 * mapping, soft-sky gradient background + fog, bright radial dot-grid stage,
 * rounded light table slab, plastic border walls, daylight 3-light rig, soft
 * gray blob shadows. The raster from mapraster.js stays SENSOR GROUND TRUTH:
 * it is only ever copied onto a separate decor canvas (grain + vignette +
 * contact-AO frame) that the mat material displays.
 *
 * v1.3 accuracy pass (ART.md "Accurate SPIKE Prime part reference"): robot
 * parts follow the official spec — 88:56:32 white hub (warm-white matrix,
 * button cluster, Bluetooth button + LED, lettered LPF2 port sockets), azure
 * tires on white 4-spoke rims, white drive-motor bodies with zero-mark end
 * caps, and white-bodied sensors with accurate face details.
 *
 * v1.5 assembly pass (ART.md "3D robot ASSEMBLY fix"): the arm is a real
 * motor+beam assembly — a white medium-motor body fixed at its configured
 * mount with the yellow beam pivoting at its END from the motor's lateral
 * axle, deterministically nudged forward if the configured mount would make
 * the beam sweep through the hub. Tires sit fully outboard of a narrowed
 * visual chassis (white rims proud of the rubber), the rear caster ball
 * seats in a visible socket cup below the tail, and the chassis carries
 * painted Technic beam holes, a top deck seam and a front bumper chamfer.
 *
 * v1.6 LEGO-DETAIL pass (ART.md): the chassis is a Bright-Yellow studless
 * Technic FRAME (rounded beams with REAL through-holes — dark inner
 * cylinders + subtle rim rings on the outer faces — and magenta/azure pin
 * accents) instead of a slab; the drive motors are white angular-motor
 * bodies whose medium-azure output discs (crosshole + zero-dot) SPIN with
 * the wheels; wheels get real 4-spoke cutout rims + center-grooved azur
 * tires; the distance sensor gains its black face plate with ringed eyes +
 * white LED arcs and black pin-hole side panels; the hub adds a speaker
 * grille, battery seam and an inset matrix bezel; the caster ball seats in
 * a white cup. Function frozen — state-driven updates unchanged.
 *
 * v1.6b CRISP LEGO pass (ART.md): geometry discipline. The chassis is an
 * OPEN Technic ring frame — four 0.8 cm-square beams you can see through,
 * real Ø 0.48 cm through-holes at the exact 0.8 cm module pitch, a thin
 * rear half-deck and a mid crossbeam — with the hub bridging it on 0.4 cm
 * standoffs (visible shadow gap). Every part snaps to the 0.8 cm module:
 * hub exactly 8.8×5.6×3.2, motors 4.0×2.4×2.4 with Ø 1.8 output discs,
 * distance brick 5.6×2.4×2.4, color 1.6×1.6×2.0, force 2.4×1.6×1.6 with a
 * Ø 0.8 plunger, tires 1.4 wide. Structural chamfers are crisp (radius
 * 0.06–0.12; hub keeps 0.25), materials are plastic-gloss (roughness 0.35,
 * clearcoat 0.15, metalness 0), and a deterministic anti-overlap VISUAL
 * guard (resolveDeviceOffsets) shifts a later-port device +1.3 cm laterally
 * whenever two devices land closer than 2.6 cm — meshes never intersect.
 *
 * Contract: docs/CONTRACT.md → AGENT-3D. Only js/view/ imports three.
 *
 * Conventions (see CONTRACT.md):
 *   world 2D (x, y) → 3D (x, 0, y)   [y-down mat maps onto the ground plane]
 *   heading:  mesh.rotation.y = -degToRad(headingDeg)  (clockwise-positive)
 *   robot local frame: +x forward, +z = robot's right side, +y up
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { on, emit } from '../core/bus.js';
import { loadRobotModel } from './model-loader.js';

/** SPIKE color name → display hex for the color-sensor's emissive disc. */
const SPIKE_COLOR_HEX = {
  black: '#111111',
  violet: '#8a3ecf',
  blue: '#1f5fd6',
  azure: '#35b3e8',
  green: '#2fbf55',
  yellow: '#f7d21e',
  red: '#e03131',
  white: '#ffffff',
  none: '#555555',
};

/** ART.md v1.6 LEGO palette (official SPIKE Prime part colors). */
const LEGO = {
  yellow: '#FFCF00',    // Bright Yellow (frame beams, arm beam)
  azure: '#45B5D8',     // Medium Azur (tires, motor discs/caps, pin accent)
  magenta: '#C6197F',   // magenta pin accents
  white: '#F4F5F7',     // white plastic (hub, motors, sensors, rims)
  holeInner: '#20242B', // Technic through-hole inner
};

/** Chassis bottom sits this many cm above the mat. */
const CHASSIS_LIFT = 1.5;

/** Follow camera: 35 cm behind the robot, 25 cm up, gentle lerp. */
const FOLLOW_BACK = 35;
const FOLLOW_UP = 25;
const FOLLOW_LERP = 0.08;

/** Hub light matrix: marquee step interval (SIM time, seconds). */
const MARQUEE_STEP_S = 0.35;

/**
 * Built-in 3×5 pixel font for the hub's 5×5 light matrix (A–Z, 0–9, space).
 * Each glyph is 5 rows of 3-bit values, MSB = left column. Rendered centered
 * (glyph columns land in matrix columns 1–3). Unknown chars → hollow square.
 */
const FONT3X5 = {
  A: [0b010, 0b101, 0b111, 0b101, 0b101],
  B: [0b110, 0b101, 0b110, 0b101, 0b110],
  C: [0b011, 0b100, 0b100, 0b100, 0b011],
  D: [0b110, 0b101, 0b101, 0b101, 0b110],
  E: [0b111, 0b100, 0b110, 0b100, 0b111],
  F: [0b111, 0b100, 0b110, 0b100, 0b100],
  G: [0b011, 0b100, 0b101, 0b101, 0b011],
  H: [0b101, 0b101, 0b111, 0b101, 0b101],
  I: [0b111, 0b010, 0b010, 0b010, 0b111],
  J: [0b001, 0b001, 0b001, 0b101, 0b010],
  K: [0b101, 0b101, 0b110, 0b101, 0b101],
  L: [0b100, 0b100, 0b100, 0b100, 0b111],
  M: [0b101, 0b111, 0b111, 0b101, 0b101],
  N: [0b110, 0b101, 0b101, 0b101, 0b101],
  O: [0b010, 0b101, 0b101, 0b101, 0b010],
  P: [0b110, 0b101, 0b110, 0b100, 0b100],
  Q: [0b010, 0b101, 0b101, 0b010, 0b001],
  R: [0b110, 0b101, 0b110, 0b101, 0b101],
  S: [0b011, 0b100, 0b010, 0b001, 0b110],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
  U: [0b101, 0b101, 0b101, 0b101, 0b111],
  V: [0b101, 0b101, 0b101, 0b101, 0b010],
  W: [0b101, 0b111, 0b111, 0b101, 0b101],
  X: [0b101, 0b101, 0b010, 0b101, 0b101],
  Y: [0b101, 0b101, 0b010, 0b010, 0b010],
  Z: [0b111, 0b001, 0b010, 0b100, 0b111],
  0: [0b010, 0b101, 0b101, 0b101, 0b010],
  1: [0b010, 0b110, 0b010, 0b010, 0b111],
  2: [0b110, 0b001, 0b010, 0b100, 0b111],
  3: [0b111, 0b001, 0b011, 0b001, 0b111],
  4: [0b101, 0b101, 0b111, 0b001, 0b001],
  5: [0b111, 0b100, 0b110, 0b001, 0b110],
  6: [0b011, 0b100, 0b111, 0b101, 0b111],
  7: [0b111, 0b001, 0b010, 0b010, 0b010],
  8: [0b111, 0b101, 0b111, 0b101, 0b111],
  9: [0b111, 0b101, 0b111, 0b001, 0b110],
  ' ': [0, 0, 0, 0, 0],
};

/** Fallback glyph for characters outside the font: a hollow square. */
const GLYPH_UNKNOWN = [0b111, 0b101, 0b101, 0b101, 0b111];

/**
 * Dispose every geometry / material / texture under a root object.
 * Safe on shared resources (three's dispose() is idempotent, and disposed
 * canvas textures re-upload automatically the next time they are rendered).
 * @param {THREE.Object3D} root
 */
function disposeTree(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

/**
 * Deterministic pseudo-random in [0, 1) from an integer index (golden-ratio
 * scramble) — index-derived variation, per the art determinism rule.
 * @param {number} i
 * @returns {number}
 */
function hash01(i) {
  return ((i + 1) * 0.6180339887498949) % 1;
}

/** Rounded-rect path helper (avoids relying on ctx.roundRect availability). */
function rrPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Vertical gradient background canvas texture (#DCE9F7 sky top → #F4F7FB horizon). */
function makeBackgroundTexture() {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#DCE9F7');
  g.addColorStop(1, '#F4F7FB');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Deterministic grey-noise tile (hash of pixel coords) used as a repeating
 * pattern for the mat's paper-grain overlay. Built once, reused forever.
 * @returns {HTMLCanvasElement}
 */
function makeGrainTile() {
  const N = 96;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      const v = Math.round((s - Math.floor(s)) * 255);
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Bright studio-floor canvas: `#E3E7EE` with a faint low-contrast dot grid
 * that fades out radially, gone by ~2 mat-widths from the mat center.
 * @param {number} sizeCm  stage plane edge length in cm
 * @param {number} matMaxCm  larger mat dimension in cm (fade reference)
 * @returns {HTMLCanvasElement}
 */
function makeStageCanvas(sizeCm, matMaxCm) {
  const N = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#E3E7EE';
  ctx.fillRect(0, 0, N, N);
  const px = N / sizeCm;           // canvas px per world cm
  const pitch = 12 * px;           // dots every ~12 cm
  const fade = 2.2 * matMaxCm * px;
  const cx = N / 2;
  const cy = N / 2;
  const dotR = Math.max(1, 1.1 * px);
  ctx.fillStyle = 'rgb(90,110,140)';
  for (let y = cy % pitch; y < N; y += pitch) {
    for (let x = cx % pitch; x < N; x += pitch) {
      const a = 1 - Math.hypot(x - cx, y - cy) / fade;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a * 0.35;
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  return c;
}

/**
 * Round part-face texture (shared v1.6 recipe): a filled disc with an outer
 * ring, an inner rotor ring, a dark "+" crosshole in the center and
 * (optionally) the white rotation zero-mark dot at 12 o'clock — used for
 * the wheels' hub caps (white base) and the angular motors' MEDIUM-AZURE
 * output discs (azure base + zero dot), per LEGO's tech-spec photos.
 * @param {string} baseHex  disc plastic color
 * @param {string} ringHex  ring / detail line color
 * @param {boolean} zeroDot true → white zero-mark dot at 12 o'clock
 * @returns {HTMLCanvasElement}
 */
function makeDiscFaceCanvas(baseHex, ringHex, zeroDot) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 64, 64);
  ctx.translate(32, 32);
  ctx.strokeStyle = ringHex;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, 27, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.beginPath();                 // inner rotor-hub ring
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = LEGO.holeInner;  // dark "+" crosshole
  ctx.fillRect(-2, -6.5, 4, 13);
  ctx.fillRect(-6.5, -2, 13, 4);
  if (zeroDot) {
    ctx.fillStyle = '#ffffff';     // rotation zero-mark at 12 o'clock
    ctx.beginPath();
    ctx.arc(0, -20, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/**
 * Hub-top deck texture (hub 45601, ART.md v1.3): white face carrying the
 * button cluster BELOW the matrix window (white oval L/R rocker + round
 * Center button with a faint azure RGB ring), a tiny Bluetooth button with
 * its LED dot near the top-left corner, 4 corner screw dots and a micro-USB
 * slot hint on the front edge — all painted, no tiny meshes.
 * Canvas orientation: top = robot FRONT (+x), right = robot RIGHT (+z).
 * @param {number} faceW   deck size across the hub in cm (canvas u)
 * @param {number} faceL   deck size along the hub in cm (canvas v)
 * @param {number} matOff  matrix-center offset from deck center toward the front (cm)
 * @param {number} matSize edge of the (square) light-matrix window (cm)
 * @returns {HTMLCanvasElement}
 */
function makeHubTopCanvas(faceW, faceL, matOff, matSize) {
  const cw = 168;
  const ch = Math.max(64, Math.round((cw * faceL) / faceW));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  const s = cw / faceW; // px per cm (square pixels — ch is proportional)
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = 'rgba(20,24,32,0.08)'; // soft moulding edge
  ctx.lineWidth = 2;
  rrPath(ctx, 1, 1, cw - 2, ch - 2, 6);
  ctx.stroke();

  // faint recess seam where the live light-matrix plane sits
  const matCy = ch / 2 - matOff * s;
  const matPx = matSize * s;
  ctx.strokeStyle = 'rgba(20,24,32,0.10)';
  ctx.lineWidth = 1.5;
  rrPath(ctx, cw / 2 - matPx / 2 - 2, matCy - matPx / 2 - 2, matPx + 4, matPx + 4, 8);
  ctx.stroke();

  // --- button cluster below the matrix: oval rocker + Center button --------
  const rkW = cw * 0.56;
  const rkH = Math.min(ch * 0.15, 42);
  const rkCy = Math.min(matCy + matPx / 2 + rkH * 0.85, ch - rkH * 0.75 - 6);
  const rg = ctx.createLinearGradient(0, rkCy - rkH / 2, 0, rkCy + rkH / 2);
  rg.addColorStop(0, '#ffffff');
  rg.addColorStop(1, '#dfe3ea');
  ctx.fillStyle = rg;
  ctx.strokeStyle = '#c3c9d2';
  ctx.lineWidth = 1.5;
  rrPath(ctx, cw / 2 - rkW / 2, rkCy - rkH / 2, rkW, rkH, rkH / 2);
  ctx.fill();
  ctx.stroke();
  const cbR = rkH * 0.56; // round Center button, faint azure RGB ring
  ctx.save();
  ctx.strokeStyle = 'rgba(64,175,235,0.55)';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(64,175,235,0.6)';
  ctx.shadowBlur = 3;
  ctx.beginPath();
  ctx.arc(cw / 2, rkCy, cbR + 2.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#fbfcfe';
  ctx.strokeStyle = '#c3c9d2';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cw / 2, rkCy, cbR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // --- tiny Bluetooth button + its LED dot, near the top-left corner -------
  const btX = cw * 0.13;
  const btY = Math.max(ch * 0.07, 20);
  ctx.fillStyle = '#eef1f5';
  ctx.strokeStyle = '#b9bfc9';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(btX, btY, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.fillStyle = '#35b3e8';
  ctx.shadowColor = 'rgba(53,179,232,0.8)';
  ctx.shadowBlur = 3;
  ctx.beginPath();
  ctx.arc(btX + 12, btY, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // --- 4 corner screw dots --------------------------------------------------
  ctx.lineWidth = 1.2;
  for (const [sx, sy] of [[10, 10], [cw - 10, 10], [10, ch - 10], [cw - 10, ch - 10]]) {
    ctx.fillStyle = '#c6ccd5';
    ctx.strokeStyle = '#9aa1ad';
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#6b727e'; // screw slot
    ctx.beginPath();
    ctx.moveTo(sx - 2.4, sy);
    ctx.lineTo(sx + 2.4, sy);
    ctx.stroke();
  }

  // --- micro-USB slot hint on the front (top) short edge --------------------
  ctx.fillStyle = '#2a2e36';
  rrPath(ctx, cw / 2 - 13, 2, 26, 6, 3);
  ctx.fill();
  return c;
}

/**
 * Hub long-side texture: 3 recessed dark LPF2 port sockets with legible
 * moulded port letters above them, a faint battery seam near the bottom
 * edge and (optionally, v1.6) a speaker-grille dot row. `letters` is given
 * in canvas LEFT→RIGHT order (the caller accounts for which way the face
 * is viewed).
 * @param {string[]} letters  3 port letters, canvas left→right
 * @param {number} faceL  face length in cm (canvas u)
 * @param {number} faceH  face height in cm (canvas v)
 * @param {boolean} [grille]  true → speaker-grille dot row (one side only)
 * @returns {HTMLCanvasElement}
 */
function makeHubSideCanvas(letters, faceL, faceH, grille) {
  const cw = 320;
  const ch = Math.max(48, Math.round((cw * faceH) / faceL));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, cw, ch);
  const sw = cw * 0.17;
  const sh = ch * 0.44;
  const cy = ch * 0.58;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < letters.length; i++) {
    const cx = cw * ((i + 0.5) / letters.length);
    // socket: dark LPF2 opening with a deeper inner slot + contact ridge
    ctx.fillStyle = '#1b1f26';
    ctx.strokeStyle = '#3a4049';
    ctx.lineWidth = 2;
    rrPath(ctx, cx - sw / 2, cy - sh / 2, sw, sh, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0d1015';
    rrPath(ctx, cx - sw / 2 + 5, cy - sh / 2 + 5, sw - 10, sh - 10, 3);
    ctx.fill();
    ctx.fillStyle = '#232932';
    ctx.fillRect(cx - sw / 2 + 8, cy - 1.5, sw - 16, 3);
    // moulded port letter beside (above) the socket — legible in close-up
    ctx.fillStyle = '#454b56';
    ctx.font = `bold ${Math.round(ch * 0.3)}px Arial, sans-serif`;
    ctx.fillText(letters[i], cx, ch * 0.18);
  }
  // v1.6: faint battery seam line near the bottom edge
  ctx.strokeStyle = 'rgba(20,24,32,0.16)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(4, ch * 0.93);
  ctx.lineTo(cw - 4, ch * 0.93);
  ctx.stroke();
  // v1.6: speaker-grille dot row above the seam (one long side only)
  if (grille) {
    ctx.fillStyle = 'rgba(20,24,32,0.55)';
    for (let i = 0; i < 14; i++) {
      const gx = cw * 0.3 + (i * (cw * 0.4)) / 13;
      ctx.beginPath();
      ctx.arc(gx, ch * 0.875, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

/**
 * Distance-sensor eye LEDs (45604, v1.6): 4 faint WHITE (≈4000 K) arc
 * segments around the eye — two upper, two lower (gaps on the axes) — on a
 * transparent tile.
 * @returns {HTMLCanvasElement}
 */
function makeEyeArcCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.translate(32, 32);
  ctx.strokeStyle = 'rgba(250,250,255,0.72)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(240,246,255,0.8)';
  ctx.shadowBlur = 4;
  for (let q = 0; q < 4; q++) {
    ctx.beginPath();
    ctx.arc(0, 0, 24, q * (Math.PI / 2) + 0.22, (q + 1) * (Math.PI / 2) - 0.22);
    ctx.stroke();
  }
  return c;
}

/**
 * Distance-sensor eye FACE (45604, v1.6): near-black disc with concentric
 * ring detail (the speaker-mesh look of the real eyes) and a darker,
 * recessed center lens with a tiny specular catch.
 * @returns {HTMLCanvasElement}
 */
function makeEyeFaceCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, 64, 64);
  ctx.translate(32, 32);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1.4;
  for (let r = 7; r <= 29; r += 4.4) {   // concentric mesh rings
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#04060a';             // recessed center lens
  ctx.beginPath();
  ctx.arc(0, 0, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.10)'; // tiny specular catch
  ctx.beginPath();
  ctx.arc(-3, -3, 2.2, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/**
 * Angular-motor flank (45603/45602, v1.6): white plastic carrying TWO rows
 * of black pin holes, as on the real motor body sides.
 * @returns {HTMLCanvasElement}
 */
function makeMotorFlankCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = LEGO.white;
  ctx.fillRect(0, 0, 64, 64);
  for (const y of [21, 43]) {
    for (let i = 0; i < 3; i++) {
      const x = 64 * ((i + 0.5) / 3);
      ctx.fillStyle = '#d6dae1';         // recessed rim
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = LEGO.holeInner;    // black pin hole
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

/**
 * Tire tread band (wheel 39367, v1.6): medium-azur rubber with a SHALLOW
 * darker CENTER GROOVE and soft shoulder shading. Mapped onto the tire
 * cylinder's lateral surface (u around the tread, v across it).
 * @returns {HTMLCanvasElement}
 */
function makeTireCanvas() {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = LEGO.azure;
  ctx.fillRect(0, 0, 8, 64);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';      // shallow center groove
  ctx.fillRect(0, 28, 8, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.14)'; // groove edge highlights
  ctx.fillRect(0, 26, 8, 2);
  ctx.fillRect(0, 36, 8, 2);
  ctx.fillStyle = 'rgba(0,0,0,0.16)';      // shoulder round-off shading
  ctx.fillRect(0, 0, 8, 4);
  ctx.fillRect(0, 60, 8, 4);
  return c;
}

/**
 * Axis-aligned box overlap test with a small visual margin (v1.6b guard).
 * Boxes are {x0,x1,y0,y1,z0,z1} in robot body-frame cm.
 * @returns {boolean}
 */
function boxHit(a, b, m = 0.03) {
  return a.x0 < b.x1 + m && a.x1 > b.x0 - m &&
         a.y0 < b.y1 + m && a.y1 > b.y0 - m &&
         a.z0 < b.z1 + m && a.z1 > b.z0 - m;
}

/**
 * v1.6b deterministic anti-overlap VISUAL guard (ART.md §5): devices are
 * processed in port-letter order. Rule A (spec): a device whose center lands
 * closer than 2.6 cm to an earlier device's center is offset +1.3 cm
 * laterally (body +y / robot right). Rule B (safety net): a device whose
 * footprint (one or more AABBs — an arm assembly is motor + dial + beam)
 * would still intersect a placed AABB (hub, wheel/drive-motor assemblies,
 * caster, earlier devices) steps 1.3 cm laterally AWAY from the blocker —
 * halving the step whenever the push direction flips (wedged between two
 * parts) so it settles into the nearest clear slot (bounded) — meshes never
 * intersect. Purely visual: the engine's sensor positions are untouched;
 * only the rendered offset moves.
 * @param {Array<{port:string,cx:number,cz:number,boxes:Array<object>}>} devs
 *   boxes are {x0,x1,y0,y1,z0,z1} with x/z RELATIVE to the device center
 *   (y absolute), matching the meshes the caller builds.
 * @param {Array<{x0:number,x1:number,y0:number,y1:number,z0:number,z1:number}>} blockers
 * @returns {Map<string, number>} port → lateral (body +z / robot-right) offset in cm
 */
function resolveDeviceOffsets(devs, blockers) {
  const placed = blockers.slice();
  const centers = []; // final centers of already-placed devices
  const out = new Map();
  const sorted = [...devs].sort((a, b) => (a.port < b.port ? -1 : a.port > b.port ? 1 : 0));
  for (const d of sorted) {
    let dz = 0;
    const boxesAt = (off) => d.boxes.map((b) => ({
      x0: d.cx + b.x0, x1: d.cx + b.x1,
      y0: b.y0, y1: b.y1,
      z0: d.cz + off + b.z0, z1: d.cz + off + b.z1,
    }));
    // Rule A (spec): centers closer than 2.6 cm → the LATER port steps +1.3.
    for (let i = 0; i < 6; i++) {
      const near = centers.some((e) => Math.hypot(d.cx - e.cx, d.cz + dz - e.cz) < 2.6);
      if (!near) break;
      dz += 1.3;
    }
    // Rule B (safety net): step away from any intersecting AABB, bounded.
    let step = 1.3;
    let lastDir = 0;
    for (let i = 0; i < 8; i++) {
      let hit = null;
      for (const box of boxesAt(dz)) {
        hit = placed.find((b) => boxHit(box, b));
        if (hit) break;
      }
      if (!hit) break;
      const dir = d.cz + dz >= (hit.z0 + hit.z1) / 2 ? 1 : -1;
      if (lastDir && dir !== lastDir) step = Math.max(step / 2, 0.325);
      lastDir = dir;
      dz += dir * step;
    }
    centers.push({ cx: d.cx, cz: d.cz + dz });
    placed.push(...boxesAt(dz));
    out.set(d.port, dz);
  }
  return out;
}

/** Soft radial blob-shadow texture (cool-gray core fading to transparent — light theme). */
function makeBlobTexture() {
  const N = 64;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(N / 2, N / 2, 2, N / 2, N / 2, N / 2);
  g.addColorStop(0, 'rgba(45,60,85,0.26)');
  g.addColorStop(0.55, 'rgba(45,60,85,0.13)');
  g.addColorStop(1, 'rgba(45,60,85,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, N, N);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

/**
 * 3D scene view of the simulation. Lazy: nothing three-related is created
 * until the first activate(), so the app boots fast even if 3D is never used.
 */
export class View3D {
  /**
   * @param {HTMLElement} hostEl  container div (#view3d-host); canvas is appended to it
   * @param {import('../core/engine.js').Engine} engine  simulation engine (read-only here)
   */
  constructor(hostEl, engine) {
    if (!hostEl) throw new Error('View3D: missing host element — is #view3d-host in the page?');
    if (!engine) throw new Error('View3D: missing engine.');
    this._host = hostEl;
    this._engine = engine;

    this._built = false;   // scene constructed?
    this._failed = false;  // WebGL init failed — don't retry every tab click
    this._active = false;
    this._follow = false;
    this._lastMatW = -1;   // last mat size the camera was homed for
    this._lastMatH = -1;

    // live handles filled by _rebuildRobot()
    this._wheelL = null;
    this._wheelR = null;
    this._drive = null;          // { leftPort, rightPort }
    this._arms = {};             // port → pivot Group (rotation.z = arm angle)
    this._colorDiscs = {};       // port → emissive disc material
    this._motorDiscs = null;     // v1.6: {left,right} azure output discs, spin with wheels

    // hub light matrix (art pass): repainted only when the shown frame changes
    this._matrixCtx = null;      // 2d context of the 64×64 matrix canvas
    this._matrixTex = null;      // CanvasTexture on the hub top
    this._matrixKey = null;      // cache: last drawn "text|step" key

    // v1.1: one box mesh per movable crate, index-aligned with state.movables;
    // rebuilt by _rebuildMap (on 'map-changed'), positions re-synced every _tick.
    this._movableMeshes = [];
    this._movableShadows = [];   // blob-shadow plane per crate (same indices)

    // Rebuild on engine changes. Before the first build there is nothing to
    // rebuild — _build() reads the current engine state anyway.
    on('map-changed', () => { if (this._built) this._rebuildMap(); });
    on('robot-changed', () => { if (this._built) this._rebuildRobot(); });
  }

  /**
   * Show the view: build the scene on first call, then start the render loop.
   */
  activate() {
    if (this._failed) return;
    if (!this._built) {
      try {
        this._build();
      } catch (err) {
        this._failed = true;
        emit('log', {
          text: `3D view could not start (${err.message}). Your browser may not support WebGL — the 2D view still works!`,
          level: 'error',
        });
        return;
      }
    }
    this._active = true;
    this.resize();
    this._renderer.setAnimationLoop(() => this._tick());
  }

  /** Hide the view: stop the render loop (scene is kept for instant return). */
  deactivate() {
    this._active = false;
    if (this._renderer) this._renderer.setAnimationLoop(null);
  }

  /** Render a single frame outside the animation loop (e.g. while the tab is throttled). */
  render() {
    if (this._built && !this._failed) this._tick();
  }

  /** Match the renderer and camera to the host element's current size. */
  resize() {
    if (!this._built) return;
    const w = this._host.clientWidth;
    const h = this._host.clientHeight;
    if (w < 2 || h < 2) return; // hidden pane — keep last size
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this._renderer.setSize(w, h);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  /**
   * Toggle follow-cam. On: camera glides along behind the robot. Off: free
   * OrbitControls, left exactly where the follow-cam last put them.
   * @param {boolean} enabled
   */
  setFollow(enabled) {
    this._follow = !!enabled;
    if (this._controls) this._controls.enabled = !this._follow;
  }

  /**
   * Re-frame the camera to the whole-mat home position (the same framing
   * used on first load / when the mat size changes). Safe no-op before the
   * scene is built. Not wired to any UI here — callers opt in.
   */
  homeCamera() {
    if (!this._built) return;
    const w = this._lastMatW > 0 ? this._lastMatW : 200;
    const h = this._lastMatH > 0 ? this._lastMatH : 120;
    this._homeCamera(w, h);
  }

  // ------------------------------------------------------------- internals

  /** One-time scene construction (renderer, camera, lights, groups). */
  _build() {
    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap; // soft round-ish shadows
    this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._renderer.toneMappingExposure = 1.1;
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer.domElement.style.display = 'block';
    this._host.appendChild(this._renderer.domElement);

    this._scene = new THREE.Scene();
    this._scene.background = makeBackgroundTexture(); // vertical gradient
    this._scene.fog = new THREE.Fog(0xf4f7fb, 900, 2200); // matches horizon color

    // Units are cm, mats are ~100-240cm, so near=1 / far=2000 fits well.
    this._camera = new THREE.PerspectiveCamera(50, 1, 1, 2000);

    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.maxPolarAngle = Math.PI / 2 - 0.03; // don't dive under the mat
    this._controls.minDistance = 10;
    this._controls.maxDistance = 1200;
    this._controls.enabled = !this._follow; // setFollow() may run before build

    // Three-light rig (ART.md v1.4 bright studio): strong white hemisphere
    // fill + warm key with shadows + subtle cool rim from behind-left. The
    // high hemisphere level lifts shadowed areas so shadows read GRAY, not
    // black — cheerful daylight, not a night garage.
    this._scene.add(new THREE.HemisphereLight('#ffffff', '#cfd4da', 1.0));
    const dir = new THREE.DirectionalLight('#fff6e6', 1.6);
    dir.position.set(180, 260, 140); // ~45° key
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    const S = 260; // ortho shadow box big enough for a 300cm mat
    dir.shadow.camera.left = -S;
    dir.shadow.camera.right = S;
    dir.shadow.camera.top = S;
    dir.shadow.camera.bottom = -S;
    dir.shadow.camera.near = 50;
    dir.shadow.camera.far = 900;
    dir.shadow.bias = -0.0004;
    this._scene.add(dir);
    this._scene.add(dir.target); // target is re-aimed at the mat center on map load
    this._dirLight = dir;
    const rim = new THREE.DirectionalLight('#a8c3e8', 0.35);
    rim.position.set(-220, 140, -180); // behind-left, no shadows
    this._scene.add(rim);

    this._mapGroup = new THREE.Group();
    this._scene.add(this._mapGroup);
    this._robot = new THREE.Group();
    this._scene.add(this._robot);

    // scratch vectors for the follow cam (no per-frame allocation)
    this._followPos = new THREE.Vector3();
    this._lookPos = new THREE.Vector3();

    this._built = true;
    this._rebuildMap();   // also homes the camera (uses defaults when no map yet)
    this._rebuildRobot();

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this._host);
    }
  }

  /** Place the camera so the whole mat is in view. */
  _homeCamera(w, h) {
    this._camera.position.set(w * 0.7, Math.max(w, h) * 0.8, h * 1.3);
    this._controls.target.set(w / 2, 0, h / 2);
    this._camera.lookAt(this._controls.target);
    this._controls.update();
  }

  /**
   * Soft blob-shadow: a flat plane with the shared radial-gradient texture.
   * Shared unit geometry + texture; per-mesh material (cheap, disposed with
   * its parent group). Never casts/receives — display only.
   * @param {number} sx  footprint x size (cm)
   * @param {number} sz  footprint z size (cm)
   * @returns {THREE.Mesh}
   */
  _makeBlobShadow(sx, sz) {
    if (!this._blobTex) this._blobTex = makeBlobTexture();
    if (!this._blobGeo) {
      this._blobGeo = new THREE.PlaneGeometry(1, 1);
      this._blobGeo.rotateX(-Math.PI / 2); // bake: lie flat, face up
    }
    const mesh = new THREE.Mesh(
      this._blobGeo,
      new THREE.MeshBasicMaterial({
        map: this._blobTex,
        transparent: true,
        depthWrite: false,
        fog: false,
      })
    );
    mesh.scale.set(sx, 1, sz);
    mesh.renderOrder = 1;
    mesh.userData.noShadow = true;
    return mesh;
  }

  /**
   * Redraw the mat's DISPLAY texture: raster copy + paper grain + vignette +
   * a 1.5 cm contact-AO frame. The sensor raster itself is never modified —
   * it is only the drawImage source here (ART.md hard rule).
   * @param {object} map  current map JSON (for cm→px scale)
   */
  _repaintMatDecor(map) {
    const src = this._engine.getMapCanvas();
    if (!this._grainTile) this._grainTile = makeGrainTile();
    if (!this._decorCanvas) this._decorCanvas = document.createElement('canvas');
    const c = this._decorCanvas;
    if (c.width !== src.width || c.height !== src.height) {
      c.width = src.width;
      c.height = src.height;
    }
    const ctx = c.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.drawImage(src, 0, 0);
    // paper grain: ~2.5% deterministic noise
    ctx.globalAlpha = 0.025;
    ctx.fillStyle = ctx.createPattern(this._grainTile, 'repeat');
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalAlpha = 1;
    // very subtle vignette
    const cx = c.width / 2;
    const cy = c.height / 2;
    const rO = Math.hypot(cx, cy);
    const vg = ctx.createRadialGradient(cx, cy, rO * 0.45, cx, cy, rO);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.06)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, c.width, c.height);
    // 1.5 cm darker outer frame — fakes contact AO against the slab
    const band = 1.5 * (c.width / map.widthCm);
    ctx.strokeStyle = 'rgba(0,0,0,0.11)';
    ctx.lineWidth = band;
    ctx.strokeRect(band / 2, band / 2, c.width - band, c.height - band);
    ctx.strokeStyle = 'rgba(0,0,0,0.05)'; // softer inner step
    ctx.strokeRect(band * 1.5, band * 1.5, c.width - band * 3, c.height - band * 3);
  }

  /** Rebuild stage, table slab, mat, walls, border and obstacles from the current map. */
  _rebuildMap() {
    disposeTree(this._mapGroup); // also disposes the movable meshes (children)
    this._mapGroup.clear();
    this._movableMeshes = [];
    this._movableShadows = [];

    let map = null;
    try { map = this._engine.getMapJson(); } catch { map = null; }

    const w = map ? map.widthCm : 200;
    const h = map ? map.heightCm : 120;

    // --- stage: large bright plane with a radial dot grid fading out -------
    const matMax = Math.max(w, h);
    const stageSize = Math.min(Math.max(matMax * 6, 1000), 2000);
    const stageTex = new THREE.CanvasTexture(makeStageCanvas(stageSize, matMax));
    stageTex.colorSpace = THREE.SRGBColorSpace;
    const stage = new THREE.Mesh(
      new THREE.PlaneGeometry(stageSize, stageSize),
      new THREE.MeshStandardMaterial({ map: stageTex, roughness: 1, metalness: 0 })
    );
    stage.rotation.x = -Math.PI / 2;
    // With a map the stage sits under the 6cm table slab; with no map it acts
    // as the floor directly under the robot.
    stage.position.set(w / 2, map ? -6.15 : -0.05, h / 2);
    stage.receiveShadow = true;
    this._mapGroup.add(stage);

    if (!map) {
      // No map loaded yet — still give the empty scene a sensible camera.
      if (!this._follow) this._homeCamera(200, 120);
      return;
    }

    // --- table slab: mat footprint + 14cm margin, 6cm thick, beveled -------
    const slab = new THREE.Mesh(
      new RoundedBoxGeometry(w + 28, 6, h + 28, 2, 1.5),
      new THREE.MeshStandardMaterial({ color: '#CBD2DD', roughness: 0.85 })
    );
    slab.position.set(w / 2, -3.06, h / 2); // top face just under the mat plane
    slab.receiveShadow = true;
    this._mapGroup.add(slab);

    // --- ground plane with the DECORATED raster as its texture -------------
    // Texture orientation reasoning (decor canvas is a 1:1 copy of the raster):
    //   PlaneGeometry UVs put v=1 at the local +y edge. With rotation.x=-PI/2
    //   local +y points toward world -z, and the plane is centered at
    //   (w/2, 0, h/2), so the v=1 edge lies at world z=0 — which is map y=0,
    //   the TOP of the mat. CanvasTexture keeps three's default flipY=true,
    //   which uploads the canvas so its TOP row lands at v=1. Canvas top row
    //   is map y=0 → it lands exactly on the world z=0 edge. u runs 0→1 along
    //   local +x = world +x, matching map x directly. No mirroring — the 2D
    //   and 3D views agree.
    this._repaintMatDecor(map);
    const texture = new THREE.CanvasTexture(this._decorCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, this._renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(w / 2, 0, h / 2); // world (x,y) → 3D (x, 0, y)
    ground.receiveShadow = true;
    this._mapGroup.add(ground);

    // --- interior wall segments ------------------------------------------
    const wallMat = new THREE.MeshStandardMaterial({ color: '#8f95a3', roughness: 0.8 });
    for (const wall of map.walls || []) {
      const dx = wall.x2 - wall.x1;
      const dy = wall.y2 - wall.y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      const hCm = wall.heightCm ?? 10;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, hCm, 3), wallMat);
      mesh.position.set((wall.x1 + wall.x2) / 2, hCm / 2, (wall.y1 + wall.y2) / 2);
      // 2D segment angle (y-down, clockwise-positive) → negate for three's +y rotation
      mesh.rotation.y = -Math.atan2(dy, dx);
      mesh.castShadow = mesh.receiveShadow = true;
      this._mapGroup.add(mesh);
    }

    // --- border walls (FLL-table style), inner faces flush with mat edges --
    // Matte plastic grey with a slightly lighter top face (material index 2).
    if (map.border) {
      const bSideMat = new THREE.MeshStandardMaterial({ color: '#c9cdd6', roughness: 0.6 });
      const bTopMat = new THREE.MeshStandardMaterial({ color: '#dde1e8', roughness: 0.55 });
      const bMats = [bSideMat, bSideMat, bTopMat, bSideMat, bSideMat, bSideMat];
      const t = 2;  // thickness
      const bh = 8; // height
      const borders = [
        [w + 2 * t, t, w / 2, -t / 2],     // north (map y = 0)
        [w + 2 * t, t, w / 2, h + t / 2],  // south
        [t, h, -t / 2, h / 2],             // west  (map x = 0)
        [t, h, w + t / 2, h / 2],          // east
      ];
      for (const [sx, sz, px, pz] of borders) {
        const mesh = new THREE.Mesh(new RoundedBoxGeometry(sx, bh, sz, 2, 0.5), bMats);
        mesh.position.set(px, bh / 2, pz);
        mesh.castShadow = mesh.receiveShadow = true;
        this._mapGroup.add(mesh);
      }
    }

    // --- obstacles ---------------------------------------------------------
    for (const o of map.obstacles || []) {
      if (o.movable) continue; // v1.1: movable crates get live meshes below
      const hCm = o.heightCm ?? 8;
      const mesh = new THREE.Mesh(
        new RoundedBoxGeometry(Math.max(o.w, 0.1), hCm, Math.max(o.h, 0.1), 2, 0.6),
        new THREE.MeshStandardMaterial({ color: o.color || '#3b6fd4', roughness: 0.7 })
      );
      // obstacle (x, y) is its top-left corner in map coords
      mesh.position.set(o.x + o.w / 2, hCm / 2, o.y + o.h / 2);
      mesh.castShadow = mesh.receiveShadow = true;
      this._mapGroup.add(mesh);
    }

    // --- movable crates (v1.1): one mesh each, tracking state.movables ------
    // Art: rounded, top face ~8% lighter, deterministic ±4% lightness by
    // index, blob shadow per crate. Geometry cached per unique size.
    let movs = [];
    try {
      const st = this._engine.getState();
      movs = (st && st.movables) || [];
    } catch { movs = []; }
    const crateGeoCache = new Map();
    for (let i = 0; i < movs.length; i++) {
      const m = movs[i];
      const hCm = m.heightCm ?? 8;
      const key = `${m.w}|${hCm}|${m.h}`;
      let geo = crateGeoCache.get(key);
      if (!geo) {
        geo = new RoundedBoxGeometry(Math.max(m.w, 0.1), hCm, Math.max(m.h, 0.1), 2, 0.6);
        crateGeoCache.set(key, geo);
      }
      const side = new THREE.Color(m.color || '#3b6fd4');
      side.offsetHSL(0, 0, (hash01(i) - 0.5) * 0.08); // ±4% per-crate variation
      const top = side.clone().offsetHSL(0, 0, 0.07);  // ~8% lighter top
      const mesh = new THREE.Mesh(geo, [
        new THREE.MeshStandardMaterial({ color: side, roughness: 0.55 }),
        new THREE.MeshStandardMaterial({ color: side, roughness: 0.55 }),
        new THREE.MeshStandardMaterial({ color: top, roughness: 0.5 }),
        new THREE.MeshStandardMaterial({ color: side, roughness: 0.55 }),
        new THREE.MeshStandardMaterial({ color: side, roughness: 0.55 }),
        new THREE.MeshStandardMaterial({ color: side, roughness: 0.55 }),
      ]);
      mesh.position.set(m.x + m.w / 2, hCm / 2, m.y + m.h / 2);
      mesh.castShadow = mesh.receiveShadow = true;
      this._mapGroup.add(mesh); // disposed with the map group on rebuild
      this._movableMeshes.push(mesh);
      const blob = this._makeBlobShadow(m.w * 1.5, m.h * 1.5);
      blob.position.set(m.x + m.w / 2, 0.045, m.y + m.h / 2);
      this._mapGroup.add(blob);
      this._movableShadows.push(blob);
    }

    // Aim the sun at this mat's center so shadows stay centered on any map.
    this._dirLight.target.position.set(w / 2, 0, h / 2);
    // Re-home the camera only when the mat SIZE changes (first load / new map).
    // Map edits also emit 'map-changed' and must not yank the user's camera.
    if ((w !== this._lastMatW || h !== this._lastMatH) && !this._follow) {
      this._homeCamera(w, h);
    }
    this._lastMatW = w;
    this._lastMatH = h;
  }

  /**
   * Shared plastic-gloss material (ART.md v1.6b): roughness ~0.35,
   * clearcoat 0.15, metalness 0 — LEGO ABS is glossy and NEVER metallic.
   * Cached across rebuilds so every part with the same color shares one
   * material (dispose() on a shared material is safe — three re-uploads it
   * automatically the next time it is rendered).
   * @param {string} hex  plastic color
   * @param {number} [rough]  roughness override (rubber, sockets)
   * @returns {THREE.MeshPhysicalMaterial}
   */
  _plastic(hex, rough = 0.35) {
    if (!this._plasticCache) this._plasticCache = new Map();
    const key = hex + ':' + rough;
    let m = this._plasticCache.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({
        color: hex,
        roughness: rough,
        metalness: 0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.5,
      });
      this._plasticCache.set(key, m);
    }
    return m;
  }

  /** Rebuild the robot group from engine.getRobotConfig(). */
  _rebuildRobot() {
    // v1.1 (AGENT-MODEL): every rebuild invalidates any in-flight model load
    // from a previous rebuild — including rebuilds for robots WITHOUT a model,
    // so a stale async load can never attach to the wrong robot.
    this._modelToken = (this._modelToken || 0) + 1;
    disposeTree(this._robot);
    this._robot.clear();
    this._wheelL = this._wheelR = null;
    this._drive = null;
    this._arms = {};
    this._colorDiscs = {};
    this._motorDiscs = null;
    this._matrixCtx = null;
    this._matrixTex = null;
    this._matrixKey = null;

    let cfg = null;
    try { cfg = this._engine.getRobotConfig(); } catch { cfg = null; }
    if (!cfg || !cfg.chassis) return;

    const ch = cfg.chassis;
    const L = ch.lengthCm ?? 14;
    const W = ch.widthCm ?? 11;
    const bottom = CHASSIS_LIFT;
    const deckY = bottom + 0.8; // top of the 0.8 cm-square frame beams

    // Drive geometry up-front: the v1.6b ring frame is built at the config
    // footprint, so the wheels sit just outboard of the frame's side beams
    // (visual only — the engine never reads these meshes).
    const drive = cfg.drive || {};
    const wheelR = (drive.wheelDiameterCm ?? 5.6) / 2;
    const track = drive.trackWidthCm ?? 11.2;
    const tireW = 1.4;                               // exact 57×14 module width
    const wheelZ = Math.max(track / 2, W / 2 + 1.3); // clears the frame ring
    const wheelInnerZ = wheelZ - tireW / 2;
    const motorZc = Math.max(3.7, W / 2 - 1.6);      // drive-motor body center
    const aniso = Math.min(4, this._renderer.capabilities.getMaxAnisotropy());

    // --- body: the "chassis visuals" a custom model replaces --------------
    // v1.6b OPEN Technic ring frame (ART.md): four 0.8 cm-square beams with
    // crisp 0.08 chamfers forming a rectangle you can SEE THROUGH, real
    // Ø 0.48 through-holes at the exact 0.8 cm module pitch, one mid
    // crossbeam carrying the hub's two 0.4 cm standoffs, a thin 0.2 cm deck
    // plate over the REAR half only, and 3 deterministic pin accents.
    const body = new THREE.Group();
    const chColor = ch.color || LEGO.yellow; // Bright-Yellow frame by default
    const beamMat = this._plastic(chColor);
    const holeMat = this._plastic(LEGO.holeInner, 0.55);
    const yBeam = bottom + 0.4;      // center of the 0.8 cm beam section
    const beamZc = W / 2 - 0.4;      // side-beam centerline

    // ring: two full-length side beams + front/rear beams tucked between
    const sideGeo = new RoundedBoxGeometry(L, 0.8, 0.8, 2, 0.08);
    const endW = Math.max(0.8, W - 1.6);
    const endGeo = new RoundedBoxGeometry(0.8, 0.8, endW, 2, 0.08);
    for (const side of [-1, 1]) {
      const beam = new THREE.Mesh(sideGeo, beamMat);
      beam.position.set(0, yBeam, side * beamZc);
      body.add(beam);
    }
    for (const end of [-1, 1]) {
      const beam = new THREE.Mesh(endGeo, beamMat);
      beam.position.set(end * (L / 2 - 0.4), yBeam, 0);
      body.add(beam);
    }

    // mid crossbeam under the hub + the two 0.4 cm standoffs it bridges onto
    // (x −2.8 keeps it clear of the drive-motor bodies, which span x −0.8…2.4)
    const crossX = THREE.MathUtils.clamp(-2.8, -(L / 2 - 1.2), L / 2 - 1.2);
    const cross = new THREE.Mesh(endGeo, beamMat);
    cross.position.set(crossX, yBeam, 0);
    body.add(cross);
    const standGeo = new RoundedBoxGeometry(0.8, 0.4, 1.6, 2, 0.06);
    for (const side of [-1, 1]) {
      const stand = new THREE.Mesh(standGeo, beamMat);
      stand.position.set(crossX, deckY + 0.2, side * 1.4);
      body.add(stand);
    }

    // thin 0.2 cm deck plate over the REAR half only (bricks/arm seat here);
    // the front half stays open frame — the mat shows through the middle
    const plateX0 = -L / 2 + 0.8; // inside the rear end beam
    const plateX1 = crossX - 0.4; // abuts the crossbeam
    if (plateX1 - plateX0 > 0.8) {
      const plate = new THREE.Mesh(
        new RoundedBoxGeometry(plateX1 - plateX0, 0.2, endW, 2, 0.06),
        beamMat
      );
      plate.position.set((plateX0 + plateX1) / 2, deckY - 0.1, 0);
      body.add(plate);
    }

    // real through-holes: Ø 0.48 cm at the EXACT 0.8 cm pitch, centered runs
    // (counts capped for the ≤160-mesh budget); shared geometry per axis
    const holeGeoZ = new THREE.CylinderGeometry(0.24, 0.24, 0.9, 12);
    holeGeoZ.rotateX(Math.PI / 2); // pierce the side beams laterally (±z)
    const holeGeoX = new THREE.CylinderGeometry(0.24, 0.24, 0.9, 12);
    holeGeoX.rotateZ(Math.PI / 2); // pierce the end/cross beams lengthwise
    const nSide = THREE.MathUtils.clamp(Math.floor((L - 1.6) / 0.8) + 1, 2, 14);
    const nEnd = THREE.MathUtils.clamp(Math.floor((endW - 0.8) / 0.8) + 1, 1, 10);
    for (const side of [-1, 1]) {
      for (let i = 0; i < nSide; i++) {
        const hole = new THREE.Mesh(holeGeoZ, holeMat);
        hole.position.set((i - (nSide - 1) / 2) * 0.8, yBeam, side * beamZc);
        body.add(hole);
      }
    }
    for (const bx of [-(L / 2 - 0.4), L / 2 - 0.4, crossX]) {
      for (let i = 0; i < nEnd; i++) {
        const hole = new THREE.Mesh(holeGeoX, holeMat);
        hole.position.set(bx, yBeam, (i - (nEnd - 1) / 2) * 0.8);
        body.add(hole);
      }
    }

    // pin accents: 2 magenta + 1 azure seated in side-beam holes (v1.6
    // identity, deterministic indices — no randomness)
    const pinGeo = new THREE.CylinderGeometry(0.22, 0.22, 1.2, 10);
    pinGeo.rotateX(Math.PI / 2);
    for (const p of [
      { side: -1, i: 1, hex: LEGO.magenta },
      { side: 1, i: nSide - 2, hex: LEGO.magenta },
      { side: -1, i: nSide - 1, hex: LEGO.azure },
    ]) {
      if (p.i < 0 || p.i >= nSide) continue;
      const pin = new THREE.Mesh(pinGeo, this._plastic(p.hex, 0.3));
      pin.position.set((p.i - (nSide - 1) / 2) * 0.8, yBeam, p.side * beamZc);
      body.add(pin);
    }

    // --- hub (45601): EXACTLY 8.8×5.6×3.2 cm (v1.6b module discipline) ------
    // Sits flat, bridging the crossbeam's two 0.4 cm standoffs so a thin
    // shadow gap shows underneath; slightly rear of center like the real
    // Driving Base, leaving the nose free for front-mounted assemblies.
    const hubL = 8.8;
    const hubW = 5.6;
    const hubH = 3.2;
    const hubX = -L * 0.06;
    const hubBase = deckY + 0.4; // on the standoffs → visible 0.4 cm gap
    const hubTop = hubBase + hubH;
    const hub = new THREE.Mesh(
      new RoundedBoxGeometry(hubL, hubH, hubW, 3, 0.25),
      this._plastic('#f4f6f8', 0.35)
    );
    hub.position.set(hubX, hubBase + hubH / 2, 0);
    body.add(hub);

    // Live 5×5 light matrix (warm-white LEDs): 64×64 canvas texture in the
    // UPPER-MIDDLE of the hub top face, repainted in _tick only when the
    // shown frame changes (see _updateMatrix).
    const mCanvas = document.createElement('canvas');
    mCanvas.width = mCanvas.height = 64;
    this._matrixCtx = mCanvas.getContext('2d');
    this._matrixTex = new THREE.CanvasTexture(mCanvas);
    this._matrixTex.colorSpace = THREE.SRGBColorSpace;
    const mSize = Math.min(hubW * 0.62, hubL * 0.42);
    const matOff = hubL * 0.15; // matrix-center offset toward the front
    const mGeo = new THREE.PlaneGeometry(mSize, mSize);
    // Face up with the text top toward the robot's front (+x), readable from
    // the follow cam: u → +z (robot right), v → +x.
    mGeo.rotateX(-Math.PI / 2);
    mGeo.rotateY(-Math.PI / 2);
    const matrix = new THREE.Mesh(
      mGeo,
      new THREE.MeshBasicMaterial({ map: this._matrixTex, fog: false })
    );
    matrix.position.set(hubX + matOff, hubTop + 0.12, 0);
    matrix.userData.noShadow = true;
    body.add(matrix);

    // v1.6: inset matrix BEZEL — a slightly larger dark plate just beneath
    // the light-matrix plane so the window reads recessed into the deck.
    const bezelGeo = new THREE.PlaneGeometry(mSize + 0.7, mSize + 0.7);
    bezelGeo.rotateX(-Math.PI / 2);
    const bezel = new THREE.Mesh(
      bezelGeo,
      new THREE.MeshStandardMaterial({ color: '#171b22', roughness: 0.5 })
    );
    bezel.position.set(hubX + matOff, hubTop + 0.07, 0);
    bezel.userData.noShadow = true;
    body.add(bezel);

    // Hub-top deck texture: button cluster (rocker + Center button with a
    // faint azure RGB ring) below the matrix, Bluetooth button + LED near
    // the top-left corner, 4 corner screws, micro-USB hint — painted onto a
    // canvas rather than meshed (ART.md v1.3). Sized to the flat top area.
    const topW = Math.max(hubW * 0.6, hubW - 1.0);
    const topL = Math.max(hubL * 0.6, hubL - 1.0);
    const topTex = new THREE.CanvasTexture(makeHubTopCanvas(topW, topL, matOff, mSize));
    topTex.colorSpace = THREE.SRGBColorSpace;
    topTex.anisotropy = aniso;
    const topGeo = new THREE.PlaneGeometry(topW, topL);
    topGeo.rotateX(-Math.PI / 2);
    topGeo.rotateY(-Math.PI / 2); // u → +z, v → +x (canvas top = robot front)
    const topDeck = new THREE.Mesh(
      topGeo,
      new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.4 })
    );
    topDeck.position.set(hubX, hubTop + 0.04, 0);
    topDeck.userData.noShadow = true;
    body.add(topDeck);

    // LPF2 port sockets: 3 dark sockets per long side with moulded letters —
    // left (−z) A, C, E and right (+z) B, D, F, both ordered front→back.
    const sideW = Math.max(hubL * 0.6, hubL - 1.0);
    const sideH = Math.max(hubH * 0.5, hubH - 1.0);
    const portGeo = new THREE.PlaneGeometry(sideW, sideH);
    const mkPorts = (letters, side, grille) => {
      const tex = new THREE.CanvasTexture(makeHubSideCanvas(letters, sideW, sideH, grille));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = aniso;
      const m = new THREE.Mesh(
        portGeo,
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45 })
      );
      m.position.set(hubX, hubBase + hubH / 2, side * (hubW / 2 + 0.02));
      if (side < 0) m.rotation.y = Math.PI; // face outward on the left side
      m.userData.noShadow = true;
      body.add(m);
    };
    // Canvas left→right order: the right face is viewed with the robot's
    // front on the RIGHT; the (rotated) left face with the front on the LEFT.
    // v1.6: the speaker-grille dot row lives on the RIGHT long side.
    mkPorts(['F', 'D', 'B'], 1, true); // robot right (+z): B, D, F front→back
    mkPorts(['A', 'C', 'E'], -1);      // robot left  (−z): A, C, E front→back

    this._robot.add(body);
    this._matrixKey = '';
    this._paintMatrix('', true); // dim idle grid until the first tick

    // --- soft blob shadow so the robot always feels grounded ---------------
    // (kept even when a custom model replaces the chassis visuals)
    const blob = this._makeBlobShadow(L * 1.6, W * 1.9);
    blob.position.y = 0.05;
    this._robot.add(blob);

    // --- wheels (39367 "57 × 14, 4 spokes", v1.6): MEDIUM-AZUR tire with a
    // shallow center GROOVE (tread texture) + WHITE rim with 4 REAL round
    // spoke cutouts (extruded disc — the azure motor disc shows through the
    // cutouts, exactly like the real wheel) + a white hub cap carrying the
    // crosshole mark. Shared geometries/materials across both wheels; spin
    // logic unchanged: the wheel GROUP's rotation.z takes -degToRad(posDeg)
    // in _tick, so the spoke cutouts visibly rotate. The rim is biased
    // OUTBOARD (mirrored per side) so it sits proud of the rubber.
    const tireTex = new THREE.CanvasTexture(makeTireCanvas());
    tireTex.colorSpace = THREE.SRGBColorSpace;
    const tireGeo = new THREE.CylinderGeometry(wheelR, wheelR, tireW, 24);
    tireGeo.rotateX(Math.PI / 2); // bake: cylinder axis local y → local z (the axle)
    const treadMat = new THREE.MeshStandardMaterial({ map: tireTex, roughness: 0.85 });
    const tireCapMat = new THREE.MeshStandardMaterial({ color: LEGO.azure, roughness: 0.85 });
    const tireMats = [treadMat, tireCapMat, tireCapMat]; // groove around the tread
    const capR = wheelR * 0.62;
    const rimShape = new THREE.Shape();
    rimShape.absarc(0, 0, capR, 0, Math.PI * 2, false);
    for (let i = 0; i < 4; i++) {
      const a = i * (Math.PI / 2) + Math.PI / 4;
      const holePath = new THREE.Path();
      holePath.absarc(
        Math.cos(a) * capR * 0.56, Math.sin(a) * capR * 0.56,
        capR * 0.27, 0, Math.PI * 2, true
      );
      rimShape.holes.push(holePath);
    }
    const rimDepth = tireW + 0.5;
    const mkRimGeo = (out) => {
      const geo = new THREE.ExtrudeGeometry(rimShape, {
        depth: rimDepth,
        bevelEnabled: false,
        curveSegments: 18,
      });
      // bias outboard: inner face ~flush inside the tire, outer face proud
      geo.translate(0, 0, out > 0 ? -tireW / 2 + 0.05 : -tireW / 2 - 0.55);
      return geo;
    };
    const rimGeoR = mkRimGeo(1);   // right wheel: outboard = +z
    const rimGeoL = mkRimGeo(-1);  // left wheel: outboard = −z
    const rimWhiteMat = this._plastic(LEGO.white, 0.35); // never metallic (v1.6b)
    const rimBoreMat = this._plastic('#d6dae1', 0.45);
    const rimMats = [rimWhiteMat, rimBoreMat]; // extrude: [faces, side walls]
    const hubFaceTex = new THREE.CanvasTexture(makeDiscFaceCanvas(LEGO.white, '#c9ced8', false));
    hubFaceTex.colorSpace = THREE.SRGBColorSpace;
    const hubCapR = capR * 0.34;
    const hubCapGeo = new THREE.CylinderGeometry(hubCapR, hubCapR, rimDepth + 0.2, 14);
    hubCapGeo.rotateX(Math.PI / 2);
    const hubCapFace = new THREE.MeshStandardMaterial({ map: hubFaceTex, roughness: 0.4 });
    const hubCapMats = [rimWhiteMat, hubCapFace, hubCapFace];
    const mkWheel = (z) => {
      const out = z >= 0 ? 1 : -1;
      const g = new THREE.Group();
      g.add(new THREE.Mesh(tireGeo, tireMats));
      g.add(new THREE.Mesh(out > 0 ? rimGeoR : rimGeoL, rimMats));
      const cap = new THREE.Mesh(hubCapGeo, hubCapMats);
      cap.position.z = out * 0.3; // matches the rim's outboard bias
      g.add(cap);
      g.position.set(0, wheelR, z);
      this._robot.add(g);
      return g;
    };
    this._wheelL = mkWheel(-wheelZ); // robot left = -z (body +y is RIGHT)
    this._wheelR = mkWheel(wheelZ);
    this._drive = { leftPort: drive.leftPort || 'A', rightPort: drive.rightPort || 'B' };

    // --- drive motors (ART.md v1.6/v1.6b): white ANGULAR-MOTOR bodies lying
    // flat INBOARD of the frame's side beams. Part of the chassis visuals
    // (`body`) so a custom model replaces them too (the swap also drops the
    // disc handles); the wheels keep spinning from engine state either way.
    if (wheelInnerZ - W / 2 > 0.4) {
      // Bodies 3.2×2.4×1.6 lie FLAT at axle height, tucked between the hub
      // side (±2.8) and the frame beam's inner face; a dark Ø 0.5 axle
      // crosses the beam→wheel gap to the Ø 1.8 azure dial just inside each
      // wheel. The dials are the outputs the wheels mount on, so _tick spins
      // them with the wheel angles. Azure building-interface cap on top,
      // black pin-hole rows on the ±x flanks (v1.6 identity).
      const motorGeo = new RoundedBoxGeometry(3.2, 2.4, 1.6, 2, 0.1);
      const motorFlankTex = new THREE.CanvasTexture(makeMotorFlankCanvas());
      motorFlankTex.colorSpace = THREE.SRGBColorSpace;
      const motorWhiteMat = this._plastic(LEGO.white, 0.4);
      const motorFlankMat = new THREE.MeshPhysicalMaterial({
        map: motorFlankTex, roughness: 0.4, clearcoat: 0.15, metalness: 0,
      });
      const motorMats = [
        motorFlankMat, motorFlankMat,
        motorWhiteMat, motorWhiteMat, motorWhiteMat, motorWhiteMat,
      ];
      const discTex = new THREE.CanvasTexture(makeDiscFaceCanvas(LEGO.azure, '#2f89a8', true));
      discTex.colorSpace = THREE.SRGBColorSpace;
      const discR = Math.min(0.9, wheelR * 0.45); // Ø 1.8 output disc (v1.6b)
      const discZ = (W / 2 + wheelInnerZ) / 2;    // in the beam→wheel gap
      const discGeo = new THREE.CylinderGeometry(discR, discR, 0.3, 20);
      discGeo.rotateX(Math.PI / 2); // disc faces ±z, toward the wheel
      const discFaceMat = new THREE.MeshPhysicalMaterial({
        map: discTex, roughness: 0.35, clearcoat: 0.15, metalness: 0,
      });
      const azurePlainMat = this._plastic(LEGO.azure, 0.3);
      const discMats = [azurePlainMat, discFaceMat, discFaceMat];
      const axleLen = Math.max(0.3, wheelInnerZ - (motorZc + 0.8) + 0.2);
      const axleGeo = new THREE.CylinderGeometry(0.25, 0.25, axleLen, 10);
      axleGeo.rotateX(Math.PI / 2);
      const axleMat = this._plastic('#1B1E24', 0.5);
      const topCapGeo = new RoundedBoxGeometry(1.6, 0.2, 1.6, 2, 0.06);
      this._motorDiscs = {};
      for (const side of [-1, 1]) {
        const mb = new THREE.Mesh(motorGeo, motorMats);
        mb.position.set(0.8, wheelR, side * motorZc); // flat, at axle height
        body.add(mb);
        const axle = new THREE.Mesh(axleGeo, axleMat); // over the frame beam
        axle.position.set(0, wheelR, side * (motorZc + 0.7 + axleLen / 2));
        body.add(axle);
        const disc = new THREE.Mesh(discGeo, discMats); // the rotating output
        disc.position.set(0, wheelR, side * discZ);
        body.add(disc);
        this._motorDiscs[side < 0 ? 'left' : 'right'] = disc;
        const topCap = new THREE.Mesh(topCapGeo, azurePlainMat); // azure cap
        topCap.position.set(0.8, wheelR + 1.3, side * motorZc);
        body.add(topCap);
      }
    }

    // --- rear caster (v1.6): STEEL-GREY ball in a WHITE socket cup hung
    // under the rear deck plate. Ball bottom touches the mat (y = 0); the
    // cup tapers down from the plate, clear of the rear frame beam.
    const casterX = -L / 2 + 2.0;
    const cupTop = deckY - 0.2;
    const cupH = THREE.MathUtils.clamp(cupTop - 0.85, 0.4, 1.4);
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(1.05, 0.9, cupH, 18),
      this._plastic(LEGO.white, 0.4)
    );
    cup.position.set(casterX, cupTop - cupH / 2, 0);
    const caster = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 16, 12),
      this._plastic('#8b919c', 0.35) // steel-grey, but plastic-gloss (no metal)
    );
    caster.position.set(casterX, 0.9, 0);
    this._robot.add(cup, caster);

    // --- devices at their body-frame offsets: (x fwd, y right) → local (x, ·, z)
    // v1.6b anti-overlap VISUAL guard first: footprints (relative AABBs
    // matching the meshes built below) are resolved against the structural
    // blockers — hub, wheel/drive-motor assemblies, caster cup. The frame
    // beams are the mounting surface (parts sit ON them), not blockers.
    // Engine sensor positions are untouched; only rendered offsets move.
    const blockers = [
      {
        x0: hubX - hubL / 2, x1: hubX + hubL / 2,
        y0: hubBase, y1: hubTop,
        z0: -hubW / 2, z1: hubW / 2,
      },
      {
        x0: casterX - 1.1, x1: casterX + 1.1,
        y0: 0, y1: deckY,
        z0: -1.1, z1: 1.1,
      },
    ];
    const wbX = Math.max(wheelR, 2.4);              // wheel radius vs motor front
    const wbY = Math.max(2 * wheelR, wheelR + 1.2); // wheel top vs motor top
    for (const side of [-1, 1]) {
      const zA = side * (motorZc - 0.8); // motor-body inner face
      const zB = side * (wheelZ + tireW / 2); // tire outer face
      blockers.push({
        x0: -wbX, x1: wbX, y0: 0, y1: wbY,
        z0: Math.min(zA, zB), z1: Math.max(zA, zB),
      });
    }
    // Heading-rotated AABB (same rotation the sensor mesh gets).
    const rotXZ = (b, headingDeg) => {
      if (!headingDeg) return b;
      const a = -THREE.MathUtils.degToRad(headingDeg);
      const c = Math.cos(a);
      const s = Math.sin(a);
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const [px, pz] of [[b.x0, b.z0], [b.x0, b.z1], [b.x1, b.z0], [b.x1, b.z1]]) {
        const rx = px * c + pz * s;
        const rz = -px * s + pz * c;
        x0 = Math.min(x0, rx);
        x1 = Math.max(x1, rx);
        z0 = Math.min(z0, rz);
        z1 = Math.max(z1, rz);
      }
      return { x0, x1, y0: b.y0, y1: b.y1, z0, z1 };
    };
    const guarded = [];
    for (const dev of cfg.devices || []) {
      const isArm = dev.type === 'motor' && dev.role === 'attachment' &&
        dev.attachment && dev.attachment.kind === 'arm';
      if (dev.type !== 'distance' && dev.type !== 'color' && dev.type !== 'force' && !isArm) {
        continue; // drive motors render with the wheels; unknown types skip
      }
      const p = isArm ? dev.attachment : dev;
      const cx = p.x ?? 0;
      const cz = p.y ?? 0;
      let boxes;
      if (dev.type === 'distance') {
        boxes = [rotXZ(
          { x0: -1.2, x1: 1.5, y0: deckY, y1: deckY + 2.4, z0: -2.8, z1: 2.8 },
          dev.headingDeg ?? 0
        )];
      } else if (dev.type === 'color') {
        boxes = [{ x0: -0.8, x1: 0.8, y0: deckY, y1: deckY + 2.0, z0: -0.8, z1: 0.8 }];
      } else if (dev.type === 'force') {
        boxes = [rotXZ(
          { x0: -1.2, x1: 2.0, y0: deckY, y1: deckY + 1.6, z0: -0.8, z1: 0.8 },
          dev.headingDeg ?? 0
        )];
      } else {
        // arm assembly = three tight boxes: motor body, inboard dial, beam —
        // an AABB over the whole thing would block half the deck for nothing
        const bs = cz > 0.01 ? 1 : cz < -0.01 ? -1 : ('ACE'.includes(dev.port) ? -1 : 1);
        const len = p.lengthCm ?? 8;
        boxes = [
          { x0: -1.2, x1: 2.8, y0: deckY, y1: deckY + 2.4, z0: -1.2, z1: 1.2 },
          {
            x0: -0.9, x1: 0.9, y0: deckY + 0.3, y1: deckY + 2.1,
            z0: Math.min(-bs * 1.5, -bs * 1.2), z1: Math.max(-bs * 1.5, -bs * 1.2),
          },
          {
            x0: -0.4, x1: Math.max(0.4, len - 0.4), y0: deckY + 0.7, y1: deckY + 1.7,
            z0: bs * 2.05 - 0.55, z1: bs * 2.05 + 0.55,
          },
        ];
      }
      guarded.push({ port: String(dev.port || '?'), cx, cz, boxes, dev });
    }
    const offsets = resolveDeviceOffsets(guarded, blockers);

    for (const g of guarded) {
      const dev = g.dev;
      const vz = g.cz + (offsets.get(g.port) || 0); // guarded lateral position
      if (dev.type === 'distance') {
        this._robot.add(this._makeDistanceSensor(g.cx, vz, dev.headingDeg ?? 0, deckY));
      } else if (dev.type === 'color') {
        this._addColorSensor(dev.port, g.cx, vz, deckY);
      } else if (dev.type === 'force') {
        this._robot.add(this._makeForceSensor(g.cx, vz, dev.headingDeg ?? 0, deckY));
      } else {
        this._addArm(dev.port, dev.attachment, g.cx, vz, {
          deckY,
          hubMaxX: hubX + hubL / 2,
          hubHalfW: hubW / 2,
          hubTop,
        });
      }
    }

    // Builder3D (AGENT-BRICKS): decorative bricks ride the chassis deck.
    // They join the chassis visuals (`body`) so a custom model replaces them
    // together with the chassis/hub in the swap block right below.
    if (Array.isArray(cfg.bricks) && cfg.bricks.length) {
      this._addBricks(body, cfg.bricks, deckY); // seated on the rear half-deck
    }

    // v1.1 (AGENT-MODEL): optional custom 3D model. Loads async; on success
    // it replaces ONLY the chassis visuals (the `body` group: chassis, hub +
    // deck/port textures + light-matrix screen, drive-motor bodies) — wheels,
    // sensors and arm remain procedural so they keep animating from state.
    if (cfg.model && cfg.model.file) {
      const token = this._modelToken;
      loadRobotModel(cfg.model).then((group) => {
        // Async-race guard: if the robot was rebuilt while the file was
        // loading, `token` is stale — drop this result (loadRobotModel keeps
        // its own cache, so nothing is wasted). null = load failed and
        // model-loader.js already logged a friendly message; keep the body.
        if (!group || token !== this._modelToken) return;
        this._robot.remove(body);
        disposeTree(body); // chassis, hub (+deck/port textures), motors, matrix texture
        this._matrixCtx = null; // stop per-frame matrix updates (texture gone)
        this._matrixTex = null;
        this._matrixKey = null;
        this._motorDiscs = null; // discs lived in `body` — stop spinning them
        this._robot.add(group);
      });
    }
    this._robot.traverse((o) => {
      if (o.isMesh && !o.userData.noShadow) o.castShadow = true;
    });
  }

  /**
   * Distance sensor (45604, v1.6b module discipline): 5.6×2.4×2.4 white
   * brick whose FRONT is the near-black rounded "goggle" face plate
   * (5.6×2.4) spanning both eyes; two large dark eyes with concentric ring
   * detail (speaker-mesh look), each ringed by 4 faint WHITE LED arc
   * segments (two upper, two lower) — per LEGO's tech-spec photos. Crisp
   * 0.08–0.1 chamfers; group origin at deck level under the device center.
   * @returns {THREE.Group}
   */
  _makeDistanceSensor(dx, dz, headingDeg, deckY) {
    const g = new THREE.Group();
    g.position.set(dx, deckY, dz);
    g.rotation.y = -THREE.MathUtils.degToRad(headingDeg); // clockwise-positive
    const body = new THREE.Mesh(
      new RoundedBoxGeometry(2.1, 2.4, 5.6, 2, 0.1),
      this._plastic(LEGO.white, 0.4)
    );
    body.position.set(-0.15, 1.2, 0);
    g.add(body);
    // near-black rounded GOGGLE face plate spanning both eyes (5.6×2.4)
    const plate = new THREE.Mesh(
      new RoundedBoxGeometry(0.3, 2.4, 5.6, 2, 0.08),
      this._plastic('#101318', 0.3)
    );
    plate.position.set(1.05, 1.2, 0);
    g.add(plate);
    const eyeGeo = new THREE.CylinderGeometry(0.8, 0.8, 0.5, 18);
    eyeGeo.rotateZ(Math.PI / 2); // axis along local +x = sensor facing
    const eyeFaceTex = new THREE.CanvasTexture(makeEyeFaceCanvas());
    eyeFaceTex.colorSpace = THREE.SRGBColorSpace;
    const eyeSideMat = this._plastic('#0c0e12', 0.25);
    const eyeFaceMat = new THREE.MeshStandardMaterial({ map: eyeFaceTex, roughness: 0.3 });
    const eyeMats = [eyeSideMat, eyeFaceMat, eyeFaceMat]; // ringed faces
    const arcTex = new THREE.CanvasTexture(makeEyeArcCanvas());
    arcTex.colorSpace = THREE.SRGBColorSpace;
    const arcGeo = new THREE.PlaneGeometry(2.2, 2.2);
    arcGeo.rotateY(Math.PI / 2); // plane normal +z → +x (sensor facing)
    const arcMat = new THREE.MeshBasicMaterial({
      map: arcTex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMats);
      eye.position.set(1.15, 1.2, side * 1.4);
      g.add(eye);
      const arcs = new THREE.Mesh(arcGeo, arcMat); // 4 white LED segments
      arcs.position.set(1.42, 1.2, side * 1.4);
      arcs.userData.noShadow = true;
      g.add(arcs);
    }
    return g;
  }

  /**
   * Color sensor (45605, v1.6b module discipline): 1.6×1.6×2.0 white square
   * module riding the frame top, black round bezel + emissive down-lens
   * showing the LIVE reading (updated every frame in _tick), plus a faint
   * white illumination ring — "glows white when active" (ART.md v1.3).
   * Everything stays AT or ABOVE deck level so the housing can never pierce
   * a frame beam; the lens looks down through the open frame at the mat.
   */
  _addColorSensor(port, dx, dz, deckY) {
    const g = new THREE.Group();
    g.position.set(dx, deckY, dz);
    const housing = new THREE.Mesh(
      new RoundedBoxGeometry(1.6, 1.4, 1.6, 2, 0.1),
      this._plastic(LEGO.white, 0.4)
    );
    housing.position.y = 1.3; // module top at +2.0
    g.add(housing);
    const bezel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.55, 0.5, 16),
      this._plastic('#0c0e12', 0.4)
    );
    bezel.position.y = 0.35; // black round bezel, looking at the mat
    g.add(bezel);
    const discMat = new THREE.MeshStandardMaterial({
      color: '#101010',
      emissive: new THREE.Color(SPIKE_COLOR_HEX.none),
      emissiveIntensity: 1.35,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), discMat);
    disc.rotation.x = Math.PI / 2; // face down (normal -y) toward the mat
    disc.position.y = 0.08;
    g.add(disc);
    const glowGeo = new THREE.RingGeometry(0.5, 0.68, 24);
    glowGeo.rotateX(Math.PI / 2); // normal −y: faint illumination ring
    const glow = new THREE.Mesh(
      glowGeo,
      new THREE.MeshBasicMaterial({
        color: '#fff3dd',
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthWrite: false,
        fog: false,
      })
    );
    glow.position.y = 0.07;
    glow.userData.noShadow = true;
    g.add(glow);
    this._robot.add(g);
    this._colorDiscs[port] = discMat;
  }

  /**
   * Force sensor (45606, v1.6b module discipline): 2.4×1.6×1.6 white oblong
   * body with a Ø 0.8 BLACK round plunger tip on a short black collar,
   * facing its heading. Crisp 0.1 chamfer; origin at deck level.
   * @returns {THREE.Group}
   */
  _makeForceSensor(dx, dz, headingDeg, deckY) {
    const g = new THREE.Group();
    g.position.set(dx, deckY, dz);
    g.rotation.y = -THREE.MathUtils.degToRad(headingDeg);
    const housing = new THREE.Mesh(
      new RoundedBoxGeometry(2.4, 1.6, 1.6, 2, 0.1),
      this._plastic(LEGO.white, 0.4)
    );
    housing.position.y = 0.8;
    g.add(housing);
    const blackMat = this._plastic('#15181e', 0.45);
    const collarGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.3, 16);
    collarGeo.rotateZ(Math.PI / 2); // axis along facing
    const collar = new THREE.Mesh(collarGeo, blackMat);
    collar.position.set(1.35, 0.8, 0); // short black collar at the body face
    g.add(collar);
    const tipGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.5, 16); // Ø 0.8 plunger
    tipGeo.rotateZ(Math.PI / 2);
    const tip = new THREE.Mesh(tipGeo, blackMat);
    tip.position.set(1.75, 0.8, 0);
    g.add(tip);
    return g;
  }

  /**
   * Decorative LEGO bricks (Builder3D, engine-sanitized `config.bricks`):
   * each brick is a RoundedBox (radius 0.12) in its color with a slightly
   * lighter top face and LEGO studs on top — small cylinders on the 0.8 cm
   * stud pitch in the same lighter top tint. Body-frame mapping matches the
   * devices: brick (x fwd, y right, z cm above the deck) → body-local
   * (x, deckTop + z + hCm/2, y), so a z=0 brick rests on the chassis deck
   * and stacked bricks ride on top of each other.
   *
   * Sharing/dispose discipline: geometry is cached per unique size, the
   * side/top materials per color, and ONE stud geometry serves every stud —
   * all attached to `parent` (the chassis-visuals `body` group), so the
   * existing disposeTree on rebuild/model-swap frees everything (dispose()
   * is idempotent on shared resources). A global stud budget keeps a
   * degenerate config (60 max-size plates) from flooding the scene; odd
   * entries are skipped, never thrown on.
   * @param {THREE.Group} parent   chassis-visuals group (`body`)
   * @param {Array<object>} bricks sanitized brick entries from the engine
   * @param {number} deckTop       body-local y of the chassis deck surface (cm)
   */
  _addBricks(parent, bricks, deckTop) {
    const PITCH = 0.8;    // LEGO stud pitch (cm)
    const STUD_R = 0.24;  // stud radius (cm) — 4.8 mm stud diameter
    const STUD_H = 0.18;  // stud height (cm)
    const geoCache = new Map(); // "w|h|l" → RoundedBoxGeometry
    const matCache = new Map(); // color → { top, faces } materials
    const studGeo = new THREE.CylinderGeometry(STUD_R, STUD_R, STUD_H, 12);
    let studBudget = 1500;      // hard cap on stud meshes across all bricks

    for (let i = 0; i < bricks.length && i < 60; i++) {
      const b = bricks[i];
      if (!b || typeof b !== 'object') continue;
      const w = Number(b.wCm);   // along body x (forward)
      const l = Number(b.lCm);   // along body y (right) → local z
      const h = Number(b.hCm);   // up
      const bx = Number(b.x);
      const bz = Number(b.y);
      const lift = Math.max(0, Number(b.z)); // cm above the deck
      if (![w, l, h, bx, bz, lift].every(Number.isFinite)) continue;
      if (w <= 0 || l <= 0 || h <= 0) continue;
      const color = typeof b.color === 'string' ? b.color : '#D01012';

      let mats = matCache.get(color);
      if (!mats) {
        const side = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
        const top = new THREE.MeshStandardMaterial({
          color: new THREE.Color(color).offsetHSL(0, 0, 0.07), // lighter top
          roughness: 0.4,
        });
        // Box material order [+x, −x, +y, −y, +z, −z]: lighter face up.
        mats = { top, faces: [side, side, top, side, side, side] };
        matCache.set(color, mats);
      }
      const gKey = `${w}|${h}|${l}`;
      let geo = geoCache.get(gKey);
      if (!geo) {
        geo = new RoundedBoxGeometry(w, h, l, 2, Math.min(0.12, w / 2, h / 2, l / 2));
        geoCache.set(gKey, geo);
      }
      const mesh = new THREE.Mesh(geo, mats.faces);
      mesh.position.set(bx, deckTop + lift + h / 2, bz);
      parent.add(mesh);

      // Studs: centered grid on the 0.8 cm pitch (2×4 brick → 4×2 studs).
      const nx = Math.max(1, Math.min(15, Math.round(w / PITCH)));
      const nz = Math.max(1, Math.min(15, Math.round(l / PITCH)));
      if (nx * nz > studBudget) continue; // brick stays, studs skipped
      studBudget -= nx * nz;
      const topY = deckTop + lift + h + STUD_H / 2;
      // Skinny bricks (< one stud wide) get proportionally slimmer studs.
      const s = Math.min(1, (Math.min(w, l) / 2 - 0.02) / STUD_R);
      for (let ix = 0; ix < nx; ix++) {
        for (let iz = 0; iz < nz; iz++) {
          const stud = new THREE.Mesh(studGeo, mats.top);
          stud.position.set(
            bx + (ix - (nx - 1) / 2) * PITCH,
            topY,
            bz + (iz - (nz - 1) / 2) * PITCH
          );
          if (s < 1) stud.scale.set(s, 1, s);
          stud.userData.noShadow = true; // tiny — the brick body casts instead
          parent.add(stud);
        }
      }
    }
  }

  /**
   * Arm attachment (v1.5 defect 1, v1.6 angular-motor look): a proper
   * motor+beam ASSEMBLY at the configured mount (attachment.x, attachment.y) —
   *   • a white SPIKE angular-motor body (rounded 3.5×3×3.5 box with
   *     medium-azure output discs, an azure top cap and pin-hole flanks)
   *     fixed to the chassis top — the beam-side disc rides the pivot so
   *     it spins with the arm,
   *   • a dark axle sticking out of the motor's cap along the robot's
   *     LATERAL (local z) axis,
   *   • the yellow Technic beam whose END rides that axle — pivot at the
   *     beam end, not its center — swinging up/forward like a forklift.
   * Positive pivot rotation.z lifts the tip (+x beam) upward, matching
   * "angleDeg 0 = horizontal forward, positive = up" (driven in _tick from
   * state.attachments[port].angleDeg with the same −30…120 visual clamp).
   *
   * Anti-clip rule (deterministic, config-driven): the beam sweeps a
   * vertical plane extending forward from the mount, so if that plane (or
   * the motor's own footprint) overlaps the hub, the WHOLE assembly nudges
   * forward along +x to the first x where the full clamped sweep (including
   * the worst-case 120° back-swing over the hub's front-top corner) clears
   * the hub with margin. Nothing moves when the configured mount is already
   * clear (e.g. an outboard or rear-corner mount).
   * @param {string} port  attachment motor port (also picks the beam's side
   *                       of the motor when the mount sits on the centerline:
   *                       left-bank ports A/C/E → −z, right bank B/D/F → +z)
   * @param {object} att  attachment config { x, y, lengthCm }
   * @param {number} mx0  mount x (body-forward, cm)
   * @param {number} mz   mount lateral position — already GUARD-resolved by
   *                      resolveDeviceOffsets (may differ from att.y)
   * @param {object} lay  layout { deckY, hubMaxX, hubHalfW, hubTop }
   */
  _addArm(port, att, mx0, mz, lay) {
    const len = att.lengthCm ?? 8;
    const my = lay.deckY + 1.2; // motor body center, seated on the deck
    let mx = mx0;
    // Beam hangs beside the motor's output dial, outboard of the mount side;
    // centerline mounts pick the side of the port's physical bank.
    const beamSide = mz > 0.01 ? 1 : mz < -0.01 ? -1 : ('ACE'.includes(port) ? -1 : 1);
    const beamZ = mz + beamSide * 2.05; // just outboard of the 2.4-wide motor

    // --- deterministic forward nudge out of the hub's swing shadow ---------
    // (kept from v1.5; the lateral visual guard usually clears this already)
    let minX = -Infinity;
    if (Math.abs(beamZ) < lay.hubHalfW + 0.9) {
      // Worst case is the 120° back-swing: keep the beam envelope (half
      // width 0.4 + margin) clear of the hub's front-top corner for a beam
      // direction of (cos120°, sin120°) from a pivot at height `my`.
      const rise = Math.max(0, lay.hubTop - my);
      minX = lay.hubMaxX + (0.5 * rise + 0.75) / 0.866;
    }
    if (Math.abs(mz) < lay.hubHalfW + 1.2) {
      minX = Math.max(minX, lay.hubMaxX + 1.5); // motor bulk (x −1.2) clear too
    }
    if (mx < minX) mx = minX;

    const asm = new THREE.Group(); // static part of the assembly

    // motor body: EXACT medium-motor module 4.0×2.4×2.4 (v1.6b), crisp 0.1
    // chamfer, bulk FORWARD of the mount so a hub-side mount clears the hub;
    // black pin-hole rows on the ±x flanks (v1.6 angular-motor look)
    const motorFlankTex = new THREE.CanvasTexture(makeMotorFlankCanvas());
    motorFlankTex.colorSpace = THREE.SRGBColorSpace;
    const motorWhiteMat = this._plastic(LEGO.white, 0.4);
    const motorFlankMat = new THREE.MeshPhysicalMaterial({
      map: motorFlankTex, roughness: 0.4, clearcoat: 0.15, metalness: 0,
    });
    const motor = new THREE.Mesh(
      new RoundedBoxGeometry(4.0, 2.4, 2.4, 2, 0.1),
      [motorFlankMat, motorFlankMat, motorWhiteMat, motorWhiteMat, motorWhiteMat, motorWhiteMat]
    );
    motor.position.set(mx + 0.8, my, mz);
    asm.add(motor);

    // medium-azure Ø 1.8 output discs (crosshole + zero-dot) on the lateral
    // faces; the OFF side is static here — the beam-side disc joins the
    // pivot below so it spins WITH the arm (it is the output the beam mounts
    // on). Azure square building-interface cap on top (v1.6).
    const discTex = new THREE.CanvasTexture(makeDiscFaceCanvas(LEGO.azure, '#2f89a8', true));
    discTex.colorSpace = THREE.SRGBColorSpace;
    const discGeo = new THREE.CylinderGeometry(0.9, 0.9, 0.3, 20);
    discGeo.rotateX(Math.PI / 2); // disc faces ±z
    const discFaceMat = new THREE.MeshPhysicalMaterial({
      map: discTex, roughness: 0.35, clearcoat: 0.15, metalness: 0,
    });
    const azureMat = this._plastic(LEGO.azure, 0.3);
    const discMats = [azureMat, discFaceMat, discFaceMat];
    const offDisc = new THREE.Mesh(discGeo, discMats);
    offDisc.position.set(mx, my, mz - beamSide * 1.35);
    asm.add(offDisc);
    const topCap = new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.2, 1.6, 2, 0.06), azureMat);
    topCap.position.set(mx + 0.8, my + 1.3, mz);
    asm.add(topCap);

    // dark axle from the motor's beam-side face out through the beam hinge
    const faceZ = mz + beamSide * 1.2;
    const tipZ = beamZ + beamSide * 0.7; // pokes just past the hinge boss
    const axGeo = new THREE.CylinderGeometry(0.3, 0.3, Math.abs(tipZ - faceZ), 10);
    axGeo.rotateX(Math.PI / 2); // along the lateral axis
    const axle = new THREE.Mesh(axGeo, this._plastic('#2b2f36', 0.5));
    axle.position.set(mx, my, (faceZ + tipZ) / 2);
    asm.add(axle);

    // pivot at the axle: the beam's END hole is here, the beam extends
    // forward. v1.6b beam: 0.8 cm-square Bright-Yellow Technic beam with a
    // crisp 0.08 chamfer and REAL Ø 0.48 through-holes at the exact 0.8 cm
    // module pitch (they ride the pivot, so they swing with the arm).
    const pivot = new THREE.Group();
    pivot.position.set(mx, my, beamZ);
    // beam-side output disc rides the PIVOT → its zero-dot spins with the arm
    const outDisc = new THREE.Mesh(discGeo, discMats);
    outDisc.position.z = faceZ + beamSide * 0.15 - beamZ;
    pivot.add(outDisc);
    const beam = new THREE.Mesh(
      new RoundedBoxGeometry(len, 0.8, 0.8, 2, 0.08),
      this._plastic(LEGO.yellow, 0.35)
    );
    beam.position.x = len / 2 - 0.4; // END hole sits on the axle
    pivot.add(beam);
    const holeGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.96, 10);
    holeGeo.rotateX(Math.PI / 2); // pierce the beam laterally
    const holeMat = this._plastic(LEGO.holeInner, 0.55);
    const nH = Math.min(12, Math.max(2, Math.floor(len / 0.8)));
    for (let i = 0; i < nH; i++) {
      const hole = new THREE.Mesh(holeGeo, holeMat);
      hole.position.x = i * 0.8;
      pivot.add(hole);
    }
    const hingeGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.0, 14);
    hingeGeo.rotateX(Math.PI / 2); // hinge boss along the lateral axis
    pivot.add(new THREE.Mesh(hingeGeo, this._plastic('#c9c9c9', 0.4)));
    asm.add(pivot);

    this._robot.add(asm);
    this._arms[port] = pivot; // _tick drives pivot.rotation.z, same as before
  }

  /**
   * Repaint the hub's 5×5 light-matrix canvas: dark rounded panel with either
   * a glyph in WARM-WHITE pixels (the real hub's 25 white LEDs, ART.md v1.3)
   * or (idle) a dim grid of dots.
   * @param {string} char  the single character to show ('' when idle)
   * @param {boolean} idle  true → empty display → dim idle dots
   */
  _paintMatrix(char, idle) {
    const ctx = this._matrixCtx;
    if (!ctx) return;
    ctx.fillStyle = '#f4f6f8'; // hub-white margin around the panel
    ctx.fillRect(0, 0, 64, 64);
    rrPath(ctx, 2, 2, 60, 60, 9);
    ctx.fillStyle = '#12151b';
    ctx.fill();
    ctx.strokeStyle = '#262b35';
    ctx.lineWidth = 1.5;
    rrPath(ctx, 3.2, 3.2, 57.6, 57.6, 8);
    ctx.stroke();

    const glyph = idle ? null
      : (FONT3X5[char] !== undefined ? FONT3X5[char] : GLYPH_UNKNOWN);
    const cell = 52 / 5; // 5×5 grid inside the panel (origin 6,6)
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const x = 6 + c * cell;
        const y = 6 + r * cell;
        // glyphs are 3 wide, centered in columns 1–3
        const lit = glyph && c >= 1 && c <= 3 && (glyph[r] & (0b100 >> (c - 1)));
        if (lit) {
          ctx.save();
          ctx.shadowColor = 'rgba(255,233,190,0.85)';
          ctx.shadowBlur = 3;
          ctx.fillStyle = '#ffeecb'; // warm-white LED pixel
          rrPath(ctx, x + 1.3, y + 1.3, cell - 2.6, cell - 2.6, 2.5);
          ctx.fill();
          ctx.restore();
        } else if (idle) {
          ctx.fillStyle = '#2a303c'; // dim idle dot
          ctx.beginPath();
          ctx.arc(x + cell / 2, y + cell / 2, 1.7, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#1c202a'; // unlit matrix pixel
          rrPath(ctx, x + 1.3, y + 1.3, cell - 2.6, cell - 2.6, 2.5);
          ctx.fill();
        }
      }
    }
  }

  /**
   * Per-frame light-matrix sync: shows engine.getState().display one char at
   * a time, marquee-stepping every 0.35 s of SIM time for multi-char text.
   * Repaints the 64×64 canvas only when the shown frame actually changes.
   * @param {object} st  live engine state
   */
  _updateMatrix(st) {
    // Branch on the RAW string length (like view2d.displayMatrixPixels) so a
    // single glyph whose uppercase form changes length — 'ß'→'SS', ligatures —
    // isn't misread as multi-char marquee. Uppercase only the chosen glyph for
    // the FONT3X5 lookup, so both views show identical pixels for the same state.
    const raw = st.display == null ? '' : String(st.display);
    let char = '';
    let key = '';
    if (raw.length === 1) {
      char = raw;
      key = raw;
    } else if (raw.length > 1) {
      const step = Math.floor((st.t || 0) / MARQUEE_STEP_S) % raw.length;
      char = raw[step];
      key = raw + '|' + step;
    }
    if (key === this._matrixKey) return; // frame unchanged — no repaint
    this._matrixKey = key;
    this._paintMatrix(char.toUpperCase(), raw.length === 0);
    this._matrixTex.needsUpdate = true;
  }

  /** Follow-cam: glide to 35cm behind + 25cm above the robot, look at it. */
  _followStep(pose) {
    const h = THREE.MathUtils.degToRad(pose.headingDeg);
    // forward in 3D is (cos h, 0, sin h) → "behind" is minus that
    this._followPos.set(
      pose.x - Math.cos(h) * FOLLOW_BACK,
      FOLLOW_UP,
      pose.y - Math.sin(h) * FOLLOW_BACK
    );
    this._camera.position.lerp(this._followPos, FOLLOW_LERP);
    this._lookPos.set(pose.x, 6, pose.y);
    this._controls.target.lerp(this._lookPos, 0.12);
    this._camera.lookAt(this._controls.target);
  }

  /** One frame: sync robot visuals to engine state, update camera, render. */
  _tick() {
    let st = null;
    try { st = this._engine.getState(); } catch { st = null; }

    if (st && st.pose && this._robot) {
      const pose = st.pose;
      this._robot.position.set(pose.x, 0, pose.y);
      this._robot.rotation.y = -THREE.MathUtils.degToRad(pose.headingDeg);

      // wheel spin: rolling forward = negative rotation about the +z axle
      if (this._drive) {
        const ml = st.motors && st.motors[this._drive.leftPort];
        const mr = st.motors && st.motors[this._drive.rightPort];
        if (this._wheelL && ml) this._wheelL.rotation.z = -THREE.MathUtils.degToRad(ml.posDeg);
        if (this._wheelR && mr) this._wheelR.rotation.z = -THREE.MathUtils.degToRad(mr.posDeg);
        // v1.6: the azure motor discs ARE the outputs the wheels mount on —
        // spin them from the same source (handles dropped after a model swap)
        if (this._motorDiscs) {
          if (ml && this._motorDiscs.left) {
            this._motorDiscs.left.rotation.z = -THREE.MathUtils.degToRad(ml.posDeg);
          }
          if (mr && this._motorDiscs.right) {
            this._motorDiscs.right.rotation.z = -THREE.MathUtils.degToRad(mr.posDeg);
          }
        }
      }

      // arm angle from state.attachments — use the raw motor angle so the 3D
      // beam matches the 2D view exactly and a continuously-running attachment
      // motor keeps spinning instead of freezing at a clamp.
      for (const port of Object.keys(this._arms)) {
        const a = st.attachments && st.attachments[port];
        if (a) {
          const deg = a.angleDeg || 0;
          this._arms[port].rotation.z = THREE.MathUtils.degToRad(deg);
        }
      }

      // color-sensor discs glow with the currently read color
      for (const port of Object.keys(this._colorDiscs)) {
        const s = st.sensors && st.sensors[port];
        const hex = SPIKE_COLOR_HEX[s && s.color] || SPIKE_COLOR_HEX.none;
        this._colorDiscs[port].emissive.set(hex);
      }
    }

    // hub light matrix (skipped after a custom model replaces the hub)
    if (st && this._matrixTex) this._updateMatrix(st);

    // Movable crates + their blob shadows follow live engine positions (v1.1).
    if (st && Array.isArray(st.movables) && this._movableMeshes.length) {
      const n = Math.min(st.movables.length, this._movableMeshes.length);
      for (let i = 0; i < n; i++) {
        const m = st.movables[i];
        this._movableMeshes[i].position.set(m.x + m.w / 2, (m.heightCm ?? 8) / 2, m.y + m.h / 2);
        const blob = this._movableShadows[i];
        if (blob) blob.position.set(m.x + m.w / 2, 0.045, m.y + m.h / 2);
      }
    }

    if (this._follow && st && st.pose) {
      this._followStep(st.pose);
    } else {
      this._controls.update(); // damping needs per-frame updates
    }

    // Even with no map loaded we still render (empty stage + robot).
    this._renderer.render(this._scene, this._camera);
  }
}
