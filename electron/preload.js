// Minimal preload: exposes just enough to resolve a real filesystem path for a File dropped
// from the OS (Explorer) into the renderer. Electron's sandbox strips File.path, so this is the
// only way to turn a drag-and-drop File object into an absolute path the backend can act on.
const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ipodBridge', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
