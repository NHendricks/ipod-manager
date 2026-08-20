#!/usr/bin/env node
// Startet die heruntergeladene Electron-Distribution im Dev-Modus. Backend (Port 3000) und
// Vite-Devserver (Port 5173) müssen bereits separat laufen (z.B. via "npm run dev" im Root).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..');
const distDir = path.join(electronDir, 'electron-dist');

function resolveBinary() {
  if (process.platform === 'win32') return path.join(distDir, 'electron.exe');
  if (process.platform === 'darwin') {
    return path.join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return path.join(distDir, 'electron');
}

const binary = resolveBinary();
if (!fs.existsSync(binary)) {
  console.error(
    `❌ Electron-Binary nicht gefunden unter ${binary}.\n   Vorher "npm run download" im electron/-Ordner ausführen.`,
  );
  process.exit(1);
}

// Achtung: Flags VOR dem App-Pfad durchlaufen Electrons eigenes (strengeres) Bootstrap-Parsing
// und werden dort teils als "bad option" abgelehnt. Daher App-Pfad zuerst, alle Flags danach -
// die kommen unverändert in main.js' process.argv an.
const child = spawn(
  binary,
  [electronDir, '--inspect=9229', '--remote-debugging-port=9222', '--dev'],
  { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } },
);
child.on('exit', (code) => process.exit(code ?? 0));
