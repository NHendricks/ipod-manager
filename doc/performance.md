# iPod copy speed: measurement (2026-09-22)

## Report

Copying to/from the iPod is limited to about **3.3–3.6 MB/s**, on this iPod
(FireWire GUID `000A27001391769B`), regardless of app code. This is a
hardware/USB-level ceiling, not something the app's code causes or can fix.

## Commits involved

- `eb0c367` "add feature to extract mp3" — the commit the user temporarily
  checked out to (`git checkout eb0c367`), from *before* this session's work
  (batching, job/progress system, drive selector, eject, repair, README, …).
- `0c2a230` "add drive selection on windows dir" — tip of `main`, the commit
  with all of this session's work, used as "new" in the comparison below.

## Why this was investigated

The user reported that reading from the iPod (copying from iPod to PC) was
very slow. Later, after running `git checkout eb0c367` to go back in history,
they observed copying in the app to be about 50x faster and asked for a
measurement to confirm.

## How it was tested

1. **Raw hardware/OS level (no app code at all)**: called `wsl/build/ipodctl
   extract` directly, and separately did a plain Windows `fs.copyFileSync`
   and a raw `fs.readSync` loop, all against **fresh, never-before-read**
   files on the iPod (~90–175 MB each, picked from a live `ipodctl list`).
   Result: ~3.4–3.6 MB/s across all three methods — identical whether going
   through WSL or reading directly with Node/Windows.
   - A first attempt at this measurement (73 MB file) misleadingly showed
     ~130 MB/s because that file had already been read earlier in the
     session and was served from the Windows file-system cache. Switching to
     files never read before in the session gave the consistent ~3.4 MB/s
     figure.

2. **App level, A/B, same method both times**: with the iPod's track list
   fetched once, picked two different, previously-unread tracks of nearly
   identical size (89.3–89.4 MB). Started the backend once per commit and
   drove the real HTTP API exactly as the UI does:
   - **Old code** (`eb0c367`, checked out): `POST
     /api/ipod/tracks/:id/export` (the old single-track endpoint).
     Result: 89.3 MB in 26.1 s = **3.4 MB/s**.
   - **New code** (`main` @ `0c2a230`): `POST /api/ipod/export` (job-based
     batch endpoint) + polling `GET /api/jobs/:id` until finished, same as
     `local-pane.ts`'s `exportTracks()`.
     Result: 89.3 MB in 26.8 s = **3.3 MB/s**.

   Practically identical — no measurable regression from this session's
   changes (batching, progress jobs, cover-art extraction on export, mount
   check caching, etc.).

3. Checked out back to `main` afterwards so the user's full day of work
   (all commits through `0c2a230`) is the checked-out state again. Temporary
   test files/dirs and a stray leftover shell process from an earlier test
   were cleaned up.

## Conclusion

The transfer speed is bottlenecked by the iPod/USB connection itself (or its
current mode/driver state), not by the app's code — the git checkout did not
change the measured throughput at the hardware or app level. The most likely
explanation for the "50x faster" impression is that the fast run happened to
re-read a file the OS had already cached from an earlier read in the same
session, while the slow run read a fresh file. This wasn't independently
confirmed with the user; if it happens again, exporting the *same*
never-before-copied track twice in a row and timing both runs would confirm
it (second run fast regardless of app version = cache; second run also slow
= a real difference worth investigating further).

## Follow-up (2026-09-22): why the reported MB/s varies between exports

The UI's "X MB in Y s (Z MB/s)" report (`formatTransferReport` in
`frontend/src/progress.ts`) is not a measured instantaneous rate — it's
`bytesTransferred / elapsedMs` for the *whole batch job*:

- `bytesTransferred` (`backend/src/index.ts`, `exportTracksJob` /
  `POST /api/ipod/tracks`) is the sum of each track's known size (from the
  iTunesDB / `fs.stat`), not bytes actually read off the device.
- `elapsedMs` (`jobs.ts`) is wall-clock time from `startedAt` to
  `finishedAt` for the whole job, which can cover many tracks copied one
  after another (`wsl/ipodctl.c`'s `cmd_extract_batch` copies them
  sequentially, no parallelism).

