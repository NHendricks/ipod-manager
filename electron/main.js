// Minimaler Electron-Hauptprozess. Im gepackten Build läuft KEIN eigener HTTP-Server/Port
// für das Backend: das Hono-"app.js" wird direkt importiert und über protocol.handle()
// portlos an das Fenster angebunden (Custom-Scheme "wizard://"). Kein ASAR, kein IPC – bewusst
// so einfach wie möglich gehalten. Einziges Preload-Script (preload.js) exponiert nur
// webUtils.getPathForFile fürs Drag&Drop von Dateien aus dem Explorer.
const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isDev = process.argv.includes('--dev');

// Muss vor dem "ready"-Event registriert werden.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wizard',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow = null;

/** Bindet das Hono-Backend direkt (ohne Netzwerk-Port) an das "wizard://"-Schema. */
async function setupBackendProtocol() {
  // Layout im gepackten Build (siehe build.mjs): resources/app/{main.js, backend/}
  const backendDir = path.join(process.resourcesPath, 'app', 'backend');
  const appJsUrl = pathToFileURL(path.join(backendDir, 'dist', 'index.js')).href;
  const { app: honoApp } = await import(appJsUrl);
  protocol.handle('wizard', (request) => honoApp.fetch(request));
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Wizard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadURL(url);
}

app.whenReady().then(async () => {
  if (isDev) {
    // Backend (Port 3001) und Vite-Devserver (Port 5173) laufen bereits separat
    // über "npm run dev" -> hier nur das Fenster öffnen.
    createWindow('http://localhost:5173');
    return;
  }
  await setupBackendProtocol();
  createWindow('wizard://local/');
});

app.on('window-all-closed', () => {
  app.quit();
});
