#!/usr/bin/env node
// Lädt die Electron-Binärdistribution direkt von GitHub Releases (kein "npm install electron",
// dessen Postinstall-Download hinter manchen Proxies/Firewalls unzuverlässig ist). Entpackt über
// das System-"tar" (bsdtar auf Windows/macOS beherrscht ZIP nativ inkl. Symlinks) - dafür ist
// kein zusätzliches npm-Paket nötig. Für einen macOS-Build von Windows aus (wo Symlinks ohne
// Admin-Rechte/Entwicklermodus nicht anlegbar sind) siehe download-electron-mac.mjs.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadElectronZip, describeError, ELECTRON_VERSION } from './lib/electron-release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..');

// Override nur nötig, wenn direkt für eine andere Plattform gebaut wird, auf der dieses
// Skript auch läuft (z.B. win32-x64 auf einer win32-arm64-Maschine).
const platform = process.env.ELECTRON_PLATFORM || process.platform; // win32 | darwin | linux
const arch = process.env.ELECTRON_ARCH || process.arch; // x64 | arm64

const downloadsDir = path.join(electronDir, 'downloads');
const distDir = path.join(electronDir, 'electron-dist');

async function main() {
  const { zipPath, zipName } = await downloadElectronZip({ platform, arch, downloadsDir });

  console.log(`📦 Entpacke nach ${distDir}`);
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  // Hinweis: GNU tar (Standard unter Linux) kann keine ZIPs entpacken - dort bsdtar bzw.
  // "libarchive-tools" installieren. Windows- und macOS-"tar" sind bereits bsdtar - ABER: falls
  // "npm run download" aus einer Git-Bash/MSYS-Shell heraus läuft, kann deren mitgeliefertes
  // GNU tar (usr/bin/tar.exe) in PATH vor dem echten Windows-bsdtar (System32/tar.exe) stehen
  // und "This does not look like a tar archive" werfen. Auf Windows daher explizit das
  // System32-bsdtar verwenden statt "tar" per PATH aufzulösen.
  const tarBin = platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  // Pfade relativ zu electronDir übergeben (statt absolut): ein absoluter Windows-Pfad wie
  // "D:\..." wird von manchen tar-Implementierungen (z.B. Git-Bash/MSYS) fälschlich als
  // "host:path"-Fernarchiv-Syntax interpretiert ("Cannot connect to D: resolve failed").
  execSync(`"${tarBin}" -xf "${path.relative(electronDir, zipPath)}" -C "${path.relative(electronDir, distDir)}"`, {
    cwd: electronDir,
    stdio: 'inherit',
  });

  console.log(`✅ Electron v${ELECTRON_VERSION} (${platform}-${arch}, "${zipName}") bereit unter ${distDir}`);
}

main().catch((err) => {
  console.error('❌', describeError(err));
  process.exit(1);
});
