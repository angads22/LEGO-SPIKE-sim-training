/**
 * MatchHud — MoSim-style match overlay on the 2D view: an FLL match clock
 * (2:30, counting down on SIM time) plus the active challenge's goals as a
 * live checklist, so progress is visible on the mat instead of only in the
 * console log.
 *
 * The clock arms on the first program run or drive-mode session after a
 * reset (app.js owns that via getMatchStartT) and freezes at 0:00 when the
 * match is over — informational, like a wall clock at the table; it never
 * stops the robot. ⟲ Reset re-arms it.
 *
 * DOM-only overlay (like #mapeditor-toolbar): floats inside the 2D pane,
 * ignores pointer events, and re-renders text only when something changed so
 * the per-frame cost is a string compare.
 */

const MATCH_SECONDS = 150; // FLL robot game match length (2:30)

/** mm:ss with a leading zero on seconds. */
function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class MatchHud {
  /**
   * @param {HTMLElement} host container to float over (e.g. #pane-2d)
   * @param {import('../core/engine.js').Engine} engine
   * @param {{getStatus: () => {active: boolean, name: string, goals: Array<{label: string, done: boolean}>, done: boolean}}} challenges
   * @param {() => (number|null)} getMatchStartT sim time when the match
   *   started, or null while un-armed (before the first Run/drive)
   */
  constructor(host, engine, challenges, getMatchStartT) {
    this.engine = engine;
    this.challenges = challenges;
    this.getMatchStartT = getMatchStartT;

    this.el = document.createElement('div');
    this.el.className = 'match-hud';
    this.el.innerHTML = '<div class="match-clock" data-hud="clock">⏱ 2:30</div>'
      + '<div class="match-goals hidden" data-hud="goals"></div>';
    host.appendChild(this.el);
    /** @private */ this._clockEl = this.el.querySelector('[data-hud="clock"]');
    /** @private */ this._goalsEl = this.el.querySelector('[data-hud="goals"]');
    /** @private last rendered strings, to skip no-op DOM writes */
    this._lastClock = '';
    this._lastGoals = '';

    const tick = () => { this._render(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ private

  /** @private one frame: clock + goals (DOM writes only on change) */
  _render() {
    // Skip everything while the 2D pane is hidden (3D/Build tab active):
    // offsetParent is null under display:none, and rendering an invisible
    // overlay would just churn goal arrays + HTML strings every frame.
    if (this.el.offsetParent === null) return;
    const startT = this.getMatchStartT();
    let remaining = MATCH_SECONDS;
    if (startT != null) {
      remaining = MATCH_SECONDS - (this.engine.getState().t - startT);
    }
    const over = startT != null && remaining <= 0;
    const clock = `⏱ ${fmtClock(remaining)}`;
    if (clock !== this._lastClock) {
      this._lastClock = clock;
      this._clockEl.textContent = clock;
      this._clockEl.classList.toggle('over', over);
    }

    const st = this.challenges ? this.challenges.getStatus() : { active: false };
    if (!st.active) {
      if (this._lastGoals !== '') {
        this._lastGoals = '';
        this._goalsEl.classList.add('hidden');
        this._goalsEl.innerHTML = '';
      }
      return;
    }
    const html = [
      `<div class="match-title">${st.done ? '🏆' : '🚩'} ${escapeHtml(st.name)}</div>`,
      ...st.goals.map((g) => `<div class="match-goal${g.done ? ' done' : ''}">`
        + `<span class="tick">${g.done ? '✔' : '○'}</span>${escapeHtml(g.label)}</div>`),
    ].join('');
    if (html !== this._lastGoals) {
      this._lastGoals = html;
      this._goalsEl.innerHTML = html;
      this._goalsEl.classList.remove('hidden');
    }
  }
}

/** Escape text for innerHTML interpolation (labels come from challenge JSON). */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
