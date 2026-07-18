/**
 * SpikeSim help & onboarding — a one-time welcome overlay for first-run users
 * plus a tabbed "❓ Help" modal (Quick start / Coding / Tutorial / Challenges).
 *
 * Pure DOM + CSS classes from css/app.css ("HELP & ONBOARDING" section); no
 * frameworks, no alert()/confirm(), no external assets. The Tutorial tab
 * fetches docs/TUTORIAL.md on first view and renders it with the minimal
 * markdown converter below — fetched text is HTML-escaped before any markup
 * is applied, so the document can never inject live HTML.
 *
 * Wiring (docs/UX-WIRING.md): app.js creates one HelpSystem, points the
 * toolbar's #btn-help at openHelp(), and calls showWelcome() at the end of
 * boot — showWelcome() no-ops once the user has dismissed the welcome card
 * (localStorage 'spikesim.seenWelcome' === '1').
 */

const SEEN_KEY = 'spikesim.seenWelcome';

/** Tab registry — array order is button order in the modal. */
const TABS = [
  { id: 'quick', label: 'Quick start' },
  { id: 'coding', label: 'Coding' },
  { id: 'tutorial', label: 'Tutorial' },
  { id: 'challenges', label: 'Challenges' },
];

// --------------------------------------------------------- minimal markdown

/**
 * Escape text for safe interpolation into HTML.
 * @param {string} s raw text
 * @returns {string} HTML-safe text
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline markdown (`code` spans, **bold**) applied AFTER escaping.
 * @param {string} s one line of raw markdown text
 * @returns {string} HTML fragment
 */
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * Minimal markdown → HTML, sized for docs/TUTORIAL.md: # / ## / ### headings,
 * fenced code blocks, `code`, **bold**, - and 1. lists (with indented
 * continuation lines), > blockquotes, paragraphs. All content is escaped
 * before markup is applied. Exported so tests can exercise it headlessly.
 * @param {string} md markdown source
 * @returns {string} HTML string
 */
