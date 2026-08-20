// Minimaler ZIP-Reader (nur für das, was ein Electron-macOS-Release braucht: gespeicherte
// oder deflate-komprimierte Einträge, Unix-Symlink-Erkennung über die External-Attributes).
// Grund für die Eigenimplementierung statt "tar"/"extract-zip": Windows kann Symlinks aus
// einem ZIP nur mit Admin-Rechten/Entwicklermodus als echte Symlinks anlegen (siehe
// unzipDuplicatingSymlinks unten) - das scheitert sonst mit "Invalid argument" bzw.
// "Für diesen Vorgang sind Administratorrechte erforderlich".
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEndOfCentralDirectory(buf) {
  const maxCommentLen = 65535;
  const minPos = Math.max(0, buf.length - (22 + maxCommentLen));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('Kein gültiges ZIP: End-of-Central-Directory-Signatur nicht gefunden.');
}

function readCentralDirectory(buf) {
  const eocdPos = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (cdOffset === 0xffffffff) {
    throw new Error('ZIP64 wird von diesem minimalen Reader nicht unterstützt.');
  }

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(pos) !== CDH_SIG) {
      throw new Error(`Ungültiger Central-Directory-Eintrag bei Offset ${pos} (Eintrag ${i}/${totalEntries}).`);
    }
    const versionMadeByHost = buf.readUInt8(pos + 5); // 3 = Unix
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const filenameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.toString('utf8', pos + 46, pos + 46 + filenameLen);

    const isUnix = versionMadeByHost === 3;
    const unixMode = isUnix ? (externalAttrs >>> 16) & 0xffff : 0;
    const isSymlink = isUnix && (unixMode & 0xf000) === 0xa000;
    const isDir = filename.endsWith('/') || (isUnix && (unixMode & 0xf000) === 0x4000);

    entries.push({ filename, compressionMethod, compressedSize, localHeaderOffset, isSymlink, isDir });
    pos += 46 + filenameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf, entry) {
  const p = entry.localHeaderOffset;
  if (buf.readUInt32LE(p) !== LFH_SIG) {
    throw new Error(`Ungültiger Local-File-Header bei Offset ${p} für "${entry.filename}".`);
  }
  const filenameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + filenameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return raw;
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Nicht unterstützte Kompressionsmethode ${entry.compressionMethod} für "${entry.filename}".`);
}

/**
 * Entpackt ein ZIP nach destDir. Statt einen Symlink-Eintrag als echten Symlink anzulegen
 * (scheitert auf Windows ohne Admin-Rechte/Entwicklermodus), wird das referenzierte Ziel
 * dupliziert: Datei kopiert bzw. Ordner rekursiv kopiert. Das Ergebnis ist auf der Zielplattform
 * funktional gleichwertig, aber größer als das Original (keine geteilten Inodes) und die
 * Unix-Ausführbarkeits-Bits gehen dabei verloren (NTFS kennt sie nicht) - beim Übertragen des
 * fertigen Bundles auf einen echten Mac ggf. "chmod -R +x" auf die Binaries nötig.
 */
export function extractZipDuplicatingSymlinks(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const entries = readCentralDirectory(buf);

  const symlinks = [];
  for (const entry of entries) {
    const outPath = path.join(destDir, entry.filename);
    if (entry.isDir) {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }
    if (entry.isSymlink) {
      const target = readEntryData(buf, entry).toString('utf8').trim();
      symlinks.push({ outPath, target });
      continue;
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, readEntryData(buf, entry));
  }

  // Symlinks erst auflösen, nachdem alle echten Dateien/Ordner geschrieben sind (das Ziel kann
  // später im Archiv stehen als der Symlink-Eintrag selbst). Mehrere Durchläufe für Ketten
  // (Symlink zeigt auf Symlink).
  let remaining = symlinks;
  for (let pass = 0; pass < 10 && remaining.length > 0; pass++) {
    const stillUnresolved = [];
    for (const { outPath, target } of remaining) {
      const resolvedTarget = path.resolve(path.dirname(outPath), target);
      if (!fs.existsSync(resolvedTarget)) {
        stillUnresolved.push({ outPath, target });
        continue;
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.cpSync(resolvedTarget, outPath, { recursive: true });
    }
    remaining = stillUnresolved;
  }
  if (remaining.length > 0) {
    const list = remaining.map((r) => `  ${r.outPath} -> ${r.target}`).join('\n');
    throw new Error(`Symlink-Ziele nicht gefunden (auch nicht nach mehreren Durchläufen):\n${list}`);
  }
}
