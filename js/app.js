/**
 * SpikeSim app glue: boots the engine, views, editors, and wires the toolbar.
 * Module interfaces are defined in docs/CONTRACT.md.
 */
import { emit, on } from './core/bus.js';
import { Engine } from './core/engine.js';
import { defaultRobot, fallbackMap } from './core/defaults.js';
import { runPython } from './runtime/pyrun.js';
import { runPython3, isSpike3, preloadPyodide } from './runtime/pyrun3.js';
import { initBlocks, generatePython, serialize, deserialize, loadStarter } from './blocks/blocks.js';
import { ChallengeManager } from './ui/challenges.js';
import { View2D } from './view/view2d.js';
import { MapEditor } from './view/mapeditor.js';
import { View3D } from './view/view3d.js';
import { BuilderPanel } from './ui/builder.js';
import { Builder3D } from './ui/builder3d.js';
import { HelpSystem } from './ui/help.js';

const $ = (id) => document.getElementById(id);
const LS = {
  python: 'spikesim.python',
  blocks: 'spikesim.blocks',
  robot: 'spikesim.robot',
  customMaps: 'spikesim.maps.custom',
  ui: 'spikesim.ui',
};

function lsGetJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function lsSetJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked */ }
}

// ---------- engine ----------
const engine = new Engine();
engine.loadRobot(lsGetJson(LS.robot) ?? defaultRobot());

// ---------- ui state ----------
const ui = Object.assign(
  { editorTab: 'blocks', simTab: '2d', speed: 1, mapFile: null },
  lsGetJson(LS.ui, {})
);
let running = false;
let runHandle = null;
let speed = ui.speed || 1;

// ---------- console + hub display + beep ----------
const consoleEl = $('console');
on('log', ({ text, level = 'info' }) => {
  const line = document.createElement('div');
  line.className = `line ${level}`;
  line.textContent = text;
  consoleEl.appendChild(line);
  while (consoleEl.childElementCount > 300) consoleEl.firstElementChild.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
});
// Hub light matrix: build the 5x5 LED grid once, then light it from 'matrix'
// events. Text writes still show as a caption via 'display'.
const ledCells = [];
const hubMatrixEl = $('hub-matrix');
if (hubMatrixEl) {
  for (let i = 0; i < 25; i++) {
    const led = document.createElement('span');
    led.className = 'led';
    hubMatrixEl.appendChild(led);
    ledCells.push(led);
  }
}
on('matrix', ({ grid }) => {
  if (!grid || !ledCells.length) return;
  for (let i = 0; i < 25; i++) {
    const v = Math.max(0, Math.min(9, grid[i] | 0));
    const led = ledCells[i];
    led.classList.toggle('on', v > 0);
    led.style.setProperty('--b', (v / 9).toFixed(2));
  }
});
on('display', ({ text }) => { $('hub-display').textContent = text || ''; });

let audioCtx = null;
// Live oscillators, so Stop/Reset can cut a note that is still sounding.
const activeBeeps = new Set();
on('beep', ({ freq, sec }) => {
  try {
    audioCtx = audioCtx || new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.08;
    osc.frequency.value = freq;
    osc.connect(gain).connect(audioCtx.destination);
    const dur = Math.min(3, sec / speed);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
    const entry = { osc, gain };
    activeBeeps.add(entry);
    osc.onended = () => activeBeeps.delete(entry);
  } catch { /* audio blocked until user gesture — fine */ }
});
/** Cut every note still playing (Stop / Reset). */
function silenceBeeps() {
  if (!audioCtx) return;
  for (const { osc, gain } of activeBeeps) {
    try {
      gain.gain.cancelScheduledValues(audioCtx.currentTime);
      gain.gain.setValueAtTime(0, audioCtx.currentTime);
      osc.stop();
    } catch { /* already stopped */ }
  }
  activeBeeps.clear();
}

// ---------- views ----------
const view2d = new View2D($('canvas-2d'), engine);
const view3d = new View3D($('view3d-host'), engine);
const builder = new BuilderPanel($('builder-host'), engine);
const builder3d = new Builder3D($('builder3d-host'), engine);
const mapEditor = new MapEditor(view2d, engine, $('mapeditor-toolbar'));

