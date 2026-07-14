/**
 * MapEditor — map editing tools layered on top of View2D.
 *
 * How it cooperates with View2D:
 * - While active it listens on View2D's canvas in the CAPTURE phase and calls
 *   stopPropagation() for every pointer event its active tool consumes, so
 *   View2D's own robot-drag/pan handlers never see those events. The select
 *   tool deliberately does NOT consume clicks on empty space, so panning and
 *   wheel-zoom keep working while editing.
 * - Selection handles and in-progress shapes are drawn through
 *   `view2d.overlay.draw` (screen space, using view.worldToScreen).
 *
 * Editing model:
 * - Works on a deep copy of `engine.getMapJson()`. Every committed edit calls
 *   `engine.loadMap(copy)` (which re-rasters and resets the robot — fine in
 *   edit mode) and then re-copies from the engine to stay in sync.
 * - Undo is a single-level snapshot taken just before each commit.
 *
 * Keyboard: ESC cancels an in-progress line/drag (or clears the selection),
 * Enter or double-click finishes a line, DEL/Backspace deletes the selection.
 */
import { emit, on } from '../core/bus.js';

const DEG = Math.PI / 180;
const ACCENT = '#4cc2ff';
const LS_CUSTOM_MAPS = 'spikesim.maps.custom';
const WALL_HEIGHT_CM = 10;
const OBSTACLE_HEIGHT_CM = 8;

/** [id, button label, tooltip] for the tool buttons, in toolbar order. */
const TOOLS = [
  ['select', 'Select', 'Select & drag walls, zones and obstacles. DEL deletes.'],
  ['wall', 'Wall', 'Drag to draw a wall segment (hold SHIFT for straight walls)'],
  ['line', 'Line', 'Click to add points. Enter or double-click finishes, Esc cancels.'],
  ['zone', 'Zone', 'Drag a colored zone rectangle (flat paint, no collision)'],
  ['obstacle', 'Obstacle', 'Drag a solid box the robot can bump into (tick "Movable" for a pushable crate)'],
  ['start', 'Start', 'Click to place the start position, drag to aim it'],
  ['erase', 'Erase', 'Click a wall, line, zone or obstacle to remove it'],
];

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
/** Round to 0.1 cm so edited maps stay tidy when exported. */
function r1(v) {
  return Math.round(v * 10) / 10;
}
/** Distance from point (px,py) to segment (x1,y1)-(x2,y2), all in cm. */
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
/** Point-in-rect test with a tolerance ring around the edges. */
function inRect(px, py, r, tol = 0) {
  return px >= r.x - tol && px <= r.x + r.w + tol && py >= r.y - tol && py <= r.y + r.h + tol;
}

/**
 * Map editing tools drawn on top of a View2D instance.
 */
export class MapEditor {
  /**
   * @param {import('./view2d.js').View2D} view2d
   * @param {import('../core/engine.js').Engine} engine
   * @param {HTMLElement} toolbarEl container to build the editor buttons in
   *   (app.js shows/hides it; the editor only fills it once, in the constructor)
   */
  constructor(view2d, engine, toolbarEl) {
    this.view = view2d;
    this.engine = engine;
    this.toolbarEl = toolbarEl;

    /** Active tool id (one of the TOOLS ids). */
    this.tool = 'select';
    /** Working deep copy of the engine's map JSON (null until activate()). */
    this.map = null;

    this._active = false;
    this._undo = null;        // single-level snapshot (state before the last edit)
    this._selection = null;   // {kind:'walls'|'zones'|'obstacles', index}
    this._gesture = null;     // in-progress pointer drag
    this._pendingLine = null; // {points:[[x,y],...]} while the line tool collects clicks
    this._cursor = null;      // last pointer position in world cm (for previews)
    this._committing = false; // guards our own 'map-changed' echo
    this._offMapChanged = null;

    // Bound handlers so removeEventListener matches addEventListener.
    this._onDown = this._onPointerDown.bind(this);
    this._onMove = this._onPointerMove.bind(this);
    this._onUp = this._onPointerUp.bind(this);
    this._onCancel = this._onPointerCancel.bind(this);
    this._onDbl = this._onDblClick.bind(this);
    this._onKey = this._onKeyDown.bind(this);

    this._els = {};
    this._buildToolbar();
  }

