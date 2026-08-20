#!/usr/bin/env node
// Baut die macOS-Version, auch von Windows aus - nutzt die von download-electron-mac.mjs
// erzeugte Electron-Distribution (Symlinks dort dupliziert statt echter Symlinks, siehe deren
// Kommentar) und erzwingt in build.mjs das darwin-Layout unabhängig vom Host-Betriebssystem.
// Eigenständiges Skript statt eines Flags an build.mjs, damit der normale
// Windows/macOS/Linux-Eigenbau-Pfad einfach bleibt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..');
const electronDistDir = path.join(electronDir, 'electron-dist-mac');

if (!fs.existsSync(electronDistDir)) {
  console.error(
    `❌ Electron nicht gefunden unter "${electronDistDir}".\n` +
      '   Vorher "npm run download:mac" im electron/-Ordner ausführen.',
  );
  process.exit(1);
}

build({
  electronDistDir,
  outputDir: path.join(electronDir, 'build-output-mac'),
  appContentDir: path.join(electronDir, 'app-content-mac'),
  targetPlatform: 'darwin',
}).catch((err) => {
  console.error('\n❌ Mac-Build fehlgeschlagen:', err);
  process.exit(1);
});
