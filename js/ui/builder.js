/**
 * SpikeSim robot/attachment builder panel (docs/CONTRACT.md — AGENT-BUILD).
 *
 * Edits a deep working copy of the robot config. "Apply" validates and pushes the
 * copy into the engine (engine.loadRobot) and saves it to localStorage['spikesim.robot'];
 * "Revert" re-reads the engine's current config. The panel is a plain-DOM form plus a
 * top-down preview canvas with draggable device dots.
 */
import { emit } from '../core/bus.js';
import { presetRobots, defaultRobot } from '../core/defaults.js';

const PORTS = ['A', 'B', 'C', 'D', 'E', 'F'];
const STUD_CM = 0.8; // 1 LEGO stud
const SNAP_CM = 0.4; // half-stud drag snapping
const LS_ROBOT_KEY = 'spikesim.robot';

// ---------------------------------------------------------------- helpers

/**
 * Tiny DOM builder.
 * @param {string} tag
 * @param {object} [attrs] properties ('textContent', 'value', 'className', ...), 'style' object,
 *   or 'onclick'/'oninput'/... functions (wired via addEventListener).
 * @param {Array<Node|string|number|null>} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Build a <select>; onchange receives the selected value string. */
function makeSelect(options, value, onchange) {
  const s = el(
    'select',
    { onchange: (e) => onchange(e.target.value) },
    options.map((o) => el('option', { value: o.value, textContent: o.label }))
  );
  s.value = value;
  return s;
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function inRange(v, lo, hi) {
  return isNum(v) && v >= lo && v <= hi;
}

/** Numeric fallback for preview drawing so a half-typed field never breaks the canvas. */
function safe(v, fallback) {
  return isNum(v) ? v : fallback;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function fmtNum(v) {
  return isNum(v) ? String(round2(v)) : '';
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function normHexColor(v) {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#f5c518';
}

function isDriveDevice(d) {
  return d && (d.role === 'drive-left' || d.role === 'drive-right');
}

/** Where a device lives in the robot body frame (attachment motors store it on .attachment). */
function devPos(d) {
  return d.type === 'motor' ? d.attachment : d;
}

/**
 * Validate a robot config; returns one kid-readable message per problem (empty = valid).
 * Rules per contract: unique ports, drive ports set/distinct/motors, cm numbers 1..50,
 * maxDegPerSec 100..2000, accelDegPerSec2 500..10000, at most 6 devices.
 * @param {object} cfg robot config JSON
 * @returns {string[]}
 */
function validateRobot(cfg) {
  const problems = [];
  const ch = (cfg && cfg.chassis) || {};
  const dr = (cfg && cfg.drive) || {};
  const devices = Array.isArray(cfg && cfg.devices) ? cfg.devices : [];

  if (!inRange(ch.lengthCm, 1, 50)) problems.push('Chassis length should be a number from 1 to 50 cm.');
  if (!inRange(ch.widthCm, 1, 50)) problems.push('Chassis width should be a number from 1 to 50 cm.');
  if (!inRange(ch.heightCm, 1, 50)) problems.push('Chassis height should be a number from 1 to 50 cm.');
  if (!inRange(dr.wheelDiameterCm, 1, 50)) problems.push('Wheel diameter should be a number from 1 to 50 cm.');
  if (!inRange(dr.trackWidthCm, 1, 50)) problems.push('Track width should be a number from 1 to 50 cm.');
  if (!inRange(dr.maxDegPerSec, 100, 2000)) problems.push('Max motor speed should be from 100 to 2000 deg/s.');
  if (!inRange(dr.accelDegPerSec2, 500, 10000)) problems.push('Acceleration should be from 500 to 10000 deg/s².');

  if (devices.length > 6) problems.push('A robot can have at most 6 devices (one per port A–F).');

  const seen = new Set();
  for (const d of devices) {
    if (!PORTS.includes(d.port)) problems.push(`A device has port "${d.port}" — ports must be A to F.`);
    else if (seen.has(d.port)) problems.push(`Port ${d.port} is used by more than one device.`);
    seen.add(d.port);
  }

  if (!PORTS.includes(dr.leftPort)) problems.push('Pick a port (A–F) for the left drive motor.');
  if (!PORTS.includes(dr.rightPort)) problems.push('Pick a port (A–F) for the right drive motor.');
  if (PORTS.includes(dr.leftPort) && dr.leftPort === dr.rightPort) {
    problems.push('The left and right drive motors need two different ports.');
  } else {
    for (const [side, port] of [['left', dr.leftPort], ['right', dr.rightPort]]) {
      if (!PORTS.includes(port)) continue;
      const dev = devices.find((d) => d.port === port);
      if (!dev || dev.type !== 'motor') problems.push(`Port ${port} (${side} drive) needs a motor on it.`);
    }
  }

  for (const d of devices) {
    if (d.type === 'motor' && d.role === 'attachment') {
      const a = d.attachment || {};
      if (!inRange(a.lengthCm, 1, 50)) problems.push(`Arm length on port ${d.port} should be from 1 to 50 cm.`);
      if (!isNum(a.x) || !isNum(a.y)) problems.push(`Arm mount x and y on port ${d.port} must be numbers.`);
    } else if (d.type === 'color' || d.type === 'distance' || d.type === 'force') {
      if (!isNum(d.x) || !isNum(d.y)) problems.push(`Sensor x and y on port ${d.port} must be numbers.`);
      if ((d.type === 'distance' || d.type === 'force') && d.headingDeg !== undefined && !isNum(d.headingDeg)) {
        problems.push(`Facing angle on port ${d.port} must be a number.`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------- panel

/**
 * Robot builder panel. Builds all of its DOM inside hostEl (a scrollable pane).
 * See docs/CONTRACT.md § AGENT-BUILD.
 */
export class BuilderPanel {
  /**
   * @param {HTMLElement} hostEl scrollable host element (#builder-host)
   * @param {import('../core/engine.js').Engine} engine
   */
  constructor(hostEl, engine) {
    this.host = hostEl;
    this.engine = engine;
    this.active = false;
    /** @type {object} working copy of the robot config being edited */
    this.copy = this._safeGetConfig();
    /** @type {string|null} port of the device selected in the preview */
    this.selectedPort = null;
    this.drag = null; // { device } while dragging a preview dot
    this.presetIndex = 0;
    try {
      this.presets = presetRobots();
    } catch {
      this.presets = [];
    }
    this.rowRefs = {}; // port → { tr, xInput?, yInput? }
    this.canvas = null;
    this._geom = null; // preview transform from the last draw (for hit-testing)
    this.refresh();
  }

  /** Show the panel: re-read the engine's robot into a fresh working copy and re-render. */
  activate() {
    this.active = true;
    this.copy = this._safeGetConfig();
    this.selectedPort = null;
    this.drag = null;
    this.refresh();
  }

  /** Hide the panel (no-op besides flagging inactive). */
  deactivate() {
    this.active = false;
    this.drag = null;
  }

  /**
   * Full idempotent re-render of the panel from the working copy.
   * Called on activate/revert/preset-load/import and on structural edits.
   */
  refresh() {
    this.rowRefs = {};
    this.host.textContent = '';
    this.host.append(
      this._buildTopBar(),
      ...this._buildRobotSection(),
      ...this._buildChassisSection(),
      ...this._buildPortsSection(),
      ...this._buildPreviewSection(),
      ...this._buildFileSection()
    );
    this.runValidation();
    this.drawPreview();
    this._highlightRow();
  }

  // ------------------------------------------------------------ apply / revert

  /** Validate the working copy; render problems into the .invalid div, gate the Apply button. */
  runValidation() {
    const problems = validateRobot(this.copy);
    this.problemsEl.textContent = '';
    if (problems.length) {
      for (const p of problems) this.problemsEl.append(el('div', { textContent: '⚠ ' + p }));
    } else {
      this.problemsEl.append(
        el('div', { style: { color: 'var(--run)' }, textContent: '✓ Robot looks good — press Apply to use it.' })
      );
    }
    this.applyBtn.disabled = problems.length > 0;
    return problems;
  }

  /** Apply the working copy: engine.loadRobot + save to localStorage. */
  apply() {
    if (this.runValidation().length) return;
    try {
      this.engine.loadRobot(deepCopy(this.copy));
      try {
        localStorage.setItem(LS_ROBOT_KEY, JSON.stringify(this.copy));
      } catch {
        /* storage blocked/full — the robot is still applied */
      }
      emit('log', { text: `Robot "${this.copy.name || 'My Robot'}" applied.`, level: 'info' });
    } catch (err) {
      this.problemsEl.textContent = '';
      this.problemsEl.append(el('div', { textContent: `⚠ The simulator did not accept this robot: ${err.message}` }));
      emit('log', { text: `Could not apply robot: ${err.message}`, level: 'error' });
    }
  }

  /** Throw away edits: re-read the engine's current robot config. */
  revert() {
    this.copy = this._safeGetConfig();
    this.selectedPort = null;
    this.refresh();
  }

  _safeGetConfig() {
    try {
      const cfg = this.engine.getRobotConfig();
      if (cfg && typeof cfg === 'object') return cfg;
    } catch {
      /* fall through to default */
    }
    return defaultRobot();
  }

  /** Light update after a numeric field edit (keeps input focus — no full re-render). */
  _afterFieldChange() {
    this.runValidation();
    this.drawPreview();
  }

  // ------------------------------------------------------------ top bar

  _buildTopBar() {
    this.applyBtn = el('button', {
      className: 'primary',
      textContent: '✓ Apply to robot',
      title: 'Use this robot in the simulator (also saves it)',
      onclick: () => this.apply(),
    });
    const revertBtn = el('button', {
      textContent: '↩ Revert',
      title: 'Throw away edits and reload the current robot',
      onclick: () => this.revert(),
    });
    this.problemsEl = el('div', { className: 'invalid' });
    return el(
      'div',
      {
        style: {
          position: 'sticky',
          top: '0',
          zIndex: '3',
          background: 'var(--panel)',
          margin: '-14px -14px 8px',
          padding: '10px 14px 8px',
          borderBottom: '1px solid var(--border)',
        },
      },
      [el('div', { className: 'row', style: { margin: '0 0 4px' } }, [this.applyBtn, revertBtn]), this.problemsEl]
    );
  }

  // ------------------------------------------------------------ section 1: name + presets

  _buildRobotSection() {
    const nameInput = el('input', {
      type: 'text',
      value: this.copy.name || '',
      placeholder: 'My Robot',
      style: { width: '170px' },
      oninput: (e) => {
        this.copy.name = e.target.value;
      },
    });
    this.presetSel = makeSelect(
      this.presets.map((p, i) => ({ value: String(i), label: p.name })),
      String(Math.min(this.presetIndex, Math.max(0, this.presets.length - 1))),
      (v) => {
        this.presetIndex = parseInt(v, 10) || 0;
      }
    );
    const loadBtn = el('button', {
      textContent: 'Load preset',
      title: 'Replace the editor with this preset (press Apply to use it)',
      onclick: () => this._loadPreset(),
    });
    return [
      el('h3', { textContent: 'Robot' }),
      el('div', { className: 'row' }, [
        el('label', {}, ['name ', nameInput]),
        el('label', {}, ['presets ', this.presetSel]),
        loadBtn,
      ]),
    ];
  }

  _loadPreset() {
    const p = this.presets[this.presetIndex];
    if (!p) {
      emit('log', { text: 'No presets available.', level: 'error' });
      return;
    }
    this.copy = deepCopy(p.config);
    if (!this.copy.name) this.copy.name = p.name;
    this.selectedPort = null;
    this.refresh();
  }

  // ------------------------------------------------------------ section 2: chassis & drive

  _numField(labelText, getObj, key, opts = {}) {
    const input = el('input', {
      type: 'number',
      step: String(opts.step ?? 0.1),
      value: fmtNum(getObj()[key]),
      style: { width: (opts.width ?? 64) + 'px' },
      title: opts.title || '',
      oninput: (e) => {
        getObj()[key] = parseFloat(e.target.value);
        this._afterFieldChange();
      },
    });
    return { wrap: el('label', {}, [labelText + ' ', input]), input };
  }

  _buildChassisSection() {
    const ch = () => this.copy.chassis;
    const dr = () => this.copy.drive;
    const colorInput = el('input', {
      type: 'color',
      value: normHexColor(this.copy.chassis.color),
      title: 'Chassis color',
      style: {
        width: '38px',
        height: '28px',
        padding: '1px',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        background: 'var(--panel-2)',
        cursor: 'pointer',
      },
      oninput: (e) => {
        this.copy.chassis.color = e.target.value;
        this._afterFieldChange();
      },
    });

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
    const portSelect = (labelText, key) => {
      const cur = this.copy.drive[key];
      const opts = PORTS.map((p) => ({ value: p, label: p }));
      if (!PORTS.includes(cur)) opts.unshift({ value: '', label: '—' });
      return el('label', {}, [
        `${labelText} `,
        makeSelect(opts, PORTS.includes(cur) ? cur : '', (v) => {
          this.copy.drive[key] = v;
          this._normalizeDriveDevices();
          this.refresh();
        }),
      ]);
    };

    return [
      el('h3', { textContent: 'Chassis & drive' }),
      el('div', { className: 'row' }, [
        this._numField('length cm', ch, 'lengthCm', { step: 0.5 }).wrap,
        this._numField('width cm', ch, 'widthCm', { step: 0.5 }).wrap,
        this._numField('height cm', ch, 'heightCm', { step: 0.5 }).wrap,
        el('label', {}, ['color ', colorInput]),
      ]),
      el('div', { className: 'row' }, [
        this._numField('wheel ⌀ cm', dr, 'wheelDiameterCm', { step: 0.1 }).wrap,
        this._numField('track width cm', dr, 'trackWidthCm', { step: 0.1, title: 'Distance between the two wheels' }).wrap,
      ]),
      el('div', { className: 'row' }, [
        this._numField('max speed deg/s', dr, 'maxDegPerSec', { step: 10, width: 74 }).wrap,
        this._numField('accel deg/s²', dr, 'accelDegPerSec2', { step: 100, width: 74 }).wrap,
      ]),
      el('div', { className: 'row' }, [
        portSelect('move motor L (left wheel)', 'leftPort'),
        portSelect('move motor R (right wheel)', 'rightPort'),
      ]),
      el('div', { className: 'row' }, [el('label', {}, ['3D model file (optional) ', modelInput])]),
    ];
  }

  /**
   * Keep the devices list consistent with the chosen drive ports: the drive ports get
   * plain drive motors, and any other device sitting on those ports is removed.
   */
  _normalizeDriveDevices() {
    const { drive } = this.copy;
    const rest = (this.copy.devices || []).filter(
      (d) => !isDriveDevice(d) && d.port !== drive.leftPort && d.port !== drive.rightPort
    );
    const head = [];
    if (PORTS.includes(drive.leftPort)) head.push({ port: drive.leftPort, type: 'motor', role: 'drive-left' });
    if (PORTS.includes(drive.rightPort)) head.push({ port: drive.rightPort, type: 'motor', role: 'drive-right' });
    this.copy.devices = head.concat(rest);
  }

  // ------------------------------------------------------------ section 3: ports table

  _buildPortsSection() {
    const table = el('table', {}, [
      el('tr', {}, [
        el('th', { textContent: 'Port' }),
        el('th', { textContent: 'Device' }),
        el('th', { textContent: 'Settings' }),
      ]),
      ...PORTS.map((port) => this._buildPortRow(port)),
    ]);
    return [el('h3', { textContent: 'Ports A–F' }), table];
  }

  _buildPortRow(port) {
    const tr = el('tr');
    const refs = { tr };
    this.rowRefs[port] = refs;
    tr.append(el('td', {}, [el('b', { textContent: port })]));

    const { drive } = this.copy;
    if (port === drive.leftPort || port === drive.rightPort) {
      const side = port === drive.leftPort ? 'left' : 'right';
      tr.append(
        el('td', {
          colSpan: 2,
          style: { color: 'var(--text-dim)', fontStyle: 'italic' },
          textContent: `${side} drive motor (set above)`,
        })
      );
      return tr;
    }

    const device = (this.copy.devices || []).find((d) => d.port === port && !isDriveDevice(d));
    const typeSel = makeSelect(
      [
        { value: '', label: '—' },
        { value: 'motor', label: 'motor (attachment)' },
        { value: 'color', label: 'color' },
        { value: 'distance', label: 'distance' },
        { value: 'force', label: 'force' },
      ],
      device ? device.type : '',
      (v) => this._setPortType(port, v)
    );
    tr.append(el('td', {}, [typeSel]));

    const params = el('td');
    if (device) this._buildParamInputs(params, device, refs);
    tr.append(params);
    return tr;
  }

  _buildParamInputs(td, device, refs) {
    const mk = (labelText, obj, key, step = 0.2, width = 56) => {
      const input = el('input', {
        type: 'number',
        step: String(step),
        value: fmtNum(obj[key]),
        style: { width: width + 'px' },
        oninput: (e) => {
          obj[key] = parseFloat(e.target.value);
          this._afterFieldChange();
        },
      });
      td.append(el('label', { style: { marginRight: '8px' } }, [labelText + ' ', input]));
      return input;
    };

    if (device.type === 'motor') {
      // Arm attachment: length + mount point in the robot body frame.
      device.attachment = device.attachment || { kind: 'arm', lengthCm: 8, x: 6, y: 0 };
      mk('arm cm', device.attachment, 'lengthCm', 0.5);
      refs.xInput = mk('x', device.attachment, 'x');
      refs.yInput = mk('y', device.attachment, 'y');
    } else {
      refs.xInput = mk('x', device, 'x');
      refs.yInput = mk('y', device, 'y');
      if (device.type === 'distance' || device.type === 'force') {
        if (!isNum(device.headingDeg)) device.headingDeg = 0;
        mk('face °', device, 'headingDeg', 5);
      }
    }
  }

  _setPortType(port, type) {
    this.copy.devices = (this.copy.devices || []).filter((d) => d.port !== port);
    if (type === 'motor') {
      this.copy.devices.push({
        port,
        type: 'motor',
        role: 'attachment',
        attachment: { kind: 'arm', lengthCm: 8, x: 6, y: 0 },
      });
    } else if (type === 'color') {
      this.copy.devices.push({ port, type: 'color', x: 6, y: 0 });
    } else if (type === 'distance') {
      this.copy.devices.push({ port, type: 'distance', x: 7.5, y: 0, headingDeg: 0 });
    } else if (type === 'force') {
      this.copy.devices.push({ port, type: 'force', x: 7.5, y: 0, headingDeg: 0 });
    }
    this.selectedPort = type ? port : null;
    this.refresh();
  }

  // ------------------------------------------------------------ section 4: preview canvas

  _buildPreviewSection() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = el('canvas', {
      width: Math.round(320 * this.dpr),
      height: Math.round(260 * this.dpr),
      style: { width: '320px', height: '260px', cursor: 'crosshair', touchAction: 'none' },
    });
    canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    this.canvas = canvas;
    return [
      el('h3', { textContent: 'Top-down preview' }),
      el('div', { className: 'row' }, [canvas]),
      el('div', {
        className: 'row',
        style: { color: 'var(--text-dim)', fontSize: '12px' },
        textContent: 'Front is up. Drag a dot to move a device (snaps to half-studs). Grid = LEGO studs (0.8 cm).',
      }),
    ];
  }

  /** Placeable (draggable) devices: everything except the two drive motors. */
  _placeableDevices() {
    return (this.copy.devices || []).filter((d) => !isDriveDevice(d) && devPos(d));
  }

  /** Redraw the preview canvas from the working copy. Called on every change. */
  drawPreview() {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = 320;
    const H = 260;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cfg = this.copy;
    const L = safe(cfg.chassis && cfg.chassis.lengthCm, 14);
    const Wd = safe(cfg.chassis && cfg.chassis.widthCm, 11);
    const track = safe(cfg.drive && cfg.drive.trackWidthCm, Wd);
    const wheelD = safe(cfg.drive && cfg.drive.wheelDiameterCm, 5.6);
    const chassisColor = normHexColor(cfg.chassis && cfg.chassis.color);

    // Fit chassis + drag margin. Body frame: +x forward (screen up), +y right (screen right).
    const spanX = L / 2 + 6;
    const spanY = Math.max(Wd / 2, track / 2 + 2.5) + 6;
    const scale = Math.min((W - 24) / (2 * spanY), (H - 24) / (2 * spanX));
    const cx = W / 2;
    const cy = H / 2;
    this._geom = { scale, cx, cy };
    const S = (bx, by) => [cx + by * scale, cy - bx * scale];

    // chassis
    const [rx, ry] = S(L / 2, -Wd / 2);
    const rw = Wd * scale;
    const rh = L * scale;
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = chassisColor;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = chassisColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    // stud grid (0.8 cm), clipped to the chassis
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(35,50,90,0.15)';
    ctx.beginPath();
    for (let v = 0; v <= Wd / 2 + 0.001; v += STUD_CM) {
      for (const s of v === 0 ? [1] : [1, -1]) {
        const x = cx + s * v * scale;
        ctx.moveTo(x, ry);
        ctx.lineTo(x, ry + rh);
      }
    }
    for (let v = 0; v <= L / 2 + 0.001; v += STUD_CM) {
      for (const s of v === 0 ? [1] : [1, -1]) {
        const y = cy - s * v * scale;
        ctx.moveTo(rx, y);
        ctx.lineTo(rx + rw, y);
      }
    }
    ctx.stroke();
    ctx.restore();

    // wheels at (0, ±track/2), 2 cm wide, wheel-diameter long
    ctx.fillStyle = '#2a2e3a';
    ctx.strokeStyle = '#0a0b10';
    ctx.lineWidth = 1.5;
    ctx.font = '10px "Segoe UI", sans-serif';
    for (const side of [-1, 1]) {
      const [wx, wy] = S(wheelD / 2, side * (track / 2) - 1);
      ctx.fillRect(wx, wy, 2 * scale, wheelD * scale);
      ctx.strokeRect(wx, wy, 2 * scale, wheelD * scale);
      const port = side < 0 ? cfg.drive && cfg.drive.leftPort : cfg.drive && cfg.drive.rightPort;
      if (PORTS.includes(port)) {
        ctx.fillStyle = '#77839A';
        ctx.fillText(port, wx + scale - 3, wy + wheelD * scale + 11);
        ctx.fillStyle = '#2a2e3a';
      }
    }

    // forward chevron near the front edge
    ctx.beginPath();
    const [a0, a1] = S(L / 2 - 1, 0);
    const [b0, b1] = S(L / 2 - 3, -1.4);
    const [c0, c1] = S(L / 2 - 3, 1.4);
    ctx.moveTo(a0, a1);
    ctx.lineTo(b0, b1);
    ctx.lineTo(c0, c1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fill();

    // devices (12px dots; drive motors are drawn as the wheels above)
    for (const d of this._placeableDevices()) {
      const pos = devPos(d);
      if (!isNum(pos.x) || !isNum(pos.y)) continue;
      const [sx, sy] = S(pos.x, pos.y);

      if (d.type === 'motor') {
        // arm beam outline extending forward from the mount (#E5B400 = accent
        // yellow darkened for contrast on the light canvas, as in the 2D view)
        const len = safe(d.attachment.lengthCm, 8);
        const [ox, oy] = S(pos.x + len, pos.y - 0.8);
        ctx.strokeStyle = '#E5B400';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ox, oy, 1.6 * scale, len * scale);
        // yellow diamond at the mount
        ctx.beginPath();
        ctx.moveTo(sx, sy - 6);
        ctx.lineTo(sx + 6, sy);
        ctx.lineTo(sx, sy + 6);
        ctx.lineTo(sx - 6, sy);
        ctx.closePath();
        ctx.fillStyle = '#E5B400';
        ctx.fill();
      } else if (d.type === 'color') {
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#22d3ee';
        ctx.fill();
        ctx.strokeStyle = 'rgba(35,42,54,0.45)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (d.type === 'distance') {
        // facing tick
        const h = (safe(d.headingDeg, 0) * Math.PI) / 180;
        const [tx, ty] = S(pos.x + (Math.cos(h) * 11) / scale, pos.y + (Math.sin(h) * 11) / scale);
        ctx.strokeStyle = 'rgba(35,42,54,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        // white housing needs an outline to be visible on the light canvas
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sx - 6, sy - 6, 12, 12);
        ctx.strokeStyle = '#232A36';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx - 6, sy - 6, 12, 12);
        // two black "eyes" — the SPIKE distance-sensor identity cue
        ctx.fillStyle = '#232A36';
        ctx.beginPath();
        ctx.moveTo(sx - 1, sy);
        ctx.arc(sx - 3, sy, 2, 0, Math.PI * 2);
        ctx.moveTo(sx + 5, sy);
        ctx.arc(sx + 3, sy, 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (d.type === 'force') {
        const h = (safe(d.headingDeg, 0) * Math.PI) / 180;
        const [tx, ty] = S(pos.x + (Math.cos(h) * 11) / scale, pos.y + (Math.sin(h) * 11) / scale);
        ctx.strokeStyle = 'rgba(35,42,54,0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#e5534b';
        ctx.fill();
      }

      if (d.port === this.selectedPort) {
        ctx.strokeStyle = '#E5B400';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(sx, sy, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = '#77839A';
      ctx.fillText(String(d.port || '?'), sx + 8, sy - 7);
    }
  }

  _canvasPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _onPointerDown(e) {
    if (!this._geom) return;
    const [px, py] = this._canvasPoint(e);
    const { scale, cx, cy } = this._geom;
    const list = this._placeableDevices();
    let hit = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const pos = devPos(list[i]);
      if (!isNum(pos.x) || !isNum(pos.y)) continue;
      const sx = cx + pos.y * scale;
      const sy = cy - pos.x * scale;
      if (Math.hypot(px - sx, py - sy) <= 9) {
        hit = list[i];
        break;
      }
    }
    this.selectedPort = hit ? hit.port : null;
    this._highlightRow();
    if (hit) {
      this.drag = { device: hit };
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    this.drawPreview();
  }

  _onPointerMove(e) {
    if (!this.drag || !this._geom) return;
    const [px, py] = this._canvasPoint(e);
    const { scale, cx, cy } = this._geom;
    const L = safe(this.copy.chassis && this.copy.chassis.lengthCm, 14);
    const Wd = safe(this.copy.chassis && this.copy.chassis.widthCm, 11);
    // screen → body frame, snap to half-studs, clamp to chassis ± 4 cm
    let bx = (cy - py) / scale;
    let by = (px - cx) / scale;
    bx = clamp(round2(Math.round(bx / SNAP_CM) * SNAP_CM), -(L / 2 + 4), L / 2 + 4);
    by = clamp(round2(Math.round(by / SNAP_CM) * SNAP_CM), -(Wd / 2 + 4), Wd / 2 + 4);
    const pos = devPos(this.drag.device);
    pos.x = bx;
    pos.y = by;
    // live-update the matching table inputs without a full re-render
    const refs = this.rowRefs[this.drag.device.port];
    if (refs && refs.xInput) refs.xInput.value = String(bx);
    if (refs && refs.yInput) refs.yInput.value = String(by);
    this.runValidation();
    this.drawPreview();
  }

  _onPointerUp(e) {
    if (this.drag) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already gone */
      }
      this.drag = null;
    }
  }

  _highlightRow() {
    for (const port of PORTS) {
      const refs = this.rowRefs[port];
      if (refs && refs.tr) refs.tr.style.background = port === this.selectedPort ? 'rgba(245,197,24,0.10)' : '';
    }
  }

  // ------------------------------------------------------------ section 5: import / export

  _buildFileSection() {
    const fileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      style: { display: 'none' },
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._importFile(f);
        e.target.value = '';
      },
    });
    const exportBtn = el('button', {
      textContent: '⤓ Export JSON',
      title: 'Download this robot as robot.json',
      onclick: () => this._exportJson(),
    });
    const importBtn = el('button', {
      textContent: '⤒ Import JSON',
      title: 'Load a robot.json file into the editor',
      onclick: () => fileInput.click(),
    });
    return [
      el('h3', { textContent: 'Save / load' }),
      el('div', { className: 'row' }, [exportBtn, importBtn, fileInput]),
    ];
  }

  /**
   * Gentle fixup for imported configs so the locked drive rows in the ports table
   * stay editable-by-dropdown: for each valid drive port, add the drive motor if the
   * port is empty, or fix a motor's role if it points the wrong way. Never deletes
   * devices — real conflicts (e.g. a sensor on a drive port) are left for validation.
   * @param {object} json robot config being imported (mutated in place)
   */
  _reconcileDriveMotors(json) {
    const dr = json.drive || {};
    for (const [role, port] of [['drive-left', dr.leftPort], ['drive-right', dr.rightPort]]) {
      if (!PORTS.includes(port)) continue;
      const dev = json.devices.find((d) => d.port === port);
      if (!dev) json.devices.push({ port, type: 'motor', role });
      else if (dev.type === 'motor' && dev.role !== role) dev.role = role;
    }
    // Drop stray drive roles on ports that aren't the configured drive ports.
    for (const d of json.devices) {
      if (isDriveDevice(d) && d.port !== dr.leftPort && d.port !== dr.rightPort) d.role = 'attachment';
    }
  }

  _exportJson() {
    const blob = new Blob([JSON.stringify(this.copy, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'robot.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async _importFile(file) {
    try {
      const json = JSON.parse(await file.text());
      if (!json || typeof json !== 'object' || typeof json.chassis !== 'object' || typeof json.drive !== 'object') {
        throw new Error('it is missing the "chassis" or "drive" part');
      }
      json.devices = Array.isArray(json.devices) ? json.devices : [];
      if (typeof json.name !== 'string') json.name = file.name.replace(/\.json$/i, '');
      this._reconcileDriveMotors(json);
      this.copy = json;
      this.selectedPort = null;
      this.refresh(); // validation problems (if any) show in the panel; Apply stays disabled until fixed
      emit('log', { text: `Imported robot "${json.name || file.name}". Check it, then press Apply.`, level: 'info' });
    } catch (err) {
      emit('log', { text: `Could not import that robot file — ${err.message}.`, level: 'error' });
      if (this.problemsEl) {
        this.problemsEl.textContent = '';
        this.problemsEl.append(
          el('div', { textContent: '⚠ Could not read that file as a robot. Is it a robot.json exported from SpikeSim?' })
        );
      }
    }
  }
}
