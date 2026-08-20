// Gemeinsame Download+Checksum-Logik für die Electron-Distribution von GitHub Releases.
// Wird sowohl von download-electron.mjs (aktuelle Plattform, Entpacken via "tar") als auch
// von download-electron-mac.mjs (macOS-Zip, Entpacken mit duplizierten Symlinks) genutzt.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { fetch, ProxyAgent } from 'undici';

export const ELECTRON_VERSION = '39.8.7';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..', '..');

/** Minimaler .env-Parser (kein zusätzliches "dotenv"-Paket nötig) - lädt nur, was noch nicht in process.env gesetzt ist. */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(electronDir, '.env'));

/** Zusätzliches CA-Zertifikat (PROXY_CA_FILE) für TLS-Interception durch den Proxy - ergänzt
 * (nicht ersetzt) Nodes eingebauten Root-Zertifikatsspeicher. Pfad relativ zu electron/, falls
 * nicht absolut. */
function loadExtraCa() {
  const caFile = process.env.PROXY_CA_FILE;
  if (!caFile) return undefined;
  const resolved = path.isAbsolute(caFile) ? caFile : path.join(electronDir, caFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PROXY_CA_FILE zeigt auf eine nicht existierende Datei: ${resolved}`);
  }
  console.log(`↪ Nutze zusätzliches CA-Zertifikat: ${resolved}`);
  return [...tls.rootCertificates, fs.readFileSync(resolved, 'utf8')];
}

/** Proxy nur einmal auflösen/anlegen (electron/.env: HTTPS_PROXY, sonst HTTP_PROXY, optional PROXY_CA_FILE). */
function getProxyDispatcher() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUrl) return undefined;
  console.log(`↪ Nutze Proxy aus electron/.env: ${proxyUrl.replace(/\/\/[^@]*@/, '//***@')}`);

  const ca = loadExtraCa();
  if (!ca) return new ProxyAgent(proxyUrl);
  // ca sowohl für die TLS-Verbindung zum Proxy als auch für die durch ihn getunnelte
  // Verbindung zum eigentlichen Ziel (github.com) setzen - je nachdem, wo der Proxy die
  // Zertifikate austauscht.
  return new ProxyAgent({ uri: proxyUrl, requestTls: { ca }, proxyTls: { ca } });
}
const proxyDispatcher = getProxyDispatcher();

async function downloadFile(url, dest) {
  if (fs.existsSync(dest)) {
    console.log(`✓ ${path.basename(dest)} bereits vorhanden`);
    return;
  }
  console.log(`↓ Lade ${url}`);
  let res;
  try {
    res = await fetch(url, proxyDispatcher ? { dispatcher: proxyDispatcher } : {});
  } catch (err) {
    // fetch() wirft bei Netzwerk-/TLS-/Proxy-Fehlern nur "fetch failed" - der eigentliche
    // Grund steckt in err.cause (siehe describeError unten).
    throw new Error(`Download fehlgeschlagen: ${url}`, { cause: err });
  }
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}): ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Gibt einen Fehler inkl. voller err.cause-Kette aus (fetch() verschleiert den eigentlichen
 * Netzwerk-/TLS-/Proxy-Grund sonst hinter "fetch failed"). */
export function describeError(err) {
  const lines = [];
  let current = err;
  let depth = 0;
  while (current && depth < 8) {
    const indent = depth === 0 ? '' : '  '.repeat(depth) + '↳ ';
    const name = current.name ?? 'Error';
    const code = current.code ? ` [${current.code}]` : '';
    lines.push(`${indent}${name}${code}: ${current.message ?? String(current)}`);
    current = current.cause;
    depth += 1;
  }
  return lines.join('\n');
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function verifyChecksum(zipPath, shasumsPath, fileName) {
  const shasums = fs.readFileSync(shasumsPath, 'utf8');
  const match = shasums.match(new RegExp(`([a-f0-9]{64})\\s+\\*?${fileName}`));
  if (!match) throw new Error(`Keine Checksumme für ${fileName} in SHASUMS256.txt gefunden`);
  const expected = match[1];
  const actual = await sha256(zipPath);
  if (actual !== expected) {
    throw new Error(`Checksumme stimmt nicht überein: erwartet ${expected}, erhalten ${actual}`);
  }
  console.log(`✓ Checksumme ok (${fileName})`);
}

/** Lädt SHASUMS256.txt + das Electron-ZIP für {platform, arch} nach downloadsDir und verifiziert die Checksumme (Downloads werden gecacht). */
export async function downloadElectronZip({ platform, arch, downloadsDir, version = ELECTRON_VERSION }) {
  const zipName = `electron-v${version}-${platform}-${arch}.zip`;
  const baseUrl = `https://github.com/electron/electron/releases/download/v${version}/`;
  const shasumsPath = path.join(downloadsDir, 'SHASUMS256.txt');
  const zipPath = path.join(downloadsDir, zipName);

  await downloadFile(baseUrl + 'SHASUMS256.txt', shasumsPath);
  await downloadFile(baseUrl + zipName, zipPath);
  await verifyChecksum(zipPath, shasumsPath, zipName);

  return { zipPath, zipName };
}
