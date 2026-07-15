/**
 * SpikeSim desktop shell (Electron).
 *
 * Starts the app's own static server (server.js) on a FREE port — we set
 * PORT=0 so the OS picks an unused port, which means a dev server already
 * running on 8790 never collides. Then we open a native BrowserWindow that
 * loads http://localhost:<port>/. No browser tab, no menu bar, no console.
 *
 * server.js stays runnable standalone (`node server.js` still binds 8790).
 */

// If launched with plain Node (`node .`) instead of Electron, require('electron')
// resolves to a path string, not the API — so `app` would be undefined and crash.
// Fall back to the browser launcher, which is the intended non-Electron entry.
if (!process.versions.electron) {
  require('./desktop.js');
  return;
}

const { app, BrowserWindow, Menu } = require('electron');

// Choose a free port unless the caller explicitly pinned PORT.
// server.js reads process.env.PORT at require() time, so set it first.
if (!process.env.PORT) process.env.PORT = '0';

// Requiring server.js starts it listening immediately; we keep the exported
// http.Server so we can wait for 'listening' and read the real bound port.
const server = require('./server.js');

let mainWindow = null;

function createWindow(port) {
  // No application menu / menu bar at all.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'SpikeSim',
    backgroundColor: '#F5EFE4',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const url = `http://localhost:${port}/`;
  mainWindow.loadURL(url);

  // Smoke test hook: prove the server started and the HTML loaded inside the
  // Electron window, then quit — no hanging GUI.
  if (process.env.SPIKESIM_SMOKE === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('SMOKE_OK ' + mainWindow.webContents.getURL());
      setTimeout(() => app.quit(), 800);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function launch() {
  const port = server.address().port;
  createWindow(port);
}

app.whenReady().then(() => {
  if (server.listening) launch();
  else server.once('listening', launch);

  app.on('activate', () => {
    // macOS convention: re-open a window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) launch();
  });
});

app.on('window-all-closed', () => {
  // Windows is the target: quit when the last window closes.
  if (process.platform !== 'darwin') app.quit();
});