  /** Start editing: sync the working copy, hook input listeners and the overlay. */
  activate() {
    if (this._active) return;
    this._active = true;
    this.map = this.engine.getMapJson();
    this._selection = null;
    this._pendingLine = null;
    this._gesture = null;
    this._undo = null; // the map may have changed while inactive — old snapshots are stale
    this._els.undo.disabled = true;

    const c = this.view.canvas;
    const opts = { capture: true };
    c.addEventListener('pointerdown', this._onDown, opts);
    c.addEventListener('pointermove', this._onMove, opts);
    c.addEventListener('pointerup', this._onUp, opts);
    c.addEventListener('pointercancel', this._onCancel, opts);
    c.addEventListener('dblclick', this._onDbl, opts);
    window.addEventListener('keydown', this._onKey);

    // If the map changes underneath us (user picks another map while editing),
    // re-sync the working copy. Our own commits are guarded by _committing.
    this._offMapChanged = on('map-changed', () => {
      if (this._committing || !this._active) return;
      this.map = this.engine.getMapJson();
      this._selection = null;
      this._pendingLine = null;
      this._gesture = null;
    });

    this.view.overlay.draw = (ctx, view) => this._drawOverlay(ctx, view);
    this._setTool(this.tool);
  }

  /** Stop editing: unhook everything and clear the overlay. */
  deactivate() {
    if (!this._active) return;
    this._active = false;

    const c = this.view.canvas;
    const opts = { capture: true };
    c.removeEventListener('pointerdown', this._onDown, opts);
    c.removeEventListener('pointermove', this._onMove, opts);
    c.removeEventListener('pointerup', this._onUp, opts);
    c.removeEventListener('pointercancel', this._onCancel, opts);
    c.removeEventListener('dblclick', this._onDbl, opts);
    window.removeEventListener('keydown', this._onKey);
    if (this._offMapChanged) {
      this._offMapChanged();
      this._offMapChanged = null;
    }

    this._abortGesture();
    this._pendingLine = null;
    this._selection = null;
    this.view.overlay.draw = null;
  }

  // ------------------------------------------------------------ toolbar

  _buildToolbar() {
    const bar = this.toolbarEl;
    bar.textContent = '';

    const button = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      bar.appendChild(b);
      return b;
    };
    const sep = () => {
      const s = document.createElement('span');
      s.style.cssText = 'width:1px;height:18px;background:rgba(255,255,255,0.15);margin:0 2px;';
      bar.appendChild(s);
    };

    this._els.tools = {};
    for (const [id, label, title] of TOOLS) {
      this._els.tools[id] = button(label, title, () => this._setTool(id));
    }
    sep();

    const colorLabel = document.createElement('label');
    colorLabel.title = 'Color for new lines, zones and obstacles';
    colorLabel.append('Color ');
    const color = document.createElement('input');
    color.type = 'color';
    color.value = '#d94040';
    colorLabel.appendChild(color);
    bar.appendChild(colorLabel);
    this._els.color = color;

    // v1.1: when checked, the Obstacle tool creates pushable crates
    // (obstacles with movable:true — the engine treats them as live boxes).
    const movableLabel = document.createElement('label');
    movableLabel.title = 'New obstacles become crates the robot can push around';
    const movable = document.createElement('input');
    movable.type = 'checkbox';
    movableLabel.appendChild(movable);
    movableLabel.append(' Movable');
    bar.appendChild(movableLabel);
    this._els.movable = movable;

    const widthLabel = document.createElement('label');
    widthLabel.title = 'Line width in cm';
    widthLabel.append('Width ');
    const width = document.createElement('input');
    width.type = 'number';
    width.min = '0.5';
    width.max = '20';
    width.step = '0.5';
    width.value = '2.5';
    widthLabel.appendChild(width);
    bar.appendChild(widthLabel);
    this._els.width = width;

