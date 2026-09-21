// Minimaler Electron-Build für Windows, macOS und Linux: kein ASAR, kein Icon, keine
// Zip-Erstellung, keine zusätzlichen Build-Tool-Abhängigkeiten (nur Node-Bordmittel).
// Baut standardmäßig für die aktuelle Plattform (process.platform). Für einen Mac-Build von
// Windows aus siehe scripts/build-mac.mjs (nutzt dieselbe build()-Funktion mit
// targetPlatform: 'darwin' und einer separat entpackten Electron-Distribution).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const appName = 'wizard';

export function run(cmd, cwd) {
  console.log(`\n> ${cmd}  (in ${path.relative(rootDir, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

/** Plattformspezifische Pfade/Umbenennungen innerhalb des kopierten Electron-Outputs. */
function platformLayout(targetPlatform, outputDir) {
  if (targetPlatform === 'darwin') {
    const bundleSrc = path.join(outputDir, 'Electron.app');
    const bundleDest = path.join(outputDir, 'Wizard.app');
    return {
      // Auf macOS liegt "resources/app" innerhalb des .app-Bundles.
      resourcesAppDir: path.join(bundleSrc, 'Contents', 'Resources', 'app'),
      finalize() {
        // Nur den äußeren Bundle-Ordner umbenennen (Finder/macOS zeigt diesen Namen an).
        // Interner Binary-Name ("Electron", laut Info.plist) bleibt bewusst unverändert,
        // damit kein Info.plist-Patch/Re-Codesigning nötig ist (minimalistisch).
        if (fs.existsSync(bundleSrc)) {
          fs.renameSync(bundleSrc, bundleDest);
        } else {
          console.log(`   ⚠️  ${bundleSrc} nicht gefunden!`);
        }
        return bundleDest;
      },
    };
  }

  if (targetPlatform === 'linux') {
    return {
      resourcesAppDir: path.join(outputDir, 'resources', 'app'),
      finalize() {
        const src = path.join(outputDir, 'electron');
        const dest = path.join(outputDir, appName);
        if (fs.existsSync(src)) {
          fs.renameSync(src, dest);
          fs.chmodSync(dest, 0o755);
        } else {
          console.log(`   ⚠️  ${src} nicht gefunden!`);
        }
        return dest;
      },
    };
  }

  // win32 (Standard-/Fallback-Fall)
  return {
    resourcesAppDir: path.join(outputDir, 'resources', 'app'),
    finalize() {
      const src = path.join(outputDir, 'electron.exe');
      const dest = path.join(outputDir, `${appName}.exe`);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      } else {
        console.log(`   ⚠️  ${src} nicht gefunden!`);
      }
      return dest;
    },
  };
}

export async function build({
  electronDistDir = path.join(__dirname, 'electron-dist'),
  outputDir = path.join(__dirname, 'build-output'),
  appContentDir = path.join(__dirname, 'app-content'),
  targetPlatform = process.platform,
} = {}) {
  console.log(`🚀 Baue ${appName} als Electron-App für ${targetPlatform} (ohne ASAR)...`);

  if (!fs.existsSync(electronDistDir)) {
    throw new Error(
      `Electron nicht gefunden unter "${electronDistDir}".\n` +
        'Vorher einmalig "npm run download" im electron/-Ordner ausführen (lädt die ' +
        'zur aktuellen Plattform passende Electron-Distribution direkt von GitHub Releases).',
    );
  }

  // 1) Frontend & Backend bauen.
  console.log('\n📦 Schritt 1: Frontend und Backend bauen...');
  run('npm run build', path.join(rootDir, 'frontend'));
  run('npm run build', path.join(rootDir, 'backend'));

  // 2) Staging-Ordner (app-content) füllen.
  console.log('\n📋 Schritt 2: App-Inhalt zusammenstellen...');
  rmrf(appContentDir);
  fs.mkdirSync(appContentDir, { recursive: true });

  const backendStage = path.join(appContentDir, 'backend');
  copyDir(path.join(rootDir, 'backend', 'dist'), path.join(backendStage, 'dist'));

  // Frontend-Build als "public"-Ordner mit ins Backend legen (wird dort mitausgeliefert).
  copyDir(path.join(rootDir, 'frontend', 'dist'), path.join(backendStage, 'dist', 'public'));

  // Backend-package.json ohne devDependencies.
  const backendPkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'backend', 'package.json'), 'utf8'),
  );
  delete backendPkg.devDependencies;
  backendPkg.scripts = { start: 'node dist/index.js' };
  fs.writeFileSync(path.join(backendStage, 'package.json'), JSON.stringify(backendPkg, null, 2));

  console.log('   📦 Installiere Produktions-Abhängigkeiten des Backends...');
  run('npm install --omit=dev --no-audit --no-fund', backendStage);

  // Electron-Hauptprozess + Preload-Script.
  fs.copyFileSync(path.join(__dirname, 'main.js'), path.join(appContentDir, 'main.js'));
  fs.copyFileSync(path.join(__dirname, 'preload.js'), path.join(appContentDir, 'preload.js'));
  fs.writeFileSync(
    path.join(appContentDir, 'package.json'),
    JSON.stringify({ name: appName, private: true, main: 'main.js' }, null, 2),
  );

  // iPod-Helper (siehe wsl/ipodctl.c): Windows-only, läuft via WSL - vorher einmalig mit
  // "wsl/build.sh" kompilieren. Wird als Geschwister-Ordner von backend/ mitkopiert, damit die
  // relative Pfadauflösung in backend/src/ipod.ts (dist/../../wsl/build/ipodctl) aufgeht.
  if (targetPlatform === 'win32') {
    const ipodctlPath = path.join(rootDir, 'wsl', 'build', 'ipodctl');
    if (!fs.existsSync(ipodctlPath)) {
      throw new Error(
        `iPod-Helper nicht gefunden unter "${ipodctlPath}".\n` +
          'Vorher einmalig "wsl -d Ubuntu-24.04 -- bash wsl/build.sh" ausführen.',
      );
    }
    fs.mkdirSync(path.join(appContentDir, 'wsl', 'build'), { recursive: true });
    fs.copyFileSync(ipodctlPath, path.join(appContentDir, 'wsl', 'build', 'ipodctl'));
  }

  // 3) Electron-Distribution kopieren.
  console.log('\n📦 Schritt 3: Electron-Distribution kopieren...');
  rmrf(outputDir);
  copyDir(electronDistDir, outputDir);

  // 4) App-Inhalt (ohne ASAR) an die plattformspezifische resources/app-Stelle kopieren.
  console.log('\n📋 Schritt 4: App-Inhalt nach resources/app kopieren...');
  const layout = platformLayout(targetPlatform, outputDir);
  rmrf(layout.resourcesAppDir);
  copyDir(appContentDir, layout.resourcesAppDir);

  // 5) Electron-Binary/-Bundle umbenennen.
  console.log('\n🏷️  Schritt 5: Electron-Binary/-Bundle umbenennen...');
  const finalPath = layout.finalize();

  // 6) readme.txt (Einrichtungshinweise für Endnutzer, z.B. wo .env mit Azure/Anthropic-Keys
  // hin muss) neben die ausführbare Datei bzw. das Bundle legen.
  fs.copyFileSync(path.join(__dirname, 'readme.txt'), path.join(outputDir, 'readme.txt'));

  // 7) macOS: Hilfsskript fürs nachträgliche Setzen der Ausführbarkeits-Bits mit ins Bundle
  // legen (nötig, wenn der Build unter Windows entstanden ist - siehe make-executable.sh).
  if (targetPlatform === 'darwin') {
    const scriptDest = path.join(finalPath, 'Contents', 'Resources', 'make-executable.sh');
    fs.copyFileSync(path.join(__dirname, 'make-executable.sh'), scriptDest);
    fs.chmodSync(scriptDest, 0o755);
  }

  console.log('\n✅ Fertig!');
  console.log(`   App-Ordner: ${outputDir}`);
  console.log(`   Starten:    ${finalPath}`);
  if (targetPlatform === 'darwin') {
    console.log(
      `   ℹ️  Nach dem Übertragen auf einen Mac einmalig: sh "${path.basename(finalPath)}/Contents/Resources/make-executable.sh"`,
    );
  }
  return finalPath;
}

// Nur ausführen, wenn direkt gestartet ("node build.mjs") - nicht beim Import aus build-mac.mjs.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  build().catch((err) => {
    console.error('\n❌ Build fehlgeschlagen:', err);
    process.exit(1);
  });
}
