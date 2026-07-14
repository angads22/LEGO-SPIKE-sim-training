/**
 * Arena3D — three.js chase-cam renderer for the SpikeSim v2 physics sandbox.
 *
 * This is a NEW, self-contained view (it does NOT import or touch the old
 * js/view/view3d.js). It reads the physics world's arena + vehicle snapshots and
 * draws a lit, low-poly 3D scene: gradient sky, fog, asphalt ground, a road
 * ribbon for slot tracks, wall boxes, and procedurally-built vehicle models
 * (race car / slot car / robot). A chase camera follows the active vehicle.
 *
 * COORDINATE MAPPING (physics -> 3D), per docs/SANDBOX.md:
 *   Physics is planck (x, y), y-UP in-plane, angle CCW-positive about +z.
 *   3D world is y-UP (height). We map:
 *       physics (x, y)  ->  3D (x, 0, -y)          [world y becomes 3D -z]
 *       body angle θ    ->  mesh.rotation.y = θ    [CCW about +Y]
 *   A body's local +x (forward) at angle θ points to world (cosθ, sinθ), which
 *   maps to 3D (cosθ, 0, -sinθ) — exactly the local +x of a mesh rotated by θ
 *   about +Y. So every model is built with its local +X axis pointing "forward".
 *
 * Physics is never mutated here; this view only reads getState()/arena data.
 * Renders via setAnimationLoop only while the 3D tab is active. WebGL init is
 * lazy and guarded (`_failed`) so a machine without WebGL degrades gracefully
 * instead of throwing in the frame loop.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
// Shared SPIKE hub light-matrix logic — the SAME function the 2D view uses, so
// both views light identical LEDs for the same getState().display (ART.md v1.3).
import { matrixState } from './arena2d.js';

/** Deterministic PRNG (mulberry32) — no Math.random in build paths. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Safe number. */
function num(v, d) { return Number.isFinite(v) ? v : d; }

/** Parse a spec color to a THREE.Color, tolerant of bad input. */
function toColor(c, fallback) {
  try {
    if (c === undefined || c === null || c === '') return new THREE.Color(fallback);
    return new THREE.Color(c);
  } catch (_e) {
    return new THREE.Color(fallback);
  }
}

/**
 * 3D arena/vehicle renderer. Reads a PhysicsWorld; draws the active vehicle.
 */
