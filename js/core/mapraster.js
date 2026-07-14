/**
 * Map raster: renders a map JSON to an offscreen canvas.
 * The raster is BOTH the color-sensor ground truth and the 2D/3D base texture,
 * so it stays clean: no labels, no grid, no robot (see docs/CONTRACT.md).
 */

/** Raster resolution in pixels per centimeter. */
export const RASTER_SCALE = 4;

/** Coerce to a finite number, else fall back. */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Render a map JSON to a canvas (creates one if omitted).
 * Painting order: background → zones → lines → obstacle footprints → wall
 * strokes (→ border frame when map.border). Zone labels are NOT drawn here.
 * @param {object} mapJson map per the contract schema
 * @param {HTMLCanvasElement} [canvas] canvas to reuse (resized to fit)
 * @returns {HTMLCanvasElement} the rendered canvas (RASTER_SCALE px per cm)
 */
export function rasterizeMap(mapJson, canvas) {
  const map = mapJson && typeof mapJson === 'object' ? mapJson : {};
  const widthCm = Math.max(1, num(map.widthCm, 160));
  const heightCm = Math.max(1, num(map.heightCm, 100));

  const cnv = canvas || document.createElement('canvas');
  cnv.width = Math.round(widthCm * RASTER_SCALE);
  cnv.height = Math.round(heightCm * RASTER_SCALE);
  // willReadFrequently: the engine reads the whole raster back once per load
  // to cache ImageData for the color sensor.
  const ctx = cnv.getContext('2d', { willReadFrequently: true });

  // 1. Background.
  ctx.fillStyle = typeof map.background === 'string' ? map.background : '#e9e5da';
  ctx.fillRect(0, 0, cnv.width, cnv.height);

  // Work in cm from here on.
  ctx.save();
  ctx.scale(RASTER_SCALE, RASTER_SCALE);

  // 2. Zones (flat paint — the color sensor sees these).
  for (const z of Array.isArray(map.zones) ? map.zones : []) {
    if (!z) continue;
    ctx.fillStyle = typeof z.color === 'string' ? z.color : '#d94040';
    ctx.fillRect(num(z.x, 0), num(z.y, 0), num(z.w, 0), num(z.h, 0));
  }

  // 3. Lines (flat paint).
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const ln of Array.isArray(map.lines) ? map.lines : []) {
    const pts = ln && Array.isArray(ln.points) ? ln.points : [];
    if (pts.length < 2) continue;
    ctx.strokeStyle = typeof ln.color === 'string' ? ln.color : '#111111';
    ctx.lineWidth = Math.max(0.2, num(ln.widthCm, 2.5));
    ctx.beginPath();
    ctx.moveTo(num(pts[0][0], 0), num(pts[0][1], 0));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(num(pts[i][0], 0), num(pts[i][1], 0));
    ctx.stroke();
  }

  // 4. Obstacle footprints (flat fill; heightCm only matters in 3D/physics).
  // v1.1: movable obstacles are NOT part of the static ground truth — the
  // engine tracks them live and the views draw them — so skip them here.
  for (const o of Array.isArray(map.obstacles) ? map.obstacles : []) {
    if (!o || o.movable) continue;
    ctx.fillStyle = typeof o.color === 'string' ? o.color : '#3b6fd4';
    ctx.fillRect(num(o.x, 0), num(o.y, 0), num(o.w, 0), num(o.h, 0));
  }

  // 5. Walls: 4-raster-px (= 1 cm) dark strokes.
  const wallWidthCm = 4 / RASTER_SCALE;
  ctx.strokeStyle = '#2a2a2e';
  ctx.lineWidth = wallWidthCm;
  ctx.lineCap = 'round';
  for (const w of Array.isArray(map.walls) ? map.walls : []) {
    if (!w) continue;
    ctx.beginPath();
    ctx.moveTo(num(w.x1, 0), num(w.y1, 0));
    ctx.lineTo(num(w.x2, 0), num(w.y2, 0));
    ctx.stroke();
  }

  // Border frame (solid table edge) drawn fully inside the mat.
  if (map.border) {
    ctx.strokeRect(
      wallWidthCm / 2, wallWidthCm / 2,
      widthCm - wallWidthCm, heightCm - wallWidthCm
    );
  }

  ctx.restore();
  return cnv;
}