// Build tab has two sub-editors: the 3D grab-and-place builder (default) and the form.
let buildSub = '3d';
function activateBuildEditors() {
  const is3d = buildSub === '3d';
  $('subtab-3d') && $('subtab-3d').classList.toggle('active', is3d);
  $('subtab-form') && $('subtab-form').classList.toggle('active', !is3d);
  $('builder3d-host') && $('builder3d-host').classList.toggle('hidden', !is3d);
  $('builder-host') && $('builder-host').classList.toggle('hidden', is3d);
  if (is3d) {
    builder.deactivate();
    try { builder3d.activate(); builder3d.resize(); } catch (e) { console.error('[app] builder3d', e); }
  } else {
    try { builder3d.deactivate(); } catch (e) { /* ignore */ }
    builder.activate();
  }
}
$('subtab-3d') && $('subtab-3d').addEventListener('click', () => { buildSub = '3d'; activateBuildEditors(); });
$('subtab-form') && $('subtab-form').addEventListener('click', () => { buildSub = 'form'; activateBuildEditors(); });
const help = new HelpSystem();
$('btn-help').onclick = () => help.openHelp();

// ---------- blocks + python editors ----------
const workspace = initBlocks($('blockly-host'));
const savedBlocks = lsGetJson(LS.blocks);
if (savedBlocks) {
  try {
    deserialize(workspace, savedBlocks);
  } catch {
    // Back the raw save up before the starter overwrites it on the next autosave,
    // so a project that failed to load once isn't lost for good.
    try {
      const raw = localStorage.getItem(LS.blocks);
      if (raw) localStorage.setItem(`${LS.blocks}.bak`, raw);
    } catch { /* storage blocked */ }
    loadStarter(workspace);
  }
} else {
  loadStarter(workspace);
}

const pyEditor = $('python-editor');
pyEditor.value = localStorage.getItem(LS.python) ?? `# SpikeSim — SPIKE-style Python. Press Run!
from spike import PrimeHub, MotorPair
from spike.control import wait_for_seconds

hub = PrimeHub()
mp = MotorPair()

mp.set_default_speed(40)
hub.light_matrix.write('GO')
mp.move(20, 'cm')
mp.turn(-90)          # negative = turn left
mp.move(20, 'cm')
hub.speaker.beep(72, 0.3)
print('done!')
`;
// Tab key inserts spaces instead of leaving the editor.
pyEditor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: eEnd, value } = pyEditor;
    pyEditor.value = value.slice(0, s) + '    ' + value.slice(eEnd);
    pyEditor.selectionStart = pyEditor.selectionEnd = s + 4;
  }
});

// Live Python preview under the blocks.
const preview = $('python-preview');
function refreshPreview() {
  try { preview.textContent = generatePython(workspace); } catch (err) { preview.textContent = `# ${err.message}`; }
}
let previewTimer = 0;
workspace.addChangeListener(() => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 250);
});
refreshPreview();

// Runtime badge: which Python dialect ▶ Run will use (see help.js "Coding" tab).
const runtimeBadge = $('runtime-badge');
function updateBadge() {
  runtimeBadge.textContent = ui.editorTab === 'blocks'
    ? 'Blocks → SPIKE 2 Python'
    : (isSpike3(pyEditor.value) ? 'SPIKE 3 · real Python' : 'SPIKE 2 · classic API');
}
let badgeTimer = 0;
pyEditor.addEventListener('input', () => {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 300);
});

// ---------- tabs ----------
function activateEditorTab(name) {
  ui.editorTab = name;
  $('tab-blocks').classList.toggle('active', name === 'blocks');
  $('tab-python').classList.toggle('active', name === 'python');
  $('blocks-pane').classList.toggle('active', name === 'blocks');
  $('python-pane').classList.toggle('active', name === 'python');
  if (name === 'blocks') Blockly.svgResize(workspace);
  updateBadge();
  saveUi();
}
function activateSimTab(name) {
  ui.simTab = name;
  for (const t of ['2d', '3d', 'build']) {
    $(`tab-${t}`).classList.toggle('active', name === t);
    $(`pane-${t}`).classList.toggle('active', name === t);
  }
  if (name === '3d') view3d.activate(); else view3d.deactivate();
  if (name === 'build') activateBuildEditors();
  else { builder.deactivate(); try { builder3d.deactivate(); } catch (e) { /* ignore */ } }
  if (name === '2d') { view2d.resize(); view2d.render(); }
  saveUi();
}
$('tab-blocks').onclick = () => activateEditorTab('blocks');
$('tab-python').onclick = () => activateEditorTab('python');
$('tab-2d').onclick = () => activateSimTab('2d');
$('tab-3d').onclick = () => activateSimTab('3d');
$('tab-build').onclick = () => activateSimTab('build');

// ---------- run / stop / reset ----------
function setRunning(next, reason) {
  running = next;
  $('btn-run').disabled = next;
  $('btn-stop').disabled = !next;
  view2d.setRobotDragEnabled(!next);
  emit('run-state', { running: next, reason });
}

