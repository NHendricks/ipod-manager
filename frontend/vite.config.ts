import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    // Backend läuft im Dev nur über einen separaten Node-Prozess (Port 3001, siehe
    // backend/package.json "dev"). Der Proxy erlaubt dem Frontend relative Aufrufe
    // (fetch('/api/...')), die im gepackten Electron-Build stattdessen portlos über
    // protocol.handle('wizard', ...) laufen (siehe electron/main.js).
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