So a single reported speed can blend multiple tracks with very different
real read speeds: any track whose file is already sitting in the Windows or
WSL page cache (copied/previewed earlier) reads at RAM speed (~100+ MB/s, as
seen in a real export: 254.0 MB in 2.4 s = 105.9 MB/s), while any track read
fresh off the iPod is capped at the ~3.4 MB/s hardware limit above. A batch
mixing a few cached tracks with a few fresh ones averages out to something
in between — e.g. ~10 MB/s — rather than landing cleanly on 3.4 MB/s or on a
full-cache speed. So "sometimes 100+ MB/s, sometimes only ~10 MB/s" is
consistent with the same cache effect as above, just applied per-track
within a multi-track batch instead of all-or-nothing for a single file.

This still hasn't been directly confirmed track-by-track (e.g. by logging
each file's individual copy time in `cmd_extract_batch`) - the reasoning
above is inferred from the code path and the earlier single-file
measurements, not re-measured. If it's worth pinning down further, adding
per-file timing to `extract-batch`'s progress output would show exactly
which tracks in a batch were slow vs. fast.

## Correction (2026-09-22): the ~3.5 MB/s ceiling was WSL/drvfs, not the iPod

Per-track timing was added (`fprintf(stderr, ...)` in `cmd_extract_batch`,
forwarded to the backend's console via `spawnIpodctl`'s new stderr listener
in `ipod.ts`). A real export of a large batch (tracks 346-373 of a
3730-track selection) showed:

- Tracks 346-363 (~9 tracks, ~60-70 MB each): **104-123 MB/s**.
- Track 365: a transitional 19.9 MB/s.
- Track 367 onward: a flat, unwavering **3.5-3.6 MB/s** - not fluctuating
  between fast and slow track-to-track as the earlier "cache mix" theory
  predicted, but a one-time cliff that then stayed down.

The user reported that **iTunes never shows this slowdown on the same iPod**
- it's always fast. That's the key fact the original conclusion above missed
(it only ever A/B'd this app's own commits against each other and against
raw WSL/`fs.readSync`/`fs.copyFileSync` calls - never against a real native
Windows program). If the FireWire/USB link itself were capped at ~3.5 MB/s,
iTunes would hit the same ceiling. It doesn't, so the bottleneck is specific
to *this app's* access path, not the hardware.

The actual difference: this app's export went through `ipodctl` running
**inside WSL2**, reading the source file from the iPod (`/mnt/<letter>/...`)
and writing the destination file (also `/mnt/<letter>/...`) - both ends
relayed through WSL2's drvfs (9p protocol) bridge to the Windows filesystem.
iTunes, a native Windows program, talks to the same NTFS/exFAT/FAT32 driver
directly, no 9p hop at all. The initial fast tracks were most likely served
from a cache (Windows' or WSL's) built up from earlier work in the same
session; once that ran out, every further track hit 9p's real, sustained
throughput ceiling - which just happens to land in the same ~3.3-3.6 MB/s
range as the original raw-WSL measurement, because that measurement *also*
went through the same drvfs bridge (it never compared against a non-WSL,
non-libgpod code path either).

**Fix applied**: `exportTracksJob` (`backend/src/index.ts`) no longer calls
`ipodctl extract-batch` for the byte copy. The source file is just a regular
file on the iPod's Windows drive letter (`ipod.trackWindowsPath()`, already
existed), so Node now does a plain `fs.copyFile()` - the same native Windows
I/O path iTunes uses, no WSL involved except for the one-time `ipodctl list`
that parses the iTunesDB. `ipod.exportTracks()`/`ExportItem` (the WSL-based
implementation) were removed as dead code; `ipodctl extract`/`extract-batch`
stay in `wsl/ipodctl.c` (still useful for isolated measurement, as in the
original test above) but are no longer called from the app.

**Not yet fixed**: copying files *onto* the iPod (`ipod.addTracks` ->
`ipodctl add-batch`) likely has the same root cause - `itdb_cp_track_to_ipod`
also reads the local source file and writes the iPod file through the same
WSL/drvfs bridge - but isn't trivially bypassable the same way, because
libgpod decides the on-iPod filename/folder (the `F00`-`F49` hashed layout)
as part of that same call. Fixing that direction would need either
reimplementing that placement logic outside libgpod, or finding a way to
tell libgpod "the bytes are already there, just register this path" -
neither attempted yet. If "copying to iPod" is ever reported as unexpectedly
slow, start here rather than assuming it's hardware.