async function run() {
  if (running) return;
  // Each program starts from the Build-tab drive config; a previous program's
  // "set movement motors" override must not leak into this run (either runtime).
  engine.api.resetDrivePorts();
  let code;
  if (ui.editorTab === 'blocks') {
    try {
      code = generatePython(workspace);
      preview.textContent = code;
    } catch (err) {
      emit('log', { text: `Block error: ${err.message}`, level: 'error' });
      return;
    }
  } else {
    code = pyEditor.value;
  }
  persistNow();
  setRunning(true);
  emit('log', { text: '— running —', level: 'info' });
  // Blocks generate SPIKE 2-style code (Skulpt). Hand-written SPIKE 3 code (hub/runloop/
  // motor_pair imports) runs on the Pyodide runtime — real CPython with async/await.
  const useSpike3 = ui.editorTab !== 'blocks' && isSpike3(code);
  runHandle = useSpike3 ? runPython3(code, engine) : runPython(code, engine);
  const res = await runHandle.promise;
  runHandle = null;
  engine.cancelAll('program-end'); // a real hub stops its motors when the program ends
  setRunning(false, res.stopped ? 'stopped' : 'finished');
  if (!res.ok) emit('log', { text: res.error, level: 'error' });
  else emit('log', { text: res.stopped ? '— stopped —' : '— finished —', level: 'info' });
}
function stop() {
  if (runHandle) runHandle.stop();
  engine.cancelAll('stop');
  silenceBeeps();
}
$('btn-run').onclick = run;
$('btn-stop').onclick = stop;
$('btn-reset').onclick = () => { stop(); engine.reset(); view2d.render(); };

// ---------- speed ----------
const speedSlider = $('speed-slider');
function applySpeed(expo) {
  speed = Math.pow(2, expo);
  ui.speed = speed;
  $('speed-label').textContent = `${parseFloat(speed.toFixed(2))}×`;
  saveUi();
}
speedSlider.value = String(Math.log2(speed));
speedSlider.oninput = () => applySpeed(parseFloat(speedSlider.value));
applySpeed(parseFloat(speedSlider.value));

// ---------- maps ----------
const selMap = $('sel-map');
let mapIndex = { maps: [] };

function customMaps() { return lsGetJson(LS.customMaps, []); }

function rebuildMapOptions() {
  selMap.innerHTML = '';
  const ogPreset = document.createElement('optgroup');
  ogPreset.label = 'Preset maps';
  for (const m of mapIndex.maps) {
    const opt = document.createElement('option');
    opt.value = `file:${m.file}`;
    opt.textContent = m.name;
    ogPreset.appendChild(opt);
  }
  selMap.appendChild(ogPreset);
  const customs = customMaps();
  if (customs.length) {
    const ogCustom = document.createElement('optgroup');
    ogCustom.label = 'My maps';
    customs.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = `custom:${i}`;
      opt.textContent = c.name;
      ogCustom.appendChild(opt);
    });
    selMap.appendChild(ogCustom);
  }
  if (ui.mapFile && [...selMap.options].some((o) => o.value === ui.mapFile)) selMap.value = ui.mapFile;
}
// "Save as…" in the map editor only writes localStorage, so refresh right before the list opens.
selMap.addEventListener('mousedown', rebuildMapOptions);

async function loadMapByValue(value) {
  try {
    if (value.startsWith('file:')) {
      const file = value.slice(5);
      const res = await fetch(`maps/${file}`);
      engine.loadMap(await res.json());
      ui.mapFile = value;
    } else if (value.startsWith('custom:')) {
      const c = customMaps()[parseInt(value.slice(7), 10)];
      if (c) { engine.loadMap(c.map); ui.mapFile = value; }
    }
  } catch (err) {
    emit('log', { text: `Could not load map (${err.message}) — using fallback`, level: 'error' });
    engine.loadMap(fallbackMap());
  }
  saveUi();
  view2d.fitToMap();
}
selMap.onchange = () => loadMapByValue(selMap.value);

// Map editor "Save as…" adds to localStorage then emits map-changed; refresh the list.
on('map-changed', () => rebuildMapOptions());

// ---------- map editor toggle ----------
let editingMap = false;
$('btn-edit-map').onclick = () => {
  editingMap = !editingMap;
  $('btn-edit-map').classList.toggle('active', editingMap);
  $('mapeditor-toolbar').classList.toggle('hidden', !editingMap);
  if (editingMap) {
    activateSimTab('2d');
    mapEditor.activate();
  } else {
    mapEditor.deactivate();
  }
};

// ---------- fit / follow ----------
$('btn-fit').onclick = () => {
  if (ui.simTab === '3d') view3d.homeCamera();
  else view2d.fitToMap();
};
let follow = false;
$('btn-follow').onclick = () => {
  follow = !follow;
  $('btn-follow').classList.toggle('active', follow);
  view3d.setFollow(follow);
};

