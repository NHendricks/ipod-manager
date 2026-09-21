Wizard
======

Einfach starten - keine Einrichtung nötig.

Hinweis Windows/iPod-Funktion: Das Kopieren auf/vom iPod Classic läuft über
libgpod, das keinen gepflegten Windows-Build hat. Diese App ruft dafür WSL2
(Distro "Ubuntu-24.04") mit installiertem "libgpod4t64" auf - WSL2 und diese
Distro müssen auf dem Windows-Rechner vorhanden sein, sonst meldet die App
"No iPod detected" bzw. einen WSL-Fehler.

Hinweis für macOS: Falls Wizard.app unter Windows gebaut und per einfacher
Dateikopie (statt zip/tar) auf den Mac übertragen wurde, fehlen ggf. die
Unix-Ausführbarkeits-Bits (NTFS kennt diese nicht). In dem Fall einmalig:

   sh Wizard.app/Contents/Resources/make-executable.sh