export class Arena3D {
  /**
   * @param {HTMLElement} hostEl element to mount the canvas into (sized by CSS)
   * @param {import('../core/world.js').PhysicsWorld} world the physics world
   */
  constructor(hostEl, world) {
    /** @type {HTMLElement} */
    this.host = hostEl;
    /** @type {import('../core/world.js').PhysicsWorld} */
    this.world = world;

    this._inited = false;
    this._failed = false;
    this._active = false;      // is the 3D tab currently showing?
    this._follow = true;       // chase cam on by default

    // three.js objects (created lazily in _ensureInit).
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this._ro = null;           // ResizeObserver

    // Scene groups.
    this._staticGroup = null;  // ground + walls + road (rebuilt on arena change)
    this._vehGroup = null;     // container for the active vehicle visual

    // Build-state tracking (so we rebuild only when things actually change).
    this._builtArena = null;
    this._builtVehicle = null;
    this._activeVehicle = null; // explicit override via setActiveVehicle()
    this._veh = null;           // { body, wheels:[{group,tire,y}], type }

    // Shared textures (created once; disposed in destroy()).
    this._asphaltTex = null;
    this._checkerTex = null;    // start/finish checker (created once, cloned per arena)

    // Skid-trail decals (a single pooled InstancedMesh; see _updateSkidDecals).
    this._skidMesh = null;
    this._skidCap = 600;
    this._skidMat4 = null;
    this._skidPos = null;
    this._skidScale = null;
    this._skidQuat = null;
    this._skidColorA = null;    // fresh rubber (dark)
    this._skidColorB = null;    // aged rubber (ground-toned)
    this._skidColor = null;     // scratch

    // Camera smoothing.
    this._camSnap = true;
    this._lookAt = new THREE.Vector3(0, 0, 0);

    // Bound animation-loop callback.
    this._renderLoop = () => { this.render(); };

    // Scratch vectors (avoid per-frame allocation in the hot path).
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._colorScratch = new THREE.Color(); // reused for live colour-lens tint
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Create the renderer/scene/camera the first time we actually need them. */
  _ensureInit() {
    if (this._inited || this._failed) return;
    try {
      const w = Math.max(1, this.host.clientWidth || 1);
      const h = Math.max(1, this.host.clientHeight || 1);

      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      renderer.shadowMap.enabled = true;
      // VSM gives genuinely soft (blurred) shadow edges. In this three build
      // PCFSoftShadowMap is deprecated (it silently falls back to hard PCF), so
      // VSM is the current path to the soft shadows the sandbox calls for.
      renderer.shadowMap.type = THREE.VSMShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      this.host.appendChild(renderer.domElement);
      this.renderer = renderer;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xcde0ee);
      scene.fog = new THREE.Fog(0xcde0ee, 40, 160);
      this.scene = scene;

      const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 2000);
      camera.position.set(-18, 14, 20);
      camera.lookAt(0, 0, 0);
      this.camera = camera;

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI * 0.49; // stay above the ground
      controls.minDistance = 0.6;
      controls.maxDistance = 220;
      controls.enabled = !this._follow;
      this.controls = controls;

      this._buildSky();
      this._buildLights();

      this._staticGroup = new THREE.Group();
      scene.add(this._staticGroup);
      this._vehGroup = new THREE.Group();
      scene.add(this._vehGroup);

      this._buildSkidDecals();

      // Keep the canvas sized to its host.
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.host);
      }

      this._inited = true;
    } catch (err) {
      this._failed = true;
      this._showFallback();
      // Never rethrow — the app must keep running (2D view still works).
      try { console.warn('[Arena3D] WebGL init failed; 3D view disabled.', err); } catch (_e) { /* noop */ }
    }
  }

  /** Show a friendly message when WebGL is unavailable. */
  _showFallback() {
    try {
      const div = document.createElement('div');
      div.textContent = '3D view unavailable (WebGL not supported on this device).';
      div.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'padding:24px;text-align:center;color:#cdd6e0;font:600 15px system-ui,sans-serif;' +
        'background:#1a1d24;';
      this.host.appendChild(div);
    } catch (_e) { /* noop */ }
  }

  /** Start rendering (3D tab shown). Idempotent. */
  activate() {
    if (this._failed) return;
    this._ensureInit();
    if (this._failed) return;
    this._active = true;
    this._camSnap = true;               // snap chase cam on (re)entry
    this.resize();
    this.renderer.setAnimationLoop(this._renderLoop);
  }

  /** Stop rendering (3D tab hidden). Idempotent. */
  deactivate() {
    this._active = false;
    if (this.renderer) {
      try { this.renderer.setAnimationLoop(null); } catch (_e) { /* noop */ }
    }
  }

  /** Enable/disable the chase camera. When off, free orbit is allowed. */
  setFollow(on) {
    this._follow = !!on;
    if (this.controls) {
      this.controls.enabled = !this._follow;
      if (!this._follow) {
        // Hand control back to the user around the current vehicle.
        const p = this._currentVehiclePos(this._v0);
        if (p) this.controls.target.copy(p);
      } else {
        this._camSnap = true; // re-snap the chase cam
      }
    }
  }

  /**
   * Explicitly set which vehicle the camera follows / the view rebuilds for.
   * If not called, the view follows the most-recently-added world vehicle.
   * @param {import('../vehicles/vehicle.js').Vehicle|null} vehicle
   */
  setActiveVehicle(vehicle) {
    this._activeVehicle = vehicle || null;
  }

  /** Resize the renderer + camera to the host element. */
  resize() {
    if (!this._inited || this._failed) return;
    const w = Math.max(1, this.host.clientWidth || 1);
    const h = Math.max(1, this.host.clientHeight || 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Reframe the camera. In follow mode this re-snaps the chase cam to the
   * vehicle; in free mode it pulls back to an overview of the whole arena.
   */
  fitArena() {
    if (!this._inited || this._failed) return;
    if (this._follow) { this._camSnap = true; return; }
    const arena = this.world.arena;
    const w = arena ? num(arena.widthM, 40) : 40;
    const h = arena ? num(arena.heightM, 24) : 24;
    const diag = Math.hypot(w, h);
    this.camera.position.set(-w * 0.32, diag * 0.72 + 4, h * 0.78 + 4);
    this._lookAt.set(0, 0, 0);
    this.camera.lookAt(0, 0, 0);
    if (this.controls) { this.controls.target.set(0, 0, 0); this.controls.update(); }
  }

  // ---------------------------------------------------------------------------
  // Per-frame render
  // ---------------------------------------------------------------------------

  /** Render one frame from the current world state. Safe to call anytime. */
  render() {
    if (this._failed) return;
    if (!this._inited) this._ensureInit();
    if (this._failed) return;

    try {
      // Rebuild static scene if the arena changed.
      if (this.world.arena !== this._builtArena) this._rebuildArena();

      // Resolve the active vehicle (explicit override, else newest in world).
      let active = this._activeVehicle;
      if (!active || this.world.vehicles.indexOf(active) === -1) {
        const list = this.world.vehicles;
        active = list.length ? list[list.length - 1] : null;
      }
      if (active !== this._builtVehicle) this._rebuildVehicle(active);

      // Update the vehicle visual from its physics snapshot.
      if (this._builtVehicle && this._veh) {
        let state = null;
        try { state = this._builtVehicle.getState(); } catch (_e) { state = null; }
        if (state) this._updateVehicle(state);
      }

      // Skid trail decals behind the active vehicle.
      this._updateSkidDecals();

      // Camera.
      this._updateCamera();
      if (this.controls && this.controls.enabled) this.controls.update();

      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      // A single bad frame must never kill the loop.
      try { console.warn('[Arena3D] frame error', err); } catch (_e) { /* noop */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Sky + lights
  // ---------------------------------------------------------------------------

  /** Gradient sky dome (unlit, un-fogged, un-tonemapped so it stays crisp). */
  _buildSky() {
    const geo = new THREE.SphereGeometry(600, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x27407a) },
        midColor: { value: new THREE.Color(0x6f9bd0) },
        bottomColor: { value: new THREE.Color(0xd6e6f2) },
        offset: { value: 30.0 },
        exponent: { value: 0.65 },
      },
      vertexShader: [
        'varying vec3 vWorldPosition;',
        'void main() {',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vWorldPosition = wp.xyz;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 topColor;',
        'uniform vec3 midColor;',
        'uniform vec3 bottomColor;',
        'uniform float offset;',
        'uniform float exponent;',
        'varying vec3 vWorldPosition;',
        'void main() {',
        '  float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;',
        '  float t = max(pow(max(h, 0.0), exponent), 0.0);',
        '  vec3 lower = mix(bottomColor, midColor, smoothstep(0.0, 0.35, t));',
        '  vec3 col = mix(lower, topColor, smoothstep(0.25, 1.0, t));',
        '  gl_FragColor = vec4(col, 1.0);',
        '}',
      ].join('\n'),
    });
    this._sky = new THREE.Mesh(geo, mat);
    this._sky.frustumCulled = false;
    this.scene.add(this._sky);
  }

  /** Hemisphere fill + shadow-casting key light + cool rim light. */
  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xbcd4e6, 0x4a4640, 1.15);
    hemi.position.set(0, 60, 0);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff4e2, 2.6);
    key.position.set(24, 40, 18);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 5;        // VSM blur radius (soft edges)
    key.shadow.blurSamples = 16;
    const cam = key.shadow.camera;
    cam.near = 1;
    cam.far = 160;
    cam.left = -30; cam.right = 30; cam.top = 30; cam.bottom = -30;
    cam.updateProjectionMatrix();
    this.scene.add(key);
    this.scene.add(key.target);
    this._keyLight = key;

    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.9);
    rim.position.set(-30, 18, -26);
    this.scene.add(rim);

    // Soft, shadowless front fill so vehicle faces/road markings don't sink into
    // shadow — a gentle materials/lighting lift, not a whole new look.
    const fill = new THREE.DirectionalLight(0xffffff, 0.32);
    fill.position.set(-6, 12, 24);
    this.scene.add(fill);
  }

  /** Fit the shadow frustum + fog to the arena footprint. */
  _fitLightsToArena(w, h) {
    if (!this._keyLight) return;
    const ext = Math.max(w, h) / 2 + 4;
    const cam = this._keyLight.shadow.camera;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.far = ext * 4 + 40;
    cam.updateProjectionMatrix();
    // Place the key light relative to arena size so shadows stay reasonable.
    this._keyLight.position.set(ext * 0.7, ext * 1.4 + 10, ext * 0.5);
    this._keyLight.target.position.set(0, 0, 0);
    this._keyLight.target.updateMatrixWorld();

    if (this.scene.fog) {
      const diag = Math.hypot(w, h);
      this.scene.fog.near = diag * 0.7;
      this.scene.fog.far = diag * 2.6 + 40;
    }
  }

  // ---------------------------------------------------------------------------
  // Static scene (ground, road ribbon, walls)
  // ---------------------------------------------------------------------------

  /** Procedural asphalt color texture (built once, cached, tiled). */
  _asphaltTexture() {
    if (this._asphaltTex) return this._asphaltTex;
    let tex;
    try {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#34373d';
      ctx.fillRect(0, 0, size, size);
      const rnd = mulberry32(1337);
      for (let i = 0; i < 2400; i++) {
        const x = rnd() * size;
        const y = rnd() * size;
        const r = 0.5 + rnd() * 1.6;
        const g = 40 + Math.floor(rnd() * 34);
        const a = 0.12 + rnd() * 0.18;
        ctx.fillStyle = `rgba(${g},${g + 2},${g + 5},${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      if (this.renderer) tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    } catch (_e) {
      tex = null;
    }
    this._asphaltTex = tex;
    return tex;
  }

  /** Tear down and rebuild ground/road/walls for the current arena. */
  _rebuildArena() {
    const arena = this.world.arena;
    this._builtArena = arena;

    // Dispose old static contents.
    this._clearGroup(this._staticGroup);

    const w = arena ? num(arena.widthM, 40) : 40;
    const h = arena ? num(arena.heightM, 24) : 24;

    // Ground plane (a bit larger than the arena so walls sit on tarmac).
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x2f3238,
      roughness: 0.97,
      metalness: 0.0,
    });
    const tex = this._asphaltTexture();
    if (tex) {
      const t = tex.clone();
      t.needsUpdate = true;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(Math.max(2, w / 4), Math.max(2, h / 4));
      groundMat.map = t; // disposed with the material when the arena rebuilds
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w + 12, h + 12), groundMat);
    ground.rotation.x = -Math.PI / 2; // XY plane -> XZ ground
    ground.position.y = 0;
    ground.receiveShadow = true;
    this._staticGroup.add(ground);

    // SPIKE competition mat (robot arena): the flat printed surface the colour
    // sensor reads. Drawn as a textured plane sitting just above the ground so
    // the follow line + colour zones are visible under the robot in 3D too.
    if (arena && arena.mat) this._buildMat(arena.mat, w, h);

    // Road ribbon (only for arenas with a slot polyline).
    if (arena && Array.isArray(arena.slot) && arena.slot.length >= 3) {
      const roadW = (arena.road && num(arena.road.widthM, 3)) || 3;
      this._buildRoad(arena.slot, roadW);
    }

    // Walls.
    if (arena) this._buildWalls(arena, w, h);

    // Race decorations (only present on race tracks).
    if (arena && arena.startFinish) this._buildStartFinish(arena.startFinish);
    if (arena && Array.isArray(arena.checkpoints)) this._buildCheckpoints(arena.checkpoints);

    this._fitLightsToArena(w, h);
  }

  /**
   * Build the SPIKE mat as a textured ground plane. The texture is rendered from
   * the SAME MatDef the colour sensor samples (mat.js sampleMat), in the same
   * priority order (bg -> colour zones -> painted lines on top), so what the
   * robot "sees" is exactly what is drawn. Sits at y=+6mm so it wins the depth
   * test against the asphalt without z-fighting; a faint contact slab underneath
   * fakes the printed table edge (ART.md v1.3).
   * @param {import('../core/mat.js').MatDef} mat
   * @param {number} arenaW arena width fallback (m)
   * @param {number} arenaH arena height fallback (m)
   */
  _buildMat(mat, arenaW, arenaH) {
    try {
      const mw = num(mat.widthM, arenaW);
      const mh = num(mat.heightM, arenaH);
      if (!(mw > 0) || !(mh > 0)) return;

      // Faint darker slab a touch bigger than the mat = printed-table contact AO.
      const slabMat = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.95, metalness: 0.0 });
      const slab = new THREE.Mesh(new THREE.PlaneGeometry(mw + 0.12, mh + 0.12), slabMat);
      slab.rotation.x = -Math.PI / 2;
      slab.position.set(0, 0.004, 0);
      slab.receiveShadow = true;
      this._staticGroup.add(slab);

      // Printed mat surface.
      const surfMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
      const tex = this._matTexture(mat, mw, mh);
      if (tex) surfMat.map = tex; else surfMat.color = toColor(mat.bg, 0xeae6da);
      // PlaneGeometry(mw,mh) is in XY; rotateX(-90) maps (x,y,0)->(x,0,-y), i.e.
      // exactly the physics (x,y)->3D(x,0,-y) mapping. Default UVs then place the
      // canvas so u runs along +x and (flipped) v along physics +y.
      const geo = new THREE.PlaneGeometry(mw, mh);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, surfMat);
      mesh.position.set(0, 0.006, 0);
      mesh.receiveShadow = true;
      this._staticGroup.add(mesh);
    } catch (_e) { /* a missing mat must never break the frame */ }
  }

  /**
   * Render a MatDef to a CanvasTexture. World->canvas: col = (x+mw/2)/mw*W,
   * row = (mh/2 - y)/mh*H (y-up world -> y-down canvas). The scale is uniform
   * (same pixels-per-metre on both axes) so line widths stay round.
   * @param {import('../core/mat.js').MatDef} mat
   * @param {number} mw mat width (m)
   * @param {number} mh mat height (m)
   * @returns {THREE.CanvasTexture|null}
   */
  _matTexture(mat, mw, mh) {
    try {
      const PPM = 256;
      let W = Math.round(mw * PPM);
      let H = Math.round(mh * PPM);
      const maxDim = 1400;
      const sc = Math.min(1, maxDim / Math.max(W, H));
      W = Math.max(2, Math.round(W * sc));
      H = Math.max(2, Math.round(H * sc));
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const sx = W / mw; // px per metre (== H/mh)
      const colOf = (x) => (x + mw / 2) * sx;
      const rowOf = (y) => (mh / 2 - y) * (H / mh);

      // Background.
      ctx.fillStyle = mat.bg || '#eae6da';
      ctx.fillRect(0, 0, W, H);

      // Deterministic paper grain (no Math.random) so the mat reads as printed.
      const rnd = mulberry32(0x5a7ed0);
      ctx.globalAlpha = 0.05;
      for (let i = 0; i < 900; i++) {
        const gx = rnd() * W, gy = rnd() * H, gr = 0.5 + rnd() * 1.2;
        ctx.fillStyle = rnd() < 0.5 ? '#000000' : '#ffffff';
        ctx.beginPath(); ctx.arc(gx, gy, gr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Colour zones (rects) — solid, matching sampleMat's rectangle test.
      if (Array.isArray(mat.zones)) {
        for (const z of mat.zones) {
          if (!z || !Number.isFinite(z.x) || !Number.isFinite(z.y)) continue;
          const zw = num(z.wM, 0.2) * sx;
          const zh = num(z.hM, 0.2) * (H / mh);
          const cx = colOf(z.x), cy = rowOf(z.y);
          ctx.fillStyle = z.color || '#888888';
          ctx.fillRect(cx - zw / 2, cy - zh / 2, zw, zh);
          ctx.lineWidth = Math.max(1, 0.006 * sx);
          ctx.strokeStyle = 'rgba(0,0,0,0.28)';
          ctx.strokeRect(cx - zw / 2, cy - zh / 2, zw, zh);
        }
      }

      // Painted lines on top (round cap/join = same footprint as the sensor's
      // distance-to-segment test with half = widthM/2).
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (Array.isArray(mat.lines)) {
        for (const ln of mat.lines) {
          if (!ln || !Array.isArray(ln.points) || ln.points.length < 2) continue;
          ctx.strokeStyle = ln.color || '#111111';
          ctx.lineWidth = Math.max(1, num(ln.widthM, 0.02) * sx);
          ctx.beginPath();
          let started = false;
          for (const pt of ln.points) {
            if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
            const px = colOf(pt[0]), py = rowOf(pt[1]);
            if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }

      // Subtle inset frame (fakes the mat's printed border / contact shadow).
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = Math.max(2, 0.02 * sx);
      ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, W - 2 * ctx.lineWidth, H - 2 * ctx.lineWidth);

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      if (this.renderer) tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
      return tex;
    } catch (_e) {
      return null;
    }
  }

  /**
   * A 2x2 black/white checker texture (built once, cached). Callers clone it and
   * set repeat to tile it across the start/finish band.
   * @returns {THREE.Texture|null}
   */
  _checkerTexture() {
    if (this._checkerTex) return this._checkerTex;
    let tex = null;
    try {
      const S = 64;
      const canvas = document.createElement('canvas');
      canvas.width = S; canvas.height = S;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#eef0f2';
      ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = '#15161a';
      ctx.fillRect(0, 0, S / 2, S / 2);
      ctx.fillRect(S / 2, S / 2, S / 2, S / 2);
      tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
    } catch (_e) {
      tex = null;
    }
    this._checkerTex = tex;
    return tex;
  }

  /**
   * Checkered start/finish strip laid flat on the ground plus two side posts and
   * a top banner, oriented along the line. arena.startFinish = {x1,y1,x2,y2}.
   * @param {{x1:number,y1:number,x2:number,y2:number}} sf
   */
  _buildStartFinish(sf) {
    if (!sf) return;
    const x1 = num(sf.x1, NaN), y1 = num(sf.y1, NaN);
    const x2 = num(sf.x2, NaN), y2 = num(sf.y2, NaN);
    if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
        !Number.isFinite(x2) || !Number.isFinite(y2)) return;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-3)) return;
    const ang = Math.atan2(dy, dx);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const depth = Math.max(0.5, Math.min(1.6, len * 0.14));

    // Flat checkered band (PlaneGeometry pre-rotated to lie on XZ).
    const geo = new THREE.PlaneGeometry(len, depth);
    geo.rotateX(-Math.PI / 2); // local +X = length, local +Z = depth (travel)
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.0 });
    const tex = this._checkerTexture();
    if (tex) {
      const t = tex.clone();
      t.needsUpdate = true;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      const sq = depth / 2;
      t.repeat.set(Math.max(2, Math.round(len / sq)), 2);
      mat.map = t; // disposed with the material on arena rebuild
    }
    const strip = new THREE.Mesh(geo, mat);
    strip.position.set(mx, 0.03, -my);
    strip.rotation.y = ang;
    strip.receiveShadow = true;
    this._staticGroup.add(strip);

    // Side posts + a banner bar spanning them (reads as a start gate).
    const postH = 1.6;
    const postMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, metalness: 0.1 });
    const bannerMat = new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.55, metalness: 0.1, emissive: 0x2a2202, emissiveIntensity: 0.4 });
    for (const e of [[x1, y1], [x2, y2]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, postH, 10), postMat);
      post.position.set(e[0], postH / 2, -e[1]);
      post.castShadow = true;
      this._staticGroup.add(post);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(len, 0.34, 0.08), bannerMat);
    banner.position.set(mx, postH + 0.05, -my);
    banner.rotation.y = ang;
    banner.castShadow = true;
    this._staticGroup.add(banner);
  }

  /**
   * Faint translucent checkpoint gates: a low accent plane across each gate with
   * two slim posts. arena.checkpoints = [{x1,y1,x2,y2}, ...] (ordered).
   * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} list
   */
  _buildCheckpoints(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    const gateH = 1.3;
    const planeMat = new THREE.MeshStandardMaterial({
      color: 0xf5c518, roughness: 0.6, metalness: 0.0,
      transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false,
    });
    const postMat = new THREE.MeshStandardMaterial({
      color: 0xf5c518, roughness: 0.5, metalness: 0.1,
      transparent: true, opacity: 0.5, emissive: 0x3a2f04, emissiveIntensity: 0.5,
    });
    for (let i = 0; i < list.length; i++) {
      const cp = list[i];
      if (!cp) continue;
      const x1 = num(cp.x1, NaN), y1 = num(cp.y1, NaN);
      const x2 = num(cp.x2, NaN), y2 = num(cp.y2, NaN);
      if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
          !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-3)) continue;
      const ang = Math.atan2(dy, dx);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;

      const plane = new THREE.Mesh(new THREE.PlaneGeometry(len, gateH), planeMat);
      plane.position.set(mx, gateH / 2, -my);
      // PlaneGeometry width (local +X) runs along the gate line; height (local
      // +Y) stays upright. rotation.y = ang aligns +X with the line direction
      // (dx,0,-dy), leaving the face normal across the gate (travel direction).
      plane.rotation.y = ang;
      this._staticGroup.add(plane);

      for (const e of [[x1, y1], [x2, y2]]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, gateH, 8), postMat);
        post.position.set(e[0], gateH / 2, -e[1]);
        this._staticGroup.add(post);
      }
    }
  }

  /**
   * Build the road ribbon + painted edge lines + dashed center line.
   * @param {Array<[number,number]>} slot closed centerline polyline (meters)
   * @param {number} roadW road width (meters)
   */
  _buildRoad(slot, roadW) {
    const pts = [];
    for (const p of slot) {
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) pts.push({ x: p[0], y: p[1] });
    }
    if (pts.length < 3) return;

    // Tarmac surface.
    const surfMat = new THREE.MeshStandardMaterial({ color: 0x26282d, roughness: 0.85, metalness: 0.0 });
    const surf = new THREE.Mesh(this._ribbonGeometry(pts, roadW, 0.02), surfMat);
    surf.receiveShadow = true;
    this._staticGroup.add(surf);

    // Painted edge lines (white) just inside each edge.
    const inset = Math.min(0.18, roadW * 0.08);
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6, metalness: 0.0 });
    const half = roadW / 2 - inset;
    const leftEdge = this._offsetLoop(pts, half);
    const rightEdge = this._offsetLoop(pts, -half);
    this._staticGroup.add(new THREE.Mesh(this._ribbonGeometry(leftEdge, 0.14, 0.035), edgeMat));
    this._staticGroup.add(new THREE.Mesh(this._ribbonGeometry(rightEdge, 0.14, 0.035), edgeMat));

    // Dashed yellow center line.
    const dashGeo = this._dashGeometry(pts, 2.2, 1.1, 0.16, 0.04);
    if (dashGeo) {
      const dashMat = new THREE.MeshStandardMaterial({ color: 0xffcf3f, roughness: 0.55, metalness: 0.0 });
      this._staticGroup.add(new THREE.Mesh(dashGeo, dashMat));
    }
  }

  /**
   * Build wall boxes matching the physics arena (perimeter + interior).
   * @param {import('../core/world.js').ArenaDef} arena
   * @param {number} w arena width (m)
   * @param {number} h arena height (m)
   */
  _buildWalls(arena, w, h) {
    const wallH = 1.1;
    const mat = new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.9, metalness: 0.0 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xd23b2f, roughness: 0.7, metalness: 0.0 });

    const add = (x1, y1, x2, y2, thick) => {
      const t = Math.max(0.08, num(thick, 0.3));
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) return;
      const ang = Math.atan2(dy, dx);
      // BoxGeometry: local X = length, Y = height, Z = thickness.
      const geo = new THREE.BoxGeometry(len, wallH, t);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(mx, wallH / 2, -my); // physics (mx,my) -> 3D (mx,0,-my)
      mesh.rotation.y = ang;                 // physics-z rotation -> 3D +Y
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this._staticGroup.add(mesh);

      // A thin coping cap along the top for a finished look.
      const cap = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, t + 0.06), capMat);
      cap.position.set(mx, wallH + 0.05, -my);
      cap.rotation.y = ang;
      cap.castShadow = true;
      this._staticGroup.add(cap);
    };

    const hw = w / 2;
    const hh = h / 2;
    if (arena.wall !== false) {
      add(-hw, hh, hw, hh, 0.3);   // top
      add(-hw, -hh, hw, -hh, 0.3); // bottom
      add(-hw, -hh, -hw, hh, 0.3); // left
      add(hw, -hh, hw, hh, 0.3);   // right
    }
    if (Array.isArray(arena.walls)) {
      for (const wl of arena.walls) {
        if (wl) add(wl.x1, wl.y1, wl.x2, wl.y2, wl.thickM);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Ribbon / dash geometry helpers (all closed loops in the XZ plane)
  // ---------------------------------------------------------------------------

  /** Per-point left-normal offset of a closed polyline. */
  _offsetLoop(pts, dist) {
    const n = pts.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n];
      const b = pts[(i + 1) % n];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1e-6;
      tx /= len; ty /= len;
      // Left normal of tangent (tx,ty) is (-ty, tx).
      out.push({ x: pts[i].x + (-ty) * dist, y: pts[i].y + tx * dist });
    }
    return out;
  }

  /**
   * Flat closed-loop ribbon of the given width around a centerline, laid in the
   * XZ plane at height `y`. Maps center (x,y) -> 3D (x, y, -y_world).
   * @param {Array<{x:number,y:number}>} center
   * @param {number} width
   * @param {number} y height above ground
   * @returns {THREE.BufferGeometry}
   */
  _ribbonGeometry(center, width, y) {
    const n = center.length;
    const half = width / 2;
    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = center[(i - 1 + n) % n];
      const b = center[(i + 1) % n];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1e-6;
      tx /= len; ty /= len;
      const nx = -ty; // left normal
      const ny = tx;
      const cx = center[i].x;
      const cy = center[i].y;
      // Left vertex then right vertex. Map to 3D (x, y, -yworld).
      pos.push(cx + nx * half, y, -(cy + ny * half));
      pos.push(cx - nx * half, y, -(cy - ny * half));
      nrm.push(0, 1, 0, 0, 1, 0);
      const u = i / n;
      uv.push(u, 1, u, 0);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const l0 = i * 2, r0 = i * 2 + 1, l1 = j * 2, r1 = j * 2 + 1;
      idx.push(l0, r0, r1);
      idx.push(l0, r1, l1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return geo;
  }

  /**
   * Dashed center-line geometry: quads placed every `period` meters of arc.
   * @returns {THREE.BufferGeometry|null}
   */
  _dashGeometry(center, period, dashLen, width, y) {
    const n = center.length;
    if (n < 2) return null;
    // Cumulative arc length around the closed loop.
    const seg = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const a = center[i];
      const b = center[(i + 1) % n];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      seg.push({ a, b, l, start: total });
      total += l;
    }
    if (!(total > 0)) return null;

    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];
    let vcount = 0;
    const half = width / 2;
    const hd = dashLen / 2;

    const sampleAt = (s) => {
      s = ((s % total) + total) % total;
      // Linear search is fine (few dozen segments).
      for (let i = 0; i < seg.length; i++) {
        const g = seg[i];
        if (s <= g.start + g.l || i === seg.length - 1) {
          const f = g.l > 1e-6 ? (s - g.start) / g.l : 0;
          const x = g.a.x + (g.b.x - g.a.x) * f;
          const yv = g.a.y + (g.b.y - g.a.y) * f;
          let tx = g.b.x - g.a.x;
          let ty = g.b.y - g.a.y;
          const len = Math.hypot(tx, ty) || 1e-6;
          return { x, y: yv, tx: tx / len, ty: ty / len };
        }
      }
      return null;
    };

    for (let s = 0; s < total; s += period) {
      const p = sampleAt(s);
      if (!p) continue;
      const nx = -p.ty; // left normal
      const ny = p.tx;
      // Four corners of the dash quad (centered at p, along tangent & normal).
      const corners = [
        { x: p.x - p.tx * hd + nx * half, y: p.y - p.ty * hd + ny * half },
        { x: p.x - p.tx * hd - nx * half, y: p.y - p.ty * hd - ny * half },
        { x: p.x + p.tx * hd - nx * half, y: p.y + p.ty * hd - ny * half },
        { x: p.x + p.tx * hd + nx * half, y: p.y + p.ty * hd + ny * half },
      ];
      for (const c of corners) { pos.push(c.x, y, -c.y); nrm.push(0, 1, 0); }
      uv.push(0, 1, 0, 0, 1, 0, 1, 1);
      idx.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
      vcount += 4;
    }
    if (vcount === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return geo;
  }

  // ---------------------------------------------------------------------------
  // Vehicle visuals
  // ---------------------------------------------------------------------------

  /** Dispose the current vehicle visual and build one for `vehicle`. */
  _rebuildVehicle(vehicle) {
    this._clearGroup(this._vehGroup);
    this._veh = null;
    this._builtVehicle = vehicle || null;
    if (!vehicle) return;

    const spec = vehicle.spec || {};
    const type = spec.type || 'racecar';
    let visual;
    try {
      if (type === 'robot') visual = this._makeRobot(spec);
      else if (type === 'slotcar') visual = this._makeSlotCar(spec);
      else visual = this._makeRaceCar(spec);
    } catch (_e) {
      visual = this._makeRaceCar(spec);
    }
    this._veh = visual;
    this._vehGroup.add(visual.root);
    this._camSnap = true; // snap chase cam to the new vehicle
  }

  /**
   * Update the vehicle visual transforms from a physics snapshot.
   * @param {import('../vehicles/vehicle.js').VehicleState} state
   */
  _updateVehicle(state) {
    const veh = this._veh;
    if (!veh) return;
    const x = num(state.x, 0);
    const y = num(state.y, 0);
    const ang = num(state.angleRad, 0);

    // Body: physics (x,y) -> 3D (x,0,-y); angle θ -> rotation.y = θ.
    veh.body.position.set(x, 0, -y);
    veh.body.rotation.y = ang;

    // Wheels (world poses from getState) — front wheels carry steer angle.
    const wheels = Array.isArray(state.wheels) ? state.wheels : [];
    for (let i = 0; i < veh.wheels.length; i++) {
      const wv = veh.wheels[i];
      const ws = wheels[i];
      if (ws) {
        wv.group.position.set(num(ws.x, 0), wv.y, -num(ws.y, 0));
        wv.group.rotation.y = num(ws.angleRad, ang);
        if (wv.tire) wv.tire.rotation.z = -num(ws.spin, 0); // rolling about axle
      }
    }

    // Live SPIKE robot updates: hub light matrix, colour-sensor lens tint, and
    // the distance-sensor ray length — all from the same getState() the sensors
    // report, so the 3D bot shows exactly what the code/challenges read.
    if (veh.type === 'robot' && veh.robot) this._updateRobot(veh.robot, state);

    // Crash tint feedback for the slot car (if it flew off).
    if (veh.type === 'slotcar' && veh.bodyMat) {
      const crashed = !!(state.extra && state.extra.crashed);
      veh.bodyMat.emissiveIntensity = crashed ? 0.6 : 0.0;
    }
  }

  /**
   * Update the live SPIKE robot decorations from a physics snapshot: redraw the
   * hub matrix when its lit pattern changes, tint each colour lens with its live
   * reading, and stretch each distance ray to the measured range.
   * @param {{matrix:Object, colorSensors:Array, distanceSensors:Array}} rob
   * @param {import('../vehicles/vehicle.js').VehicleState} state
   */
  _updateRobot(rob, state) {
    const sensors = (state && state.sensors) || {};

    // Hub 5x5 light matrix (same matrixState as the 2D view => identical LEDs).
    if (rob.matrix && rob.matrix.ctx) {
      const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const gs = matrixState(this._robotDisplay(state), t);
      const grid = gs && Array.isArray(gs.grid) ? gs.grid : null;
      let key = '';
      if (grid) for (let i = 0; i < 25; i++) key += grid[i] >= 0.5 ? '1' : (grid[i] >= 0.1 ? '.' : '0');
      if (key !== rob.matrix.lastKey) {
        rob.matrix.lastKey = key;
        this._drawMatrixCanvas(rob.matrix.ctx, rob.matrix.px, grid);
        rob.matrix.tex.needsUpdate = true;
      }
    }

    // Colour lenses — tint + gentle glow from the live reading hex.
    for (const cs of rob.colorSensors) {
      const rd = sensors[cs.port];
      const hex = rd && typeof rd.hex === 'string' ? rd.hex : '#101216';
      try { this._colorScratch.set(hex); } catch (_e) { this._colorScratch.set(0x101216); }
      cs.lensMat.color.copy(this._colorScratch);
      cs.lensMat.emissive.copy(this._colorScratch);
      cs.lensMat.emissiveIntensity = 0.55;
    }

    // Distance rays — length = measured cm (bright), else a faint max-range beam.
    for (const ds of rob.distanceSensors) {
      const rd = sensors[ds.port];
      const cm = rd && rd.cm != null && Number.isFinite(rd.cm) ? rd.cm : null;
      const len = Math.max(0.001, cm != null ? cm / 100 : ds.maxLen);
      ds.beam.scale.x = len;
      ds.beam.material.opacity = cm != null ? 0.5 : 0.1;
      if (ds.endMarker) {
        ds.endMarker.visible = cm != null;
        ds.endMarker.position.set(ds.base + len, 0, 0);
      }
    }
  }

  /**
   * Create the pooled skid-decal InstancedMesh (once). Small dark flat discs
   * that lie on the ground; per-frame we place the active vehicle's skid points
   * into it and fade them via per-instance color (fresh = dark, old = tarmac).
   */
  _buildSkidDecals() {
    if (this._skidMesh) return;
    try {
      const geo = new THREE.CircleGeometry(1, 12); // unit radius; scaled per instance
      geo.rotateX(-Math.PI / 2);                    // lie flat on the XZ ground
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,             // modulated by per-instance color
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, this._skidCap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;          // over the ground, under the vehicle
      // Seed instanceColor so per-instance tint is available from frame one.
      this._skidColor = new THREE.Color();
      for (let i = 0; i < this._skidCap; i++) mesh.setColorAt(i, this._skidColor.setRGB(0.07, 0.07, 0.08));
      this.scene.add(mesh);
      this._skidMesh = mesh;

      this._skidMat4 = new THREE.Matrix4();
      this._skidPos = new THREE.Vector3();
      this._skidScale = new THREE.Vector3(1, 1, 1);
      this._skidQuat = new THREE.Quaternion(); // identity (discs already flat)
      this._skidColorA = new THREE.Color(0x111114); // fresh rubber
      this._skidColorB = new THREE.Color(0x33363c); // aged, near tarmac
    } catch (_e) {
      this._skidMesh = null;
    }
  }

  /**
   * Place the active vehicle's skid points into the decal pool with an age fade.
   * The skid array is oldest-first (core shift()s the head), so higher index =
   * fresher = darker + slightly larger. Reuses scratch objects (no per-frame
   * allocation). Safe to call every frame.
   */
  _updateSkidDecals() {
    const mesh = this._skidMesh;
    if (!mesh) return;
    const v = this._builtVehicle;
    const skids = v && v.skids;
    if (!Array.isArray(skids) || skids.length < 1) {
      if (mesh.count !== 0) { mesh.count = 0; }
      return;
    }
    // Per-type footprint so a race car reads chunky and a robot stays dainty.
    const type = (v.spec && v.spec.type) || 'racecar';
    const radius = type === 'racecar' ? 0.32 : 0.07;

    const n = skids.length;
    const cap = this._skidCap;
    const start = n > cap ? n - cap : 0;
    const count = n - start;
    const denom = count > 1 ? count - 1 : 1;

    let live = 0;
    for (let k = 0; k < count; k++) {
      const p = skids[start + k];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const t = k / denom;                 // 0 = oldest, 1 = freshest
      const s = radius * (0.55 + 0.45 * t);
      this._skidPos.set(p.x, 0.02, -p.y);
      this._skidScale.set(s, 1, s);
      this._skidMat4.compose(this._skidPos, this._skidQuat, this._skidScale);
      mesh.setMatrixAt(live, this._skidMat4);
      this._skidColor.copy(this._skidColorB).lerp(this._skidColorA, t);
      mesh.setColorAt(live, this._skidColor);
      live++;
    }
    mesh.count = live;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** A rolling wheel: group (heading) -> tire (spin about baked Z axle). */
  _makeWheel(radius, width, color) {
    const group = new THREE.Group();
    const geo = new THREE.CylinderGeometry(radius, radius, width, 18);
    geo.rotateX(Math.PI / 2); // cylinder axis Y -> Z (the lateral axle)
    const mat = new THREE.MeshStandardMaterial({ color: color || 0x1a1a1e, roughness: 0.85, metalness: 0.05 });
    const tire = new THREE.Mesh(geo, mat);
    tire.castShadow = true;
    // Simple hub cap for a bit of detail.
    const hubGeo = new THREE.CylinderGeometry(radius * 0.42, radius * 0.42, width + 0.01, 12);
    hubGeo.rotateX(Math.PI / 2);
    const hub = new THREE.Mesh(hubGeo, new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.4, metalness: 0.6 }));
    tire.add(hub);
    group.add(tire);
    return { group, tire };
  }

  /**
   * Race car: tapered RoundedBox body + glass cabin + 4 steerable-front tires +
   * a rear spoiler, all in the spec color.
   */
  _makeRaceCar(spec) {
    const L = num(spec.lengthM, 4);
    const W = num(spec.widthM, 2);
    const color = toColor(spec.color, 0xe2402a);
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const tireR = num(spec.tireLenM, 0.6) / 2;   // rolling radius
    const tireW = num(spec.tireWidM, 0.3);

    // Main shell — tapered toward the nose (+x).
    const shellGeo = new RoundedBoxGeometry(L * 0.96, 0.5, W * 0.9, 4, 0.16);
    this._taperX(shellGeo, 0.6, 1.0);
    const bodyMat = new THREE.MeshStandardMaterial({
      color, roughness: 0.35, metalness: 0.25, emissive: color.clone().multiplyScalar(0.04),
    });
    const shell = new THREE.Mesh(shellGeo, bodyMat);
    shell.position.set(0, tireR + 0.18, 0);
    shell.castShadow = true;
    shell.receiveShadow = true;
    body.add(shell);

    // A lower splitter/floor slab (dark) grounds the look.
    const floor = new THREE.Mesh(
      new RoundedBoxGeometry(L * 0.98, 0.14, W * 0.86, 3, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.8, metalness: 0.1 })
    );
    floor.position.set(0, tireR - 0.02, 0);
    floor.castShadow = true;
    body.add(floor);

    // Cabin / cockpit glass, set back from the nose.
    const cabin = new THREE.Mesh(
      new RoundedBoxGeometry(L * 0.34, 0.34, W * 0.62, 3, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x10151c, roughness: 0.15, metalness: 0.1 })
    );
    cabin.position.set(-L * 0.06, tireR + 0.48, 0);
    cabin.castShadow = true;
    body.add(cabin);

    // Rear spoiler: a wing on two struts, in the car color.
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.06, W * 0.92),
      bodyMat
    );
    wing.position.set(-L / 2 + 0.15, tireR + 0.6, 0);
    wing.castShadow = true;
    body.add(wing);
    const strutMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.6, metalness: 0.3 });
    for (const sz of [W * 0.32, -W * 0.32]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.06), strutMat);
      strut.position.set(-L / 2 + 0.15, tireR + 0.42, sz);
      body.add(strut);
    }

    // Headlights (front) + taillights (rear) as small emissive pads.
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 0.8, roughness: 0.4 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2a1a, emissiveIntensity: 0.7, roughness: 0.5 });
    for (const sz of [W * 0.28, -W * 0.28]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.22), headMat);
      hl.position.set(L / 2 - 0.16, tireR + 0.2, sz);
      body.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.2), tailMat);
      tl.position.set(-L / 2 + 0.06, tireR + 0.28, sz);
      body.add(tl);
    }

    // Four tires (front two steer via getState wheel angle).
    const wheels = [];
    for (let i = 0; i < 4; i++) {
      const wheel = this._makeWheel(tireR, tireW, 0x161619);
      wheel.y = tireR;
      root.add(wheel.group);
      wheels.push(wheel);
    }

    return { root, body, wheels, type: 'racecar', bodyMat, camSize: L };
  }

  /** Slot car: a small go-kart body + guide flag (steer ignored). */
  _makeSlotCar(spec) {
    const L = num(spec.lengthM, 0.18);
    const W = num(spec.widthM, 0.1);
    const color = toColor(spec.color, 0xffd23f);
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const bodyMat = new THREE.MeshStandardMaterial({
      color, roughness: 0.4, metalness: 0.3, emissive: 0xff5522, emissiveIntensity: 0.0,
    });
    // Scale the kart up a touch (x6-ish) so it reads at car-arena distances,
    // while staying centered on the true physics point.
    const s = 6;
    const shell = new THREE.Mesh(new RoundedBoxGeometry(L * s, 0.16 * s, W * s, 3, 0.02 * s), bodyMat);
    this._taperX(shell.geometry, 0.55, 1.0);
    shell.position.set(0, 0.12 * s, 0);
    shell.castShadow = true;
    body.add(shell);

    // Driver head bump.
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.05 * s, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.5 })
    );
    head.position.set(-L * s * 0.1, 0.22 * s, 0);
    head.castShadow = true;
    body.add(head);

    // Guide flag / fin at the front, in the car color.
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03 * s, 0.14 * s, 0.02 * s), bodyMat);
    fin.position.set(L * s * 0.5, 0.16 * s, 0);
    body.add(fin);

    // Four decorative fixed wheels (no physics wheel state for the slot car).
    const wr = 0.05 * s;
    const ax = L * s * 0.32;
    const az = W * s * 0.52;
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.85 });
    for (const [dx, dz] of [[ax, az], [ax, -az], [-ax, az], [-ax, -az]]) {
      const geo = new THREE.CylinderGeometry(wr, wr, 0.05 * s, 14);
      geo.rotateX(Math.PI / 2);
      const wm = new THREE.Mesh(geo, wheelMat);
      wm.position.set(dx, wr, dz);
      wm.castShadow = true;
      body.add(wm);
    }

    // Camera frames the visual kart (drawn at `s`x its physics size).
    return { root, body, wheels: [], type: 'slotcar', bodyMat, camSize: L * s };
  }

  /**
   * Robot: an ACCURATE SPIKE Prime driving base (docs/ART.md v1.3). Coloured
   * plastic chassis; a WHITE 88:56:32 hub carrying a live warm-white 5x5 light
   * matrix (fed from getState().display) + a centre button ring; MEDIUM-AZUR
   * tires on white 4-spoke rims; white-bodied sensors placed from spec.devices
   * at their real offsets (distance = two black eyes + a live ray; colour = a
   * downward lens tinted with the live reading; force = white body + black
   * plunger tip); a rear caster. Returns per-frame update handles in `.robot`.
   */
  _makeRobot(spec) {
    const L = num(spec.lengthM, 0.28);
    const W = num(spec.widthM, 0.22);
    const color = toColor(spec.color, 0x33b1ff);
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const wheelR = num(spec.wheelLenM, 0.09) / 2;
    const wheelW = num(spec.wheelWidM, 0.03);
    const deckThick = 0.05;
    const deckY = wheelR + 0.012 + deckThick / 2; // deck centre height
    const deckTop = deckY + deckThick / 2;

    // Chassis deck (rounded plastic, in the config colour — plastic, not clay).
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.12 });
    const deck = new THREE.Mesh(new RoundedBoxGeometry(L, deckThick, W, 3, 0.02), bodyMat);
    deck.position.set(0, deckY, 0);
    deck.castShadow = true;
    deck.receiveShadow = true;
    body.add(deck);

    // WHITE SPIKE hub (Large Hub 45601: 88:56:32 proportions, scaled to fit).
    const hubScale = Math.min((0.82 * L) / 0.088, (0.9 * W) / 0.056);
    const hubL = 0.088 * hubScale;
    const hubW = 0.056 * hubScale;
    const hubH = 0.032 * hubScale;
    const hubCX = -L * 0.01;
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.5, metalness: 0.05 });
    const hub = new THREE.Mesh(new RoundedBoxGeometry(hubL, hubH, hubW, 3, hubH * 0.18), hubMat);
    hub.position.set(hubCX, deckTop + hubH / 2, 0);
    hub.castShadow = true;
    body.add(hub);
    const hubTop = deckTop + hubH;

    // Live 5x5 warm-white light matrix on the hub top, toward the front.
    const matrix = this._makeRobotMatrix(Math.min(hubL, hubW) * 0.62);
    matrix.mesh.position.set(hubCX + hubL * 0.14, hubTop + 0.0015, 0);
    body.add(matrix.mesh);

    // Centre button: a white round pip with a faint azure RGB ring (rear of hub).
    const btnCX = hubCX - hubL * 0.26;
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x6bc5e1, transparent: true, opacity: 0.85, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(hubW * 0.13, hubW * 0.03, 8, 20), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(btnCX, hubTop + 0.001, 0);
    body.add(ring);
    const pip = new THREE.Mesh(
      new THREE.CylinderGeometry(hubW * 0.1, hubW * 0.1, 0.004, 16),
      new THREE.MeshStandardMaterial({ color: 0xfbfbfc, roughness: 0.5 })
    );
    pip.position.set(btnCX, hubTop + 0.002, 0);
    body.add(pip);

    // Rear caster ball in a dark socket.
    const socket = new THREE.Mesh(
      new THREE.CylinderGeometry(wheelR * 0.62, wheelR * 0.62, 0.02, 12),
      new THREE.MeshStandardMaterial({ color: 0x20232a, roughness: 0.7 })
    );
    socket.position.set(-L * 0.42, wheelR * 0.62, 0);
    body.add(socket);
    const caster = new THREE.Mesh(
      new THREE.SphereGeometry(wheelR * 0.5, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x9a9ea6, roughness: 0.4, metalness: 0.4 })
    );
    caster.position.set(-L * 0.42, wheelR * 0.5, 0);
    caster.castShadow = true;
    body.add(caster);

    // White motor bodies inboard of each drive wheel (grey zero-mark end cap).
    const half = num(spec.trackM, 0.24) / 2;
    const motorMat = new THREE.MeshStandardMaterial({ color: 0xeceef1, roughness: 0.55, metalness: 0.08 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xcfd3da, roughness: 0.4, metalness: 0.2 });
    for (const sy of [half * 0.62, -half * 0.62]) {
      const mBody = new THREE.Mesh(new RoundedBoxGeometry(wheelR * 2.0, wheelR * 1.1, wheelR * 1.1, 2, 0.008), motorMat);
      mBody.position.set(0, wheelR, sy);
      mBody.castShadow = true;
      body.add(mBody);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.5, wheelR * 0.5, 0.008, 14), capMat);
      cap.rotation.x = Math.PI / 2; // face along +/-z (toward the wheel)
      cap.position.set(0, wheelR, sy + (sy >= 0 ? wheelR * 0.58 : -wheelR * 0.58));
      body.add(cap);
    }

    // Two azure drive wheels (updated from getState wheel poses).
    const wheels = [];
    for (let i = 0; i < 2; i++) {
      const wheel = this._makeSpikeWheel(wheelR, wheelW);
      wheel.y = wheelR;
      root.add(wheel.group);
      wheels.push(wheel);
    }

    // Sensors from the device list, at their real local offsets (physics local
    // +x forward, +y left -> 3D local +x forward, -z right). Store live handles.
    const devices = Array.isArray(spec.devices) ? spec.devices : [];
    const colorSensors = [];
    const distanceSensors = [];
    const whiteMat = () => new THREE.MeshStandardMaterial({ color: 0xf1f3f6, roughness: 0.5, metalness: 0.05 });
    for (const dev of devices) {
      if (!dev) continue;
      const dx = num(dev.x, 0);
      const lz = -num(dev.y, 0);
      const headingRad = (num(dev.headingDeg, 0) * Math.PI) / 180;

      if (dev.type === 'color') {
        const cs = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.03, 0.05, 2, 0.008), whiteMat());
        cs.position.set(dx, deckY - deckThick * 0.15, lz);
        cs.castShadow = true;
        body.add(cs);
        // Downward lens — tinted live with the reading; a faint white ring is the
        // sensor's own illumination LEDs.
        const lensMat = new THREE.MeshStandardMaterial({ color: 0x101216, emissive: 0x000000, emissiveIntensity: 0.6, roughness: 0.35 });
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.006, 16), lensMat);
        lens.position.set(dx, Math.max(0.008, deckY - deckThick * 0.7), lz);
        body.add(lens);
        const illumRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.019, 0.003, 6, 18),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, toneMapped: false })
        );
        illumRing.rotation.x = Math.PI / 2;
        illumRing.position.copy(lens.position);
        body.add(illumRing);
        colorSensors.push({ lensMat, port: dev.port });
      } else if (dev.type === 'distance') {
        const pivot = new THREE.Group();
        pivot.position.set(dx, deckY, lz);
        pivot.rotation.y = headingRad;
        body.add(pivot);
        const face = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.045, 0.05, 2, 0.01), whiteMat());
        face.position.set(0, 0, 0);
        face.castShadow = true;
        pivot.add(face);
        // Two black eyes on the front face (+x), each with a faint warm ring.
        const eyeGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.012, 14);
        eyeGeo.rotateZ(Math.PI / 2); // axis -> local x (face forward)
        const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.3, metalness: 0.1 });
        for (const ez of [0.013, -0.013]) {
          const eye = new THREE.Mesh(eyeGeo, eyeMat);
          eye.position.set(0.016, 0, ez);
          pivot.add(eye);
        }
        // Live distance ray: unit box along +x, near end anchored at the sensor.
        const beamGeo = new THREE.BoxGeometry(1, 0.006, 0.006);
        beamGeo.translate(0.5, 0, 0);
        const beamMat = new THREE.MeshBasicMaterial({ color: 0x6bc5e1, transparent: true, opacity: 0.12, toneMapped: false, depthWrite: false });
        const beam = new THREE.Mesh(beamGeo, beamMat);
        beam.position.set(0.02, 0, 0);
        beam.renderOrder = 2;
        pivot.add(beam);
        const endMarker = new THREE.Mesh(
          new THREE.SphereGeometry(0.014, 10, 8),
          new THREE.MeshBasicMaterial({ color: 0xbfeeff, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false })
        );
        endMarker.visible = false;
        pivot.add(endMarker);
        distanceSensors.push({ beam, endMarker, port: dev.port, maxLen: 2.0, base: 0.02 });
      } else if (dev.type === 'force') {
        const pivot = new THREE.Group();
        pivot.position.set(dx, deckY, lz);
        pivot.rotation.y = headingRad;
        body.add(pivot);
        const fb = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.036, 0.03, 2, 0.008), whiteMat());
        fb.castShadow = true;
        pivot.add(fb);
        const tip = new THREE.Mesh(
          new THREE.SphereGeometry(0.011, 12, 10),
          new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.4 })
        );
        tip.position.set(0.02, 0, 0);
        pivot.add(tip);
      }
    }

    // Frame the little bot a bit generously so it reads in a big arena.
    return {
      root, body, wheels, type: 'robot', bodyMat,
      camSize: Math.max(L * 1.4, 0.4),
      robot: { matrix, colorSensors, distanceSensors },
    };
  }

  /**
   * A SPIKE Prime wheel (part 39367): medium-azur tire on a WHITE 4-spoke rim.
   * The rim + spokes are children of the spinning tire so rotation reads clearly.
   * @param {number} radius rolling radius (m)
   * @param {number} width tire width (m)
   * @returns {{group:THREE.Group, tire:THREE.Mesh}}
   */
  _makeSpikeWheel(radius, width) {
    const group = new THREE.Group();
    const geo = new THREE.CylinderGeometry(radius, radius, width, 22);
    geo.rotateX(Math.PI / 2); // cylinder axis Y -> Z (the lateral axle)
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x45b5d8, roughness: 0.7, metalness: 0.02 });
    const tire = new THREE.Mesh(geo, tireMat);
    tire.castShadow = true;

    // White rim disc + a 4-spoke "plus" that spins with the tire.
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.4, metalness: 0.15 });
    const rimGeo = new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, width + 0.004, 18);
    rimGeo.rotateX(Math.PI / 2);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    tire.add(rim);
    const spokeMat = new THREE.MeshStandardMaterial({ color: 0xcfd4dc, roughness: 0.5 });
    for (let k = 0; k < 2; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.7, radius * 0.2, width * 0.9), spokeMat);
      spoke.rotation.z = k * (Math.PI / 2); // 0 and 90deg -> a + (4 spokes)
      tire.add(spoke);
    }
    // Dark hub cap centre.
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, width + 0.008, 12),
      new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.2 })
    );
    cap.rotation.x = Math.PI / 2;
    tire.add(cap);

    group.add(tire);
    return { group, tire };
  }

  /**
   * Build the hub light-matrix: a small canvas texture on an unlit (glowing)
   * plane laid flat on the hub top. `worldSize` is the plane's side in metres.
   * rotateX(-90) lays it flat facing +y; rotateY(-90) turns the glyph's top
   * toward the robot's forward (+x). Redrawn only when the lit pattern changes.
   * @param {number} worldSize plane side length (m)
   * @returns {{mesh:THREE.Mesh, tex:THREE.CanvasTexture, ctx:CanvasRenderingContext2D, px:number, lastKey:string}}
   */
  _makeRobotMatrix(worldSize) {
    const px = 128;
    const canvas = document.createElement('canvas');
    canvas.width = px; canvas.height = px;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, transparent: false });
    const geo = new THREE.PlaneGeometry(worldSize, worldSize);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    const handle = { mesh, tex, ctx, px, lastKey: '' };
    if (ctx) this._drawMatrixCanvas(ctx, px, null); // idle grid
    tex.needsUpdate = true;
    return handle;
  }

  /**
   * Draw a 5x5 warm-white LED grid onto the matrix canvas from a matrixState
   * grid (25 intensities row-major, row 0 = top). Dark panel behind; lit LEDs
   * get a soft halo. Deterministic, no allocation of THREE objects.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} S canvas size (px)
   * @param {number[]|null} grid
   */
  _drawMatrixCanvas(ctx, S, grid) {
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#15120a';
    ctx.fillRect(0, 0, S, S);
    const pad = S * 0.08;
    const cell = (S - 2 * pad) / 5;
    const rad = cell * 0.34;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const vv = grid ? grid[r * 5 + c] : 0.05;
        const cx = pad + (c + 0.5) * cell;
        const cy = pad + (r + 0.5) * cell;
        if (vv >= 0.5) {
          ctx.fillStyle = 'rgba(255,228,168,0.22)';
          ctx.beginPath(); ctx.arc(cx, cy, rad * 1.7, 0, Math.PI * 2); ctx.fill();
        }
        const a = Math.max(0.05, Math.min(1, vv)).toFixed(3);
        ctx.fillStyle = `rgba(255,228,168,${a})`;
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  /** The hub display string from state/vehicle/spec (SPIKEAPI may set it). */
  _robotDisplay(state) {
    if (state && typeof state.display === 'string') return state.display;
    const v = this._builtVehicle;
    if (v && typeof v.display === 'string') return v.display;
    if (v && v.spec && typeof v.spec.display === 'string') return v.spec.display;
    return '';
  }

  /**
   * Taper a geometry along +X: vertices near the front (max X) get their Z (and
   * optionally Y) scaled toward the given factors, producing a wedge nose.
   */
  _taperX(geo, frontScaleZ, frontScaleY) {
    const pos = geo.attributes.position;
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const minX = bb.min.x;
    const spanX = (bb.max.x - bb.min.x) || 1e-6;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      let t = (x - minX) / spanX;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const sz = 1 + (frontScaleZ - 1) * t;
      const sy = 1 + (frontScaleY - 1) * t;
      pos.setZ(i, pos.getZ(i) * sz);
      pos.setY(i, pos.getY(i) * sy);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  /** World position of the active vehicle as a 3D point, or null. */
  _currentVehiclePos(out) {
    if (!this._builtVehicle) return null;
    let s = null;
    try { s = this._builtVehicle.getState(); } catch (_e) { return null; }
    if (!s) return null;
    out.set(num(s.x, 0), 0, -num(s.y, 0));
    return out;
  }

  /** Drive the chase camera (follow mode) or leave OrbitControls in charge. */
  _updateCamera() {
    if (!this._follow) return;
    if (!this._builtVehicle) return;
    let s = null;
    try { s = this._builtVehicle.getState(); } catch (_e) { return; }
    if (!s) return;

    // Chase distance scales with the vehicle's VISUAL size (set per model when
    // built, so the 6x-scaled slot car and the tiny robot both frame well).
    let size = this._veh && this._veh.camSize;
    if (!Number.isFinite(size)) {
      const spec = this._builtVehicle.spec || {};
      size = Math.max(num(spec.lengthM, 4), num(spec.widthM, 2));
    }
    size = Math.min(7, Math.max(0.35, size));

    const x = num(s.x, 0);
    const y = num(s.y, 0);
    const ang = num(s.angleRad, 0);

    // Forward (+x local) in 3D is (cosθ, 0, -sinθ).
    const fx = Math.cos(ang);
    const fz = -Math.sin(ang);

    const camDist = size * 2.2 + 0.6;
    const camHeight = size * 0.95 + 0.4;
    const lookAhead = size * 0.7;
    const lookHeight = size * 0.3 + 0.1;

    // Desired camera position: behind + above the vehicle.
    const desired = this._v1.set(
      x - fx * camDist,
      camHeight,
      -y - fz * camDist
    );
    // Desired look target: slightly ahead of and above the vehicle.
    const target = this._v2.set(
      x + fx * lookAhead,
      lookHeight,
      -y - fz * lookAhead
    );

    if (this._camSnap) {
      this.camera.position.copy(desired);
      this._lookAt.copy(target);
      this._camSnap = false;
    } else {
      this.camera.position.lerp(desired, 0.14);
      this._lookAt.lerp(target, 0.18);
    }
    this.camera.lookAt(this._lookAt);
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  /** Remove + dispose every child of a group (geometry/material/textures). */
  _clearGroup(group) {
    if (!group) return;
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      group.remove(child);
      this._disposeObject(child);
    }
  }

  /** Recursively dispose an object's geometries, materials and their maps. */
  _disposeObject(obj) {
    obj.traverse((node) => {
      if (node.geometry) {
        try { node.geometry.dispose(); } catch (_e) { /* noop */ }
      }
      const m = node.material;
      if (m) {
        const mats = Array.isArray(m) ? m : [m];
        for (const mat of mats) {
          for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
            if (mat[key]) { try { mat[key].dispose(); } catch (_e) { /* noop */ } }
          }
          try { mat.dispose(); } catch (_e) { /* noop */ }
        }
      }
    });
  }

  /** Fully release GPU resources (call when discarding the view entirely). */
  destroy() {
    this.deactivate();
    if (this._ro) { try { this._ro.disconnect(); } catch (_e) { /* noop */ } this._ro = null; }
    this._clearGroup(this._vehGroup);
    this._clearGroup(this._staticGroup);
    if (this._skidMesh) {
      try {
        if (this.scene) this.scene.remove(this._skidMesh);
        this._disposeObject(this._skidMesh);
        this._skidMesh.dispose();
      } catch (_e) { /* noop */ }
      this._skidMesh = null;
    }
    if (this._sky) { this._disposeObject(this._sky); this._sky = null; }
    if (this._asphaltTex) { try { this._asphaltTex.dispose(); } catch (_e) { /* noop */ } this._asphaltTex = null; }
    if (this._checkerTex) { try { this._checkerTex.dispose(); } catch (_e) { /* noop */ } this._checkerTex = null; }
    if (this.controls) { try { this.controls.dispose(); } catch (_e) { /* noop */ } }
    if (this.renderer) {
      try { this.renderer.dispose(); } catch (_e) { /* noop */ }
      const el = this.renderer.domElement;
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    this._inited = false;
  }
}
