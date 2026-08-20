#!/bin/sh
# Setzt die Unix-Ausführbarkeits-Bits (+x) für alle Dateien unter Contents/MacOS,
# Contents/Frameworks und Contents/Library neu.
#
# Grund: Wizard.app wurde unter Windows gebaut (electron/scripts/build-mac.mjs). NTFS kennt
# keine Unix-Ausführbarkeits-Bits, daher fehlen sie im Bundle. Beim Übertragen per einfacher
# Dateikopie (statt zip/tar, das die Bits mitüberträgt) startet macOS die Binaries sonst nicht
# ("Permission denied").
#
# Aufruf (einmalig, nach dem Kopieren von Wizard.app auf den Mac):
#   sh Wizard.app/Contents/Resources/make-executable.sh
set -eu

cd "$(dirname "$0")/.."   # Contents/Resources -> Contents

for dir in MacOS Frameworks Library; do
  if [ -d "$dir" ]; then
    find "$dir" -type f -exec chmod +x {} +
  fi
done

echo "Ausführbarkeits-Bits gesetzt."
