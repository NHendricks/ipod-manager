#!/usr/bin/env node
// Lädt die macOS-Electron-Distribution und entpackt sie so, dass daraus auch von Windows aus
// gebaut werden kann (siehe lib/unzip-mac.mjs: Symlinks werden dupliziert statt echter
// Symlinks angelegt, da Windows dafür Admin-Rechte/Entwicklermodus bräuchte). Separates Skript
// statt eines Flags an download-electron.mjs, damit der normale (host-plattform-)Pfad mit
// "tar" einfach bleibt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadElectronZip, describeError, ELECTRON_VERSION } from './lib/electron-release.mjs';
import { extractZipDuplicatingSymlinks } from './lib/unzip-mac.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..');

const platform = 'darwin';
const arch = process.env.ELECTRON_ARCH || 'arm64'; // oder x64 für Intel-Macs

const downloadsDir = path.join(electronDir, 'downloads');
const distDir = path.join(electronDir, 'electron-dist-mac');

async function main() {
  const { zipPath, zipName } = await downloadElectronZip({ platform, arch, downloadsDir });

  console.log(`📦 Entpacke (Symlinks werden dupliziert) nach ${distDir}`);
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  extractZipDuplicatingSymlinks(zipPath, distDir);

  console.log(`✅ Electron v${ELECTRON_VERSION} (${platform}-${arch}, "${zipName}") bereit unter ${distDir}`);
}

main().catch((err) => {
  console.error('❌', describeError(err));
  process.exit(1);
});