    sep();
    this._els.undo = button('↶ Undo', 'Undo the last edit (one step)', () => this._undoLast());
    this._els.undo.disabled = true;
    button('Clear', 'Remove all walls, lines, zones and obstacles', () => this._clearAll());
    button('Save as…', 'Save this map to your browser (shows up in the Map list)', () => this._saveAs());
    button('Export', 'Download this map as a JSON file', () => this._export());
    button('Import', 'Load a map from a JSON file', () => this._els.file.click());

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.style.display = 'none';
    file.addEventListener('change', () => this._import());
    bar.appendChild(file);
    this._els.file = file;
  }

  _setTool(id) {
    this.tool = id;
    for (const [tid, btn] of Object.entries(this._els.tools)) {
      btn.classList.toggle('active', tid === id);
    }
    // Switching tools abandons anything half-done.
    this._abortGesture();
    this._pendingLine = null;
    if (id !== 'select') this._selection = null;
  }

  // ------------------------------------------------------------ edit plumbing

  /** Take the single-level undo snapshot. Call just before mutating this.map. */
  _snapshot() {
    this._undo = deepCopy(this.map);
    this._els.undo.disabled = false;
  }

  /** Push the working copy into the engine and re-sync (stays a deep copy). */
  _commit() {
    this._committing = true;
    try {
      this.engine.loadMap(this.map);
    } finally {
      this._committing = false;
    }
    this.map = this.engine.getMapJson();
  }

  _undoLast() {
    if (!this._undo || !this._active) return;
    this.map = this._undo;
    this._undo = null;
    this._els.undo.disabled = true;
    this._selection = null;
    this._pendingLine = null;
    this._gesture = null;
    this._commit();
  }

  /** Ensure the named map array exists and return it. */
  _arr(name) {
    if (!Array.isArray(this.map[name])) this.map[name] = [];
    return this.map[name];
  }

  /** @returns {object|null} the map object a selection points at. */
  _objFor(sel) {
    if (!sel || !this.map) return null;
    const arr = this.map[sel.kind];
    return (arr && arr[sel.index]) || null;
  }

  /** Cancel an in-progress drag; rolls back live mutations (move/start). */
  _abortGesture() {
    const g = this._gesture;
    if (!g) return;
    this._gesture = null;
    const mutated = (g.type === 'move' && g.moved) || g.type === 'start';
    if (mutated && this._undo) {
      // Those gestures mutate this.map live before committing — roll back.
      this.map = this._undo;
      this._undo = null;
      this._els.undo.disabled = true;
    }
  }

  _deleteSelection() {
    const sel = this._selection;
    const obj = this._objFor(sel);
    if (!obj) return;
    this._snapshot();
    this.map[sel.kind].splice(sel.index, 1);
    this._selection = null;
    this._commit();
  }

  _clearAll() {
    if (!this.map) return;
    if (!confirm('Remove ALL walls, lines, zones and obstacles from this map?')) return;
    this._snapshot();
    this.map.walls = [];
    this.map.lines = [];
    this.map.zones = [];
    this.map.obstacles = [];
    this._selection = null;
    this._pendingLine = null;
    this._commit();
    emit('log', { text: 'Cleared the map. Undo brings it back.', level: 'info' });
  }

  _saveAs() {
    if (!this.map) return;
    const name = prompt('Save map as…', this.map.name || 'My map');
    if (!name) return;
    const copy = deepCopy(this.map);
    copy.name = name;
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(LS_CUSTOM_MAPS) || '[]');
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
    list.push({ name, map: copy });
    try {
      localStorage.setItem(LS_CUSTOM_MAPS, JSON.stringify(list));
    } catch {
      emit('log', { text: 'Could not save — browser storage is full or blocked.', level: 'error' });
      return;
    }
    emit('log', { text: `Saved map: ${name}`, level: 'info' });
  }

  _export() {
    if (!this.map) return;
    const json = JSON.stringify(this.map, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = String(this.map.name || 'map')
      .toLowerCase()
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'map';
    a.href = url;
    a.download = `${base}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async _import() {
    const file = this._els.file.files && this._els.file.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!json || typeof json !== 'object' || !(json.widthCm > 0) || !(json.heightCm > 0)) {
        throw new Error('that file is not a SpikeSim map (it needs widthCm and heightCm)');
      }
      this._snapshot();
      this._committing = true;
      try {
        this.engine.loadMap(json);
      } finally {
        this._committing = false;
      }
      this.map = this.engine.getMapJson();
      this._selection = null;
      this._pendingLine = null;
      emit('log', { text: `Imported map: ${this.map.name || file.name}`, level: 'info' });
    } catch (err) {
      emit('log', { text: `Could not import that file — ${err.message}`, level: 'error' });
    } finally {
      this._els.file.value = ''; // allow picking the same file again
    }
  }

  // ------------------------------------------------------------ hit testing

  /** World-cm tolerance that feels like ~8 screen px at the current zoom. */
  _tol() {
    return Math.max(0.8, 8 / this.view.pxPerCm);
  }

  /** Hit test for the select tool: walls, then obstacles, then zones. */
  _hitTestSelect(wx, wy) {
    const tol = this._tol();
    const walls = this.map.walls || [];
    for (let i = walls.length - 1; i >= 0; i--) {
      const w = walls[i];
      if (segDist(wx, wy, w.x1, w.y1, w.x2, w.y2) <= tol) return { kind: 'walls', index: i };
    }
    const obstacles = this.map.obstacles || [];
    for (let i = obstacles.length - 1; i >= 0; i--) {
      if (inRect(wx, wy, obstacles[i], tol * 0.5)) return { kind: 'obstacles', index: i };
    }
    const zones = this.map.zones || [];
    for (let i = zones.length - 1; i >= 0; i--) {
      if (inRect(wx, wy, zones[i])) return { kind: 'zones', index: i };
    }
    return null;
  }

  /** Hit test for the erase tool: also finds lines. */
  _hitTestErase(wx, wy) {
    const hit = this._hitTestSelect(wx, wy);
    if (hit && hit.kind !== 'zones') return hit; // prefer lines over big zones
    const tol = this._tol();
    const lines = this.map.lines || [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      const pts = ln.points || [];
      const reach = (ln.widthCm || 2) / 2 + tol;
      for (let s = 0; s < pts.length - 1; s++) {
        if (segDist(wx, wy, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]) <= reach) {
          return { kind: 'lines', index: i };
        }
      }
    }
    return hit;
  }

  // ------------------------------------------------------------ pointer input

  _consume(e, capturePointer) {
    e.stopPropagation();
    e.preventDefault();
    if (capturePointer) {
      try {
        this.view.canvas.setPointerCapture(e.pointerId);
      } catch { /* pointer already gone — fine */ }
    }
  }

  _onPointerDown(e) {
    if (!this._active || !this.map || e.button !== 0) return;
    const [wx, wy] = this.view.screenToWorld(e.clientX, e.clientY);
    this._cursor = [wx, wy];

    switch (this.tool) {
      case 'select': {
        const hit = this._hitTestSelect(wx, wy);
        this._selection = hit;
        if (!hit) return; // empty space → let View2D pan (do NOT consume)
        // Snapshot lazily on the first real movement, so a click that only
        // selects doesn't burn the undo slot or trigger a no-op commit.
        this._gesture = {
          type: 'move', startX: wx, startY: wy,
          orig: deepCopy(this._objFor(hit)), moved: false,
        };
        this._consume(e, true);
        return;
      }
      case 'wall':
        this._gesture = { type: 'wall', x1: wx, y1: wy, x2: wx, y2: wy };
        this._consume(e, true);
        return;
      case 'zone':
      case 'obstacle':
        this._gesture = { type: this.tool, x1: wx, y1: wy, x2: wx, y2: wy };
        this._consume(e, true);
        return;
      case 'start': {
        this._snapshot();
        const old = this.map.start || {};
        this.map.start = { x: r1(wx), y: r1(wy), headingDeg: old.headingDeg || 0 };
        this._gesture = { type: 'start' };
        this._consume(e, true);
        return;
      }
      case 'line': {
        if (!this._pendingLine) this._pendingLine = { points: [] };
        this._pendingLine.points.push([r1(wx), r1(wy)]);
        this._consume(e, false); // no capture — double-click must keep working
        return;
      }
      case 'erase': {
        const hit = this._hitTestErase(wx, wy);
        if (!hit) return; // nothing under the cursor → allow panning
        this._snapshot();
        this.map[hit.kind].splice(hit.index, 1);
        if (this._selection && this._selection.kind === hit.kind && this._selection.index === hit.index) {
          this._selection = null;
        }
        this._commit();
        this._consume(e, false);
        return;
      }
    }
  }

  _onPointerMove(e) {
    if (!this._active || !this.map) return;
    const [wx, wy] = this.view.screenToWorld(e.clientX, e.clientY);
    this._cursor = [wx, wy]; // tracked even without a gesture (line rubber band)
    const g = this._gesture;
    if (!g) return;
    this._consume(e, false);

    switch (g.type) {
      case 'move': {
        const obj = this._objFor(this._selection);
        if (!obj) return;
        const dx = wx - g.startX;
        const dy = wy - g.startY;
        if (!g.moved) {
          if (Math.hypot(dx, dy) < 0.05) return; // ignore sub-pixel jitter
          this._snapshot(); // pre-mutation state, taken once
          g.moved = true;
        }
        if (this._selection.kind === 'walls') {
          obj.x1 = r1(g.orig.x1 + dx);
          obj.y1 = r1(g.orig.y1 + dy);
          obj.x2 = r1(g.orig.x2 + dx);
          obj.y2 = r1(g.orig.y2 + dy);
        } else {
          obj.x = r1(g.orig.x + dx);
          obj.y = r1(g.orig.y + dy);
        }
        return;
      }
      case 'wall': {
        g.x2 = wx;
        g.y2 = wy;
        if (e.shiftKey) {
          // SHIFT snaps the wall to the dominant axis.
          if (Math.abs(g.x2 - g.x1) >= Math.abs(g.y2 - g.y1)) g.y2 = g.y1;
          else g.x2 = g.x1;
        }
        return;
      }
      case 'zone':
      case 'obstacle':
        g.x2 = wx;
        g.y2 = wy;
        return;
      case 'start': {
        const s = this.map.start;
        if (s && Math.hypot(wx - s.x, wy - s.y) > 1) {
          s.headingDeg = Math.round(Math.atan2(wy - s.y, wx - s.x) / DEG);
        }
        return;
      }
    }
  }

  _onPointerUp(e) {
    if (!this._active || !this.map || !this._gesture) return;
    const g = this._gesture;
    this._gesture = null;
    this._consume(e, false);
    try {
      this.view.canvas.releasePointerCapture(e.pointerId);
    } catch { /* not captured — fine */ }

    switch (g.type) {
      case 'move':
        if (g.moved) this._commit(); // this.map was mutated live during the drag
        return;
      case 'start':
        this._commit(); // this.map was mutated live during the drag
        return;
      case 'wall': {
        if (Math.hypot(g.x2 - g.x1, g.y2 - g.y1) < 1) return; // too tiny — ignore
        this._snapshot();
        this._arr('walls').push({
          x1: r1(g.x1), y1: r1(g.y1), x2: r1(g.x2), y2: r1(g.y2),
          heightCm: WALL_HEIGHT_CM,
        });
        this._commit();
        return;
      }
      case 'zone':
      case 'obstacle': {
        const x = r1(Math.min(g.x1, g.x2));
        const y = r1(Math.min(g.y1, g.y2));
        const w = r1(Math.abs(g.x2 - g.x1));
        const h = r1(Math.abs(g.y2 - g.y1));
        if (w < 1 || h < 1) return; // too tiny — ignore
        this._snapshot();
        if (g.type === 'zone') {
          const label = prompt('Zone label (leave empty for none):', '') || '';
          this._arr('zones').push({ x, y, w, h, color: this._els.color.value, label });
        } else {
          this._arr('obstacles').push({
            x, y, w, h,
            heightCm: OBSTACLE_HEIGHT_CM,
            color: this._els.color.value,
            movable: this._els.movable.checked,
          });
        }
        this._commit();
        return;
      }
    }
  }

  _onPointerCancel() {
    if (!this._active) return;
    this._abortGesture();
  }

  _onDblClick(e) {
    if (!this._active) return;
    if (this.tool === 'line' && this._pendingLine) {
      e.stopPropagation();
      e.preventDefault();
      this._commitLine();
    }
  }

  _onKeyDown(e) {
    if (!this._active) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if (e.key === 'Escape') {
      if (this._pendingLine) this._pendingLine = null;
      else if (this._gesture) this._abortGesture();
      else this._selection = null;
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (this.tool === 'line' && this._pendingLine) {
        this._commitLine();
        e.preventDefault();
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this._selection) {
        this._deleteSelection();
        e.preventDefault();
      }
    }
  }

  /** Finish the pending line: dedupe near-identical points, validate, commit. */
  _commitLine() {
    const pending = this._pendingLine;
    this._pendingLine = null;
    if (!pending) return;
    const pts = [];
    for (const p of pending.points) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.5) pts.push(p);
    }
    if (pts.length < 2) {
      emit('log', { text: 'A line needs at least 2 points — click a few spots first.', level: 'info' });
      return;
    }
    this._snapshot();
    this._arr('lines').push({
      color: this._els.color.value,
      widthCm: clamp(parseFloat(this._els.width.value) || 2.5, 0.2, 20),
      points: pts,
    });
    this._commit();
  }

  // ------------------------------------------------------------ overlay drawing
  // Called from View2D.render() with ctx in SCREEN space (CSS px). Everything
  // here converts world → screen through view.worldToScreen.

  _drawOverlay(ctx, view) {
    if (!this.map) return;
    this._drawSelection(ctx, view);
    this._drawGesturePreview(ctx, view);
    this._drawPendingLine(ctx, view);
  }

  _drawSelection(ctx, view) {
    const sel = this._selection;
    const obj = this._objFor(sel);
    if (!obj) return;
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    if (sel.kind === 'walls') {
      const [ax, ay] = view.worldToScreen(obj.x1, obj.y1);
      const [bx, by] = view.worldToScreen(obj.x2, obj.y2);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      this._handle(ctx, ax, ay);
      this._handle(ctx, bx, by);
    } else {
      const [x, y] = view.worldToScreen(obj.x, obj.y);
      const w = obj.w * view.pxPerCm;
      const h = obj.h * view.pxPerCm;
      ctx.strokeRect(x, y, w, h);
      this._handle(ctx, x, y);
      this._handle(ctx, x + w, y);
      this._handle(ctx, x, y + h);
      this._handle(ctx, x + w, y + h);
    }
    ctx.restore();
  }

  /** Small square selection handle at screen (x, y). */
  _handle(ctx, x, y) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.fillRect(x - 3, y - 3, 6, 6);
    ctx.strokeRect(x - 3, y - 3, 6, 6);
    ctx.restore();
  }

  _drawGesturePreview(ctx, view) {
    const g = this._gesture;
    if (!g) return;
    ctx.save();
    if (g.type === 'wall') {
      const [ax, ay] = view.worldToScreen(g.x1, g.y1);
      const [bx, by] = view.worldToScreen(g.x2, g.y2);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    } else if (g.type === 'zone' || g.type === 'obstacle') {
      const [ax, ay] = view.worldToScreen(Math.min(g.x1, g.x2), Math.min(g.y1, g.y2));
      const w = Math.abs(g.x2 - g.x1) * view.pxPerCm;
      const h = Math.abs(g.y2 - g.y1) * view.pxPerCm;
      ctx.fillStyle = this._els.color.value;
      ctx.globalAlpha = 0.3;
      ctx.fillRect(ax, ay, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(ax, ay, w, h);
    } else if (g.type === 'start' && this.map.start) {
      // Arrow showing the start pose being placed/aimed.
      const s = this.map.start;
      const [x, y] = view.worldToScreen(s.x, s.y);
      ctx.translate(x, y);
      ctx.rotate((s.headingDeg || 0) * DEG);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(16, 0);
      ctx.moveTo(9, -6);
      ctx.lineTo(16, 0);
      ctx.lineTo(9, 6);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawPendingLine(ctx, view) {
    const pending = this._pendingLine;
    if (!pending || !pending.points.length) return;
    const pts = pending.points;
    const widthPx = clamp(parseFloat(this._els.width.value) || 2.5, 0.2, 20) * view.pxPerCm;

    ctx.save();
    // The line so far, at its real width and color.
    ctx.strokeStyle = this._els.color.value;
    ctx.lineWidth = widthPx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    const [sx, sy] = view.worldToScreen(pts[0][0], pts[0][1]);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = view.worldToScreen(pts[i][0], pts[i][1]);
      ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Rubber band from the last point to the cursor.
    if (this._cursor) {
      const [lx, ly] = view.worldToScreen(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      const [cx, cy] = view.worldToScreen(this._cursor[0], this._cursor[1]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Dots on each committed point.
    ctx.globalAlpha = 1;
    for (const p of pts) {
      const [px, py] = view.worldToScreen(p[0], p[1]);
      this._handle(ctx, px, py);
    }

    // Hint text near the bottom-left (the toolbar covers the top).
    const hint = 'Line: click to add points — Enter or double-click to finish, Esc to cancel';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    const y = view.canvas.clientHeight - 10;
    const w = ctx.measureText(hint).width;
    ctx.fillStyle = 'rgba(10, 12, 20, 0.75)';
    ctx.fillRect(6, y - 18, w + 14, 24);
    ctx.fillStyle = '#dfe4ee';
    ctx.fillText(hint, 13, y);
    ctx.restore();
  }
}
