/**
 * SpikeSim — robot 3D model loader (docs/CONTRACT.md → V1.1 addendum, AGENT-MODEL).
 *
 * Loads an optional user-supplied 3D model (.glb / .gltf / .stl) described by
 * the robot config's `model` object and returns it as a ready-to-add
 * THREE.Group — or null when it cannot be loaded, in which case a friendly
 * message is emitted on the log bus and the caller keeps the procedural box
 * chassis. Only the 3D view consumes this module (js/view/ owns three imports).
 *
 * `model` schema (robot config; every field optional except `file`):
 *   { "file": "models/mybot.glb", "scaleCmPerUnit": 1, "yawDeg": 0,
 *     "xCm": 0, "yCm": 0, "zCm": 0 }
 *
 * Placement pipeline (SpikeSim conventions — units cm, robot faces +x):
 *   1. scale by `scaleCmPerUnit` (model units → cm; e.g. a model authored in
 *      meters needs 100, one in millimeters needs 0.1)
 *   2. yaw by `yawDeg` around the vertical axis, clockwise-positive seen from
 *      above (same sign convention as robot headings), so the model's nose
 *      ends up on +x — the robot's forward at zero rotation
 *   3. auto-center: bounding box centered over the robot origin, bottom face
 *      resting on the mat (local y = 0)
 *   4. offset by `xCm` (forward), `yCm` (right — body frame, like device
 *      offsets) and `zCm` (up)
 *
 * Every mesh gets castShadow = true. Files are cached per path, so re-applying
 * a robot (or several robots sharing one file) never re-downloads; each call
 * returns a fresh clone, safe to add/remove/dispose independently.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { emit } from '../core/bus.js';

/** STL files carry no materials — they get this neutral LEGO-grey plastic. */
const STL_MATERIAL_OPTS = { color: '#9aa1ad', roughness: 0.65, metalness: 0.15 };

/**
 * Per-file cache: path → Promise resolving to a template Object3D that is
 * cloned for every loadRobotModel() call. Failed loads are evicted so a fixed
 * file can be retried by simply pressing Apply again.
 * @type {Map<string, Promise<THREE.Object3D>>}
 */
const cache = new Map();

/** Finite-number-or-default helper for loosely validated config fields. */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Fetch + parse a model file into a reusable template object (cached).
 * @param {string} file path relative to the app root, e.g. 'models/mybot.glb'
 * @returns {Promise<THREE.Object3D>}
 */
function loadTemplate(file) {
  if (cache.has(file)) return cache.get(file);

  const extMatch = /\.([a-z0-9]+)$/i.exec(file);
  const ext = extMatch ? extMatch[1].toLowerCase() : '';
  let p;
  if (ext === 'glb' || ext === 'gltf') {
    p = new GLTFLoader().loadAsync(file).then((gltf) => gltf.scene);
  } else if (ext === 'stl') {
    p = new STLLoader().loadAsync(file).then((geometry) => {
      if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial(STL_MATERIAL_OPTS));
    });
  } else {
    p = Promise.reject(new Error(`unsupported file type "${ext ? '.' + ext : file}" — use .glb, .gltf or .stl`));
  }

  const guarded = p.catch((err) => {
    cache.delete(file); // don't cache failures — user may fix the file/path
    throw err;
  });
  cache.set(file, guarded);
  return guarded;
}

/**
 * Load the robot's custom 3D model and prepare it for the 3D view.
 *
 * Resolves to a THREE.Group positioned/scaled per the schema above, ready to
 * be added to the robot group in place of the box chassis — or null when the
 * config has no usable file or loading fails (a kid-readable message is
 * emitted via emit('log', ...); the caller should keep the box chassis).
 * Never rejects.
 *
 * @param {{file: string, scaleCmPerUnit?: number, yawDeg?: number,
 *          xCm?: number, yCm?: number, zCm?: number}|null|undefined} modelCfg
 *        the robot config's `model` object
 * @returns {Promise<THREE.Group|null>}
 */
export async function loadRobotModel(modelCfg) {
  if (!modelCfg || typeof modelCfg !== 'object'
      || typeof modelCfg.file !== 'string' || !modelCfg.file.trim()) {
    return null;
  }
  const file = modelCfg.file.trim();

  let template;
  try {
    template = await loadTemplate(file);
  } catch (err) {
    const why = err && err.message ? err.message : 'the file could not be read';
    emit('log', {
      text: `Could not load 3D model "${file}" (${why}) — using the standard box robot. `
        + 'Check the file name and see models/README.md.',
      level: 'error',
    });
    return null;
  }

  // root carries the user offsets; pivot carries yaw + scale + auto-centering.
  const root = new THREE.Group();
  root.name = 'robot-model';
  const pivot = new THREE.Group();
  const scale = num(modelCfg.scaleCmPerUnit, 1);
  pivot.scale.setScalar(Math.abs(scale) > 1e-6 ? scale : 1);
  // Clockwise-positive yaw (viewed from above) → negative three.js y rotation.
  pivot.rotation.y = -THREE.MathUtils.degToRad(num(modelCfg.yawDeg, 0));
  pivot.add(template.clone(true));
  root.add(pivot);

  // Auto-center AFTER scale+yaw: bbox centered on the robot origin in the
  // ground plane, bottom resting on the mat. (root is detached, so the world
  // matrices used by Box3 are exactly the root-local transform.)
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pivot);
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    pivot.position.set(-c.x, -box.min.y, -c.z);
  }

  // Body-frame offsets: xCm forward (+x), yCm right (+z in three), zCm up (+y).
  root.position.set(num(modelCfg.xCm, 0), num(modelCfg.zCm, 0), num(modelCfg.yCm, 0));

  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return root;
}
