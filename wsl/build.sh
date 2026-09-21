#!/usr/bin/env bash
# Compiles ipodctl.c against libgpod. Runs inside WSL (see backend/src/ipod.ts, which shells
# out to `wsl.exe` for every iPod operation since libgpod has no maintained Windows build).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

gcc -O2 -Wall -o build/ipodctl ipodctl.c $(pkg-config --cflags --libs libgpod-1.0)
echo "Built wsl/build/ipodctl"