// ---------- examples ----------
const selExample = $('sel-example');
async function loadExamples() {
  try {
    const res = await fetch('examples/index.json');
    const idx = await res.json();
    const ogPy = document.createElement('optgroup');
    ogPy.label = 'Python';
    for (const e of idx.python || []) {
      const opt = document.createElement('option');
      opt.value = `python:${e.file}`;
      opt.textContent = e.name;
      ogPy.appendChild(opt);
    }
    const ogBl = document.createElement('optgroup');
    ogBl.label = 'Blocks';
    for (const e of idx.blocks || []) {
      const opt = document.createElement('option');
      opt.value = `blocks:${e.file}`;
      opt.textContent = e.name;
      ogBl.appendChild(opt);
    }
    selExample.appendChild(ogPy);
    selExample.appendChild(ogBl);
  } catch {
    emit('log', { text: 'No examples index found', level: 'info' });
  }
}
selExample.onchange = async () => {
  const v = selExample.value;
  selExample.value = '';
  if (!v) return;
  try {
    if (v.startsWith('python:')) {
      const res = await fetch(`examples/python/${v.slice(7)}`);
      pyEditor.value = await res.text();
      activateEditorTab('python');
    } else if (v.startsWith('blocks:')) {
      const res = await fetch(`examples/blocks/${v.slice(7)}`);
      deserialize(workspace, await res.json());
      activateEditorTab('blocks');
      refreshPreview();
    }
  } catch (err) {
    emit('log', { text: `Could not load example: ${err.message}`, level: 'error' });
  }
};

// ---------- persistence ----------
function saveUi() { lsSetJson(LS.ui, ui); }
function persistNow() {
  try { lsSetJson(LS.blocks, serialize(workspace)); } catch { /* ignore */ }
  try { localStorage.setItem(LS.python, pyEditor.value); } catch { /* ignore */ }
}
setInterval(persistNow, 5000);
window.addEventListener('beforeunload', persistNow);
// builder persists the robot itself on Apply (see contract)

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  // engine.step() clamps a single call to 0.25 s of sim time. At high speeds (up
  // to 8×) or on a slow frame, dt*speed can exceed that, so feed it in chunks
  // instead of silently dropping the overflow.
  let simDt = dt * speed;
  while (simDt > 1e-6) {
    const chunk = Math.min(simDt, 0.25);
    engine.step(chunk);
    simDt -= chunk;
  }
  if (ui.simTab === '2d') view2d.render();
  requestAnimationFrame(frame);
}

// ---------- boot ----------
(async function boot() {
  try {
    const res = await fetch('maps/index.json');
    mapIndex = await res.json();
  } catch {
    mapIndex = { maps: [] };
  }
  rebuildMapOptions();
  const startMap = ui.mapFile && [...selMap.querySelectorAll('option')].some((o) => o.value === ui.mapFile)
    ? ui.mapFile
    : (mapIndex.maps[0] ? `file:${mapIndex.maps[0].file}` : null);
  if (startMap) {
    selMap.value = startMap;
    await loadMapByValue(startMap);
  } else {
    engine.loadMap(fallbackMap());
    view2d.fitToMap();
  }
  await loadExamples();
  activateEditorTab(ui.editorTab === 'python' ? 'python' : 'blocks');
  activateSimTab(['2d', '3d', 'build'].includes(ui.simTab) ? ui.simTab : '2d');
  window.addEventListener('resize', () => {
    view2d.resize();
    view3d.resize();
    try { builder3d.resize(); } catch (e) { /* not built yet */ }
    if (ui.editorTab === 'blocks') Blockly.svgResize(workspace);
  });
  const challenges = new ChallengeManager(engine, {
    selectEl: $('sel-challenge'),
    setMap: (m) => { engine.loadMap(m); view2d.fitToMap(); },
    setRobot: (r) => { engine.loadRobot(r); },
    setPython: (c) => { pyEditor.value = c; },
    activatePythonTab: () => activateEditorTab('python'),
  });
  challenges.loadIndex().catch(() => {});
  emit('log', { text: 'SpikeSim ready. Drag blocks or write Python, then press Run.', level: 'info' });
  requestAnimationFrame(frame);
  // Warm up the Python runtime while the user reads the screen.
  setTimeout(() => preloadPyodide().catch(() => {}), 2000);
  // Debug/power-user handle (also used by automated tests).
  window.spikesim = { engine, view2d, view3d, workspace, challenges, builder3d, getSpeed: () => speed };
  help.showWelcome(); // first-run overlay; no-ops once dismissed (spikesim.seenWelcome)
})();
