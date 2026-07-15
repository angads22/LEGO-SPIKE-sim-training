/**
 * SpikeSim desktop launcher — used as the pkg entry point.
 * Starts the static server (server.js) and opens the default browser.
 * server.js remains runnable standalone for dev (node server.js).
 */
const { spawn } = require('child_process');

// Default to the app's normal port, but honor an override (e.g. PORT=8791).
const PORT = process.env.PORT || 8790;
process.env.PORT = PORT;

// Starting server.js begins listening immediately (it calls server.listen).
require('./server.js');

const url = `http://localhost:${PORT}`;

// Give the listener a moment, then open the default browser.
setTimeout(() => {
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin; empty "" is the window-title arg.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.log(`Open your browser to ${url}`);
  }
}, 600);

console.log(`SpikeSim desktop launcher — serving at ${url}`);
console.log('Close this window to stop the server.');