export function renderMarkdown(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let list = null; // 'ul' | 'ol' | null — the currently open list tag
  let para = []; // pending paragraph lines
  let quote = []; // pending blockquote lines
  let code = null; // array of raw lines while inside a ``` fence

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const flushQuote = () => {
    if (quote.length) { out.push(`<blockquote><p>${inlineMd(quote.join(' '))}</p></blockquote>`); quote = []; }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of lines) {
    if (code) { // inside a fence: collect verbatim until the closing ```
      if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushAll(); code = []; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue; }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara(); flushQuote();
      const kind = /^\d+\.$/.test(li[1]) ? 'ol' : 'ul';
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inlineMd(li[2])}</li>`);
      continue;
    }
    if (!line.trim()) { flushAll(); continue; }
    if (list && /^\s/.test(line)) {
      // Indented continuation of the previous list item (TUTORIAL.md wraps
      // long items). The last out entry is always "<li>…</li>" here.
      out.push(out.pop().replace(/<\/li>$/, ` ${inlineMd(line.trim())}</li>`));
      continue;
    }
    flushList(); flushQuote();
    para.push(line.trim());
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); // unclosed fence
  flushAll();
  return out.join('\n');
}

// ------------------------------------------------------------- tab content

const QUICK_HTML = `
<h3>Three steps to your first drive</h3>
<ol class="help-steps">
  <li><span class="help-emoji">▶</span><div><strong>Run the starter blocks.</strong>
    Press <strong>▶ Run</strong> and watch the robot drive — top-down in the <strong>2D</strong> tab,
    or from behind in <strong>3D</strong> (try <strong>🎥 Follow</strong>).</div></li>
  <li><span class="help-emoji">🧱→🐍</span><div><strong>Blocks write real Python, live.</strong>
    The panel under the blocks shows the Python they generate. Curious? Open the
    <strong>Python</strong> tab and type it yourself.</div></li>
  <li><span class="help-emoji">🏆</span><div><strong>Beat a Challenge.</strong>
    Pick one from the toolbar — it loads a mission, and the simulator checks off goals in the
    console as you solve it.</div></li>
</ol>
<h3>Toolbar cheat sheet</h3>
<table class="help-table">
  <tr><td>▶ Run</td><td>Runs the program in whichever editor tab is open — Blocks or Python.</td></tr>
  <tr><td>■ Stop</td><td>Freezes the robot mid-move — always safe, nothing breaks.</td></tr>
  <tr><td>⟲ Reset</td><td>Puts the robot (and any crates) back at their starting spots.</td></tr>
  <tr><td>🎮 Drive</td><td>Drive the robot yourself — W/S or ↑/↓ to drive, A/D or ←/→ to turn, Shift for slow. Great for practicing a mission before you code it.</td></tr>
  <tr><td>Speed</td><td>Fast-forwards the whole simulation — or slows it down to watch closely.</td></tr>
  <tr><td>Map</td><td>Swaps the mat under the robot: line tracks, a maze, an FLL-style table, or your own maps.</td></tr>
  <tr><td>✏ Edit map</td><td>Opens drawing tools to add walls, lines, and zones — or build a mat from scratch.</td></tr>
  <tr><td>Examples</td><td>Loads a ready-made program into the editor — perfect for borrowing ideas.</td></tr>
  <tr><td>Challenge</td><td>Starts a mission with goals (and 💡 hints) that the simulator checks as you play.</td></tr>
  <tr><td>⤢ Fit</td><td>Zooms the 2D view so the whole map fits on screen.</td></tr>
  <tr><td>🎥 Follow</td><td>Makes the 3D camera ride along behind the robot.</td></tr>
</table>`;

const CODING_HTML = `
<h3>Two Python dialects — your imports decide</h3>
<p><strong>Blocks &amp; SPIKE 2 (classic).</strong> Programs that start with
<code>from spike import …</code> use the friendly classic API — <code>PrimeHub()</code>,
<code>MotorPair()</code>, <code>wait_for_seconds()</code>. The Blocks tab generates exactly this
dialect, and it runs instantly.</p>
<p><strong>SPIKE 3 (real Python).</strong> Programs that import <code>hub</code>,
<code>runloop</code>, <code>motor_pair</code> and friends — e.g. <code>from hub import port</code> —
are the same Python the official SPIKE app puts on a real hub, <code>async</code>/<code>await</code>
and all. SpikeSim spots those imports automatically and runs the code on a real CPython runtime
(the very first run takes a moment while it warms up).</p>
<p>There is no switch to flip: write either dialect and press <strong>▶ Run</strong>. The small
badge in the editor's tab bar shows which one will run.</p>
<h3>Run two things at the same time</h3>
<p>Drop a <strong>second “when program starts” block</strong> and build a separate stack under it.
Both stacks now run <strong>at the same time</strong> — so the robot can drive while another stack
blinks the light matrix, plays sounds, or works an arm motor. Add as many stacks as you like.
(Under the hood the Blocks tab compiles them into <code>run_parallel(...)</code>; you can see it in
the live Python preview.) Try <strong>Examples → “Drive + light show at once”</strong>.</p>
<h3>Pick your driving wheels</h3>
<p>The <strong>set movement motors to A B</strong> block (Movement category) tells the move and turn
blocks which two motor ports are your left and right wheels — handy when your build puts the drive
motors somewhere other than A and B. In Python it’s <code>MotorPair('A', 'B')</code>, which now
just points the movement motors at those ports for you.</p>
<h3>Good to know</h3>
<ul>
  <li><code>mp.turn(90)</code> is a SpikeSim extension: a clean gyro turn on the spot
    (positive = right). A real hub doesn't have it, so swap it for steering moves before running
    on real hardware.</li>
  <li>Motors and sensors live on ports <strong>A–F</strong>. See — and change — what's plugged
    where in the <strong>Build</strong> tab on the right.</li>
  <li><code>print()</code> writes to the console at the bottom, and
    <code>hub.light_matrix.write('HI')</code> lights up the HUB bar down there too.</li>
</ul>`;

const CHALLENGES_HTML = `
<h3>Missions with a scoreboard</h3>
<p>Pick a mission from the <strong>Challenge</strong> menu in the toolbar. It loads its own robot,
map, and starter program, then watches the simulation and ticks goals off in the console as you
meet them. Complete every goal and you earn the 🏆 (with a victory beep).</p>
<ul>
  <li><strong>Stuck?</strong> Open the Challenge menu again and pick <strong>💡 Next hint</strong>.
    Hints escalate gently — what to sense, how to decide, how to act — without spoiling the
    solution.</li>
  <li><strong>⟲ Reset</strong> puts everything back and re-arms the goals for another attempt.</li>
  <li>Choosing the blank “Pick a challenge…” entry ends the mission.</li>
</ul>
<h3>Want a brand-new mission?</h3>
<p>Each challenge is a single JSON file. Describe a mission to Claude — <em>“the robot uses its
distance sensor to find a gap in a wall, drives through, and parks in a garage zone”</em> — and it
can build the whole thing: map, robot, starter code, goals, and hints. The authoring recipe lives
in <code>CHALLENGES.md</code> in the project folder.</p>`;

// ------------------------------------------------------------------ system

/**
 * First-run welcome overlay + tabbed help modal. Construct once; both start
 * hidden. All markup is appended to document.body inside one .help-root.
 */
export class HelpSystem {
  constructor() {
    /** @private id of the tab shown when the modal opens (session memory) */
    this._currentTab = 'quick';
    /** @private tutorial fetch state: 'idle' | 'loading' | 'ready' | 'failed' */
    this._tutorialState = 'idle';

    const root = document.createElement('div');
    root.className = 'help-root';
    root.innerHTML = `
      <div class="help-backdrop hidden" data-help="welcome">
        <div class="welcome-card" role="dialog" aria-modal="true" aria-label="Welcome to SpikeSim">
          <div class="welcome-title">Welcome to SpikeSim! 🤖</div>
          <p class="welcome-sub">A virtual SPIKE robot, a mat to drive on, and nothing you can break.
            Three things to know:</p>
          <div class="welcome-step"><span class="help-emoji">▶</span>
            <div><strong>Run the starter blocks</strong>
              <div class="welcome-step-text">Press <strong>▶ Run</strong> and watch the robot drive —
                top-down in the <strong>2D</strong> tab, or in full <strong>3D</strong>.</div></div></div>
          <div class="welcome-step"><span class="help-emoji">🧱→🐍</span>
            <div><strong>Blocks write real Python, live</strong>
              <div class="welcome-step-text">Peek at the preview under the blocks, then try typing in
                the <strong>Python</strong> tab.</div></div></div>
          <div class="welcome-step"><span class="help-emoji">🏆</span>
            <div><strong>Beat a Challenge</strong>
              <div class="welcome-step-text">Pick one from the toolbar — the sim loads a mission and
                checks off goals as you solve it.</div></div></div>
          <div class="welcome-actions">
            <button type="button" class="primary" data-help="lets-go">Let's go ▶</button>
            <button type="button" data-help="open-guide">Open the guide</button>
          </div>
          <div class="welcome-foot">Find this again any time — press <strong>❓ Help</strong> in the toolbar.</div>
        </div>
      </div>
      <div class="help-backdrop hidden" data-help="modal">
        <div class="help-modal" role="dialog" aria-modal="true" aria-label="SpikeSim guide">
          <div class="help-head">
            <span class="help-title">❓ SpikeSim guide</span>
            <button type="button" class="help-close" data-help="close" aria-label="Close help">✕</button>
          </div>
          <div class="help-tabs" data-help="tabs"></div>
          <div class="help-body" data-help="body"></div>
        </div>
      </div>`;
    document.body.appendChild(root);

    /** @private */ this._root = root;
    /** @private */ this._welcome = root.querySelector('[data-help="welcome"]');
    /** @private */ this._modal = root.querySelector('[data-help="modal"]');
    /** @private */ this._closeBtn = root.querySelector('[data-help="close"]');
    /** @private */ this._tabsEl = root.querySelector('[data-help="tabs"]');
    /** @private */ this._bodyEl = root.querySelector('[data-help="body"]');
    /** @private {Record<string, HTMLElement>} pane host per tab id */
    this._panes = {};

    const staticHtml = { quick: QUICK_HTML, coding: CODING_HTML, challenges: CHALLENGES_HTML };
    for (const t of TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'help-tab';
      btn.dataset.tab = t.id;
      btn.textContent = t.label;
      btn.onclick = () => this._selectTab(t.id);
      this._tabsEl.appendChild(btn);
      const pane = document.createElement('div');
      pane.className = 'help-pane';
      if (staticHtml[t.id]) pane.innerHTML = staticHtml[t.id]; // tutorial fills lazily
      this._bodyEl.appendChild(pane);
      this._panes[t.id] = pane;
    }

    // Dismissal: ✕ button, backdrop click, ESC — plus the welcome buttons.
    this._closeBtn.onclick = () => this._closeModal();
    this._modal.addEventListener('click', (e) => { if (e.target === this._modal) this._closeModal(); });
    this._welcome.addEventListener('click', (e) => { if (e.target === this._welcome) this._closeWelcome(); });
    root.querySelector('[data-help="lets-go"]').onclick = () => this._closeWelcome();
    root.querySelector('[data-help="open-guide"]').onclick = () => { this._closeWelcome(); this.openHelp('quick'); };
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this._welcome.classList.contains('hidden')) this._closeWelcome();
      else if (!this._modal.classList.contains('hidden')) this._closeModal();
    });
  }

  /**
   * Show the first-run welcome card. Safe to call unconditionally at boot:
   * no-ops once the user has dismissed it (any button, backdrop, or ESC).
   */
  showWelcome() {
    let seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { /* blocked storage → just show it */ }
    if (seen) return;
    this._welcome.classList.remove('hidden');
    this._root.querySelector('[data-help="lets-go"]').focus();
  }

  /**
   * Open the help modal.
   * @param {string} [tabId] optional tab to land on ('quick' | 'coding' |
   *   'tutorial' | 'challenges'); defaults to the last tab viewed.
   */
  openHelp(tabId) {
    this._modal.classList.remove('hidden');
    this._selectTab(TABS.some((t) => t.id === tabId) ? tabId : this._currentTab);
    this._closeBtn.focus();
  }

  // ---------------------------------------------------------------- private

  /** @private remember dismissal so the welcome never nags again */
  _markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage blocked — it will show again */ }
  }

  /** @private */
  _closeWelcome() {
    this._markSeen();
    this._welcome.classList.add('hidden');
  }

  /** @private */
  _closeModal() {
    this._modal.classList.add('hidden');
  }

  /** @private switch the visible tab (and lazily fetch the tutorial) */
  _selectTab(id) {
    this._currentTab = id;
    for (const btn of this._tabsEl.children) btn.classList.toggle('active', btn.dataset.tab === id);
    for (const t of TABS) this._panes[t.id].classList.toggle('active', t.id === id);
    this._bodyEl.scrollTop = 0;
    if (id === 'tutorial') this._loadTutorial();
  }

  /**
   * @private Fetch + render docs/TUTORIAL.md into the tutorial pane, once.
   * States: loading spinner text → rendered HTML, or a failure note with a
   * "Try again" button that re-arms the fetch.
   */
  _loadTutorial() {
    if (this._tutorialState === 'loading' || this._tutorialState === 'ready') return;
    this._tutorialState = 'loading';
    const host = this._panes.tutorial;
    host.innerHTML = '<div class="help-loading">⏳ Loading the tutorial…</div>';
    fetch('docs/TUTORIAL.md')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((md) => {
        this._tutorialState = 'ready';
        host.innerHTML = renderMarkdown(md);
      })
      .catch(() => {
        this._tutorialState = 'failed';
        host.innerHTML = '<div class="help-loading">😕 Could not load the tutorial '
          + '(docs/TUTORIAL.md). Check that SpikeSim is running from its usual server.</div>';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'help-retry';
        retry.textContent = '↻ Try again';
        retry.onclick = () => { this._tutorialState = 'idle'; this._loadTutorial(); };
        host.appendChild(retry);
      });
  }
}
