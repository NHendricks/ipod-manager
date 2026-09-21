# Wizard – iPod manager

A two-pane file manager for an **iPod Classic**: your computer's music folders on the left, the
iPod's library on the right. Copy music in both directions, delete tracks from the iPod, look at
tags and covers, and fix up mp3 tags so the iPod sorts them properly. No iTunes needed.

It is an Electron app (Lit frontend, Hono backend). The iPod itself is accessed through
[libgpod](https://sourceforge.net/projects/gtkpod/), which has no maintained Windows build – so on
Windows the app talks to it through **WSL2**.

## Platform support

| | |
|---|---|
| **Windows 10 (2004+) / 11** | Supported. Everything works, but only with WSL2 set up as described below. |
| **macOS, Linux** | **The iPod features do not work** – iPod detection is Windows-only (`backend/src/ipod.ts`). The local file pane and the tag tools are plain Node code but are untested there. |

So: **for anything involving the iPod, you need Windows and WSL2.**

## Requirements

1. **Windows with WSL2** and the distro **`Ubuntu-24.04`** (the name is hard-coded, see
   `WSL_DISTRO` in `backend/src/ipod.ts`).
2. **libgpod inside that distro** (`libgpod4t64`).
3. An iPod that shows up as a **drive letter in Windows** (disk mode; an iPod formatted for Windows).
   A Mac-formatted (HFS+) iPod does not appear as a drive in Windows, and this app can't see it.
4. Only for running from source: [Node.js](https://nodejs.org/) (developed with 22) and npm.

### Installing WSL2 and Ubuntu 24.04

Open **PowerShell as administrator** and run:

```powershell
wsl --install -d Ubuntu-24.04
```

Restart Windows if asked, then start "Ubuntu 24.04" from the Start menu once and create your Linux
user name and password. Check that it worked:

```powershell
wsl -l -v
```

You should see `Ubuntu-24.04` with `VERSION 2`. (If it says `1`, run `wsl --set-version Ubuntu-24.04 2`.)
If you already have WSL but not this distro: `wsl --install -d Ubuntu-24.04` adds it next to the others.

### Installing libgpod

In the Ubuntu-24.04 distro (from PowerShell: `wsl -d Ubuntu-24.04`):

```bash
sudo apt update
sudo apt install libgpod4t64
```

That is all the released app needs at runtime. To **build the helper yourself** (needed when running
from source) you also need the compiler and headers:

```bash
sudo apt install build-essential pkg-config libgpod-dev
```

## Running

The app is `wizard` (the folder is called `ipod-manager`). From the repository root:

```powershell
npm run install:all      # root, frontend and backend dependencies
npm run build:ipodctl    # compiles wsl/ipodctl.c inside WSL -> wsl/build/ipodctl (once, and after changing the C file)
npm run dev              # backend + frontend dev servers, open http://localhost:5173
# or, in an Electron window:
npm run dev:electron
```

`wsl/build/ipodctl` is not in the repository, so `npm run build:ipodctl` is required before the iPod
side works.

### Building a Windows package

```powershell
npm run build:win
```

This builds `ipodctl`, downloads Electron and assembles the app (output in `electron/build-output/`).
A machine that runs the result still needs WSL2, `Ubuntu-24.04` and `libgpod4t64` as above.
Behind a proxy, see `electron/.env.example`. (`npm run build:mac` exists, but the iPod features are
Windows-only, see above.)

## How the iPod access works

When you plug in the iPod, the backend finds the drive that contains an `iPod_Control` folder, makes
sure WSL has mounted it (it mounts the drive letter at `/mnt/<letter>` itself if needed), and runs
`ipodctl` – a small C program around libgpod – through `wsl.exe`. `ipodctl` reads and writes the
iPod's `iTunesDB`. Copying, deleting and exporting work in batches (one database write per 25 tracks)
and run one at a time.

## Using it

| Key / action | What it does |
|---|---|
| ↑ ↓ PgUp PgDn Home End | Move the cursor; Shift extends the selection, Ctrl+A selects all |
| Enter, Backspace | Open a folder / go up (also the `..` row and the ⬆ and 🎵 Music buttons) |
| **F5** or drag & drop | Copy the selection to the other pane. Folders copy every audio file inside them |
| **F3** | Show tags, technical info and cover of a file |
| **Del** | Delete the selected tracks from the iPod (asks first) |

Buttons in the menubar:

- **Artist/Album folders** – when copying *from* the iPod, sort files into `Artist/Album/` folders. Every
  copy off the iPod also saves the embedded cover as `Folder.jpg`.
- **Cover art on iPod** – off by default. When on, copying to the iPod also stores each file's embedded
  cover in the iPod's artwork database (experimental, and only works once the iPod's model is known).
- **Extract Folder.jpg** – saves the embedded cover of the selected mp3s as `Folder.jpg` in their folder.
- **Set tags from folders…** – for mp3s sorted as `artist/album/file.mp3`, sets title, album and artist
  from the path (with the sorting fixes the iPod needs), removes ID3v1 and embeds `Folder.jpg` as a
  256×256 cover. A dialog explains the changes and previews them first. **This rewrites the original
  files** – try it on a copy.

In the iPod pane's header:

- **Eject** – safely removes the iPod like "Eject" in Explorer (it releases the drive from WSL first, then
  asks Windows to eject it). Always use it before unplugging: otherwise Windows may not have written the
  last changes to the iPod yet.
- **Empty library…** – "resets" the iPod's music: removes every track from the database and deletes
  every file in `iPod_Control/Music`. Firmware, settings, photos and other files stay. A dialog lists
  exactly what happens and you have to type `RESET` to confirm. The deleted audio files cannot be
  restored.
- **Firmware…** – explains how to restore the iPod's *firmware* from an Apple firmware image
  (`.ipsw`). The app can't do this itself: it only manages the music database (libgpod), and
  writing firmware needs Apple's own restore tool (iTunes for Windows). The dialog walks through
  reset, disk mode and the restore, and is available even when no iPod is detected.

## Safety

- Before every change the app copies `iPod_Control/iTunes/iTunesDB` to `iTunesDB.previous.bak` (undo
  the last operation) and, once, to `iTunesDB.pristine.bak` (the state before this app ever touched
  the iPod). Only `iTunesDB` is backed up – **not** the artwork database in `iPod_Control/Artwork`.
- Copying a track also writes its embedded cover to the iPod's artwork database so the iPod can show
  it. This part is experimental; if you care about the iPod's contents, back up the whole iPod first.
- Don't unplug the iPod or close the app while a copy or delete is running.

## Troubleshooting

- **The iPod shows "No Music" after copying** – an iPod Classic only accepts a database that is signed
  with its FireWire GUID. The app can do that only if it knows the iPod's model and GUID, which
  normally come from `iPod_Control/Device/SysInfo` – empty on an iPod that never synced with iTunes
  (or was just restored). The iPod pane then shows `Model: unknown` and a **Repair…** button: it
  reads the GUID from Windows, lets you pick the model, writes `SysInfo` and re-saves the database
  signed. Afterwards use **Eject** before unplugging the iPod.
- **"No iPod detected"** – the iPod must be in disk mode and appear as a drive in Windows Explorer.
- **"Could not run the iPod helper via WSL"** – WSL2 or the `Ubuntu-24.04` distro is missing (check
  `wsl -l -v`), or `wsl/build/ipodctl` hasn't been built (`npm run build:ipodctl`).
- **"Couldn't find an iPod database on /mnt/x/"** – WSL's view of the drive is stale (usually after
  re-plugging the iPod). The app remounts automatically; if it persists, run `wsl --shutdown`
  in PowerShell and try again.

## License

MIT, see [LICENSE](LICENSE).
