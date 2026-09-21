/*
 * ipodctl - thin CLI wrapper around libgpod for the "ipod" Electron app.
 *
 * Runs inside WSL (libgpod has no maintained Windows build) and is invoked by the Node
 * backend via `wsl.exe`, operating on the iPod's drive letter mounted at /mnt/<letter>.
 * Every command prints exactly one line of JSON to stdout and exits 0 on success, or
 * prints {"error": "..."} and exits 1 on failure - the Node side just parses that line.
 *
 * ID3/MP4 tag reading happens on the Node side (music-metadata); this tool only talks to
 * libgpod, so tag values for "add" arrive as plain argv strings.
 *
 * Commands:
 *   ipodctl info   <mountpoint>
 *   ipodctl list   <mountpoint>
 *   ipodctl add    <mountpoint> <srcfile> <title> <artist> <album> <genre> <trackNr> <year> <durationMs> <bitrate> <samplerate> <filetype>
 *   ipodctl remove <mountpoint> <trackId>
 *   ipodctl extract <mountpoint> <trackId> <destfile>
 */

#include <gpod/itdb.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/statvfs.h>
#include <unistd.h>

static void json_escape_into(GString *buf, const char *s) {
  g_string_append_c(buf, '"');
  for (const unsigned char *p = (const unsigned char *)s; s && *p; p++) {
    switch (*p) {
      case '"': g_string_append(buf, "\\\""); break;
      case '\\': g_string_append(buf, "\\\\"); break;
      case '\n': g_string_append(buf, "\\n"); break;
      case '\r': g_string_append(buf, "\\r"); break;
      case '\t': g_string_append(buf, "\\t"); break;
      default:
        if (*p < 0x20) g_string_append_printf(buf, "\\u%04x", *p);
        else g_string_append_c(buf, (char)*p);
    }
  }
  g_string_append_c(buf, '"');
}

static void jstr(GString *buf, const char *key, const char *val, gboolean comma) {
  g_string_append_c(buf, '"');
  g_string_append(buf, key);
  g_string_append(buf, "\":");
  if (val) json_escape_into(buf, val);
  else g_string_append(buf, "null");
  if (comma) g_string_append_c(buf, ',');
}

static void jint(GString *buf, const char *key, gint64 val, gboolean comma) {
  g_string_append_c(buf, '"');
  g_string_append(buf, key);
  g_string_append_printf(buf, "\":%lld", (long long)val);
  if (comma) g_string_append_c(buf, ',');
}

static int fail(const char *msg) {
  GString *buf = g_string_new("{");
  jstr(buf, "error", msg, FALSE);
  g_string_append_c(buf, '}');
  puts(buf->str);
  g_string_free(buf, TRUE);
  return 1;
}

static int fail_gerror(const char *fallback, GError *error) {
  int rc = fail(error && error->message ? error->message : fallback);
  if (error) g_error_free(error);
  return rc;
}

/* Fills in the free/total bytes of the filesystem backing `mountpoint`. */
static void disk_space(const char *mountpoint, guint64 *free_bytes, guint64 *total_bytes) {
  struct statvfs st;
  *free_bytes = 0;
  *total_bytes = 0;
  if (statvfs(mountpoint, &st) == 0) {
    *free_bytes = (guint64)st.f_bavail * st.f_frsize;
    *total_bytes = (guint64)st.f_blocks * st.f_frsize;
  }
}

static int cmd_info(const char *mountpoint) {
  GError *error = NULL;
  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) return fail_gerror("Could not read iTunesDB on this drive", error);

  const Itdb_IpodInfo *info = itdb_device_get_ipod_info(itdb->device);
  guint64 freeBytes, totalBytes;
  disk_space(mountpoint, &freeBytes, &totalBytes);

  GString *buf = g_string_new("{");
  jstr(buf, "modelNumber", info ? info->model_number : NULL, TRUE);
  jstr(buf, "generation", info ? itdb_info_get_ipod_generation_string(info->ipod_generation) : NULL, TRUE);
  jstr(buf, "modelName", info ? itdb_info_get_ipod_model_name_string(info->ipod_model) : NULL, TRUE);
  jint(buf, "capacityGB", info ? (gint64)info->capacity : 0, TRUE);
  jint(buf, "trackCount", (gint64)g_list_length(itdb->tracks), TRUE);
  jint(buf, "freeBytes", (gint64)freeBytes, TRUE);
  jint(buf, "totalBytes", (gint64)totalBytes, FALSE);
  g_string_append_c(buf, '}');
  puts(buf->str);
  g_string_free(buf, TRUE);
  itdb_free(itdb);
  return 0;
}

static void append_track_json(GString *buf, Itdb_Track *track, gboolean comma) {
  g_string_append_c(buf, '{');
  jint(buf, "id", track->id, TRUE);
  jstr(buf, "title", track->title, TRUE);
  jstr(buf, "artist", track->artist, TRUE);
  jstr(buf, "album", track->album, TRUE);
  jstr(buf, "genre", track->genre, TRUE);
  jint(buf, "trackNr", track->track_nr, TRUE);
  jint(buf, "year", track->year, TRUE);
  jint(buf, "durationMs", track->tracklen, TRUE);
  jint(buf, "sizeBytes", track->size, TRUE);
  jint(buf, "bitrate", track->bitrate, TRUE);
  jstr(buf, "ipodPath", track->ipod_path, FALSE);
  g_string_append_c(buf, '}');
  if (comma) g_string_append_c(buf, ',');
}

static int cmd_list(const char *mountpoint) {
  GError *error = NULL;
  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) return fail_gerror("Could not read iTunesDB on this drive", error);

  GString *buf = g_string_new("{\"tracks\":[");
  for (GList *it = itdb->tracks; it != NULL; it = it->next) {
    append_track_json(buf, (Itdb_Track *)it->data, it->next != NULL);
  }
  g_string_append(buf, "]}");
  puts(buf->str);
  g_string_free(buf, TRUE);
  itdb_free(itdb);
  return 0;
}

static const char *guess_filetype(const char *path) {
  const char *dot = strrchr(path, '.');
  if (!dot) return "MP3-file";
  if (g_ascii_strcasecmp(dot, ".mp3") == 0) return "MP3-file";
  if (g_ascii_strcasecmp(dot, ".m4a") == 0) return "AAC-file";
  if (g_ascii_strcasecmp(dot, ".m4b") == 0) return "AAC-file";
  if (g_ascii_strcasecmp(dot, ".aac") == 0) return "AAC-file";
  if (g_ascii_strcasecmp(dot, ".wav") == 0) return "WAV-file";
  return "MP3-file";
}

static gchar *opt(const char *s) {
  return (s && s[0] != '\0') ? g_strdup(s) : NULL;
}

static int cmd_add(int argc, char **argv) {
  /* argv: add <mountpoint> <srcfile> <title> <artist> <album> <genre> <trackNr> <year> <durationMs> <bitrate> <samplerate> <filetype> */
  if (argc < 14) return fail("add requires mountpoint, srcfile, title, artist, album, genre, trackNr, year, durationMs, bitrate, samplerate, filetype");
  const char *mountpoint = argv[2];
  const char *srcfile = argv[3];

  GError *error = NULL;
  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) return fail_gerror("Could not read iTunesDB on this drive", error);

  if (access(srcfile, R_OK) != 0) {
    itdb_free(itdb);
    return fail("Source file is not readable");
  }

  Itdb_Track *track = itdb_track_new();
  track->title = opt(argv[4]);
  if (!track->title) track->title = g_path_get_basename(srcfile);
  track->artist = opt(argv[5]);
  track->album = opt(argv[6]);
  track->genre = opt(argv[7]);
  track->track_nr = atoi(argv[8]);
  track->year = atoi(argv[9]);
  track->tracklen = atoi(argv[10]);
  track->bitrate = atoi(argv[11]);
  track->samplerate = (guint16)atoi(argv[12]);
  track->filetype = g_strdup(argv[13][0] ? argv[13] : guess_filetype(srcfile));

  itdb_track_add(itdb, track, -1);
  itdb_playlist_add_track(itdb_playlist_mpl(itdb), track, -1);

  if (!itdb_cp_track_to_ipod(track, srcfile, &error)) {
    itdb_track_unlink(track);
    itdb_track_free(track);
    itdb_free(itdb);
    return fail_gerror("Could not copy file onto the iPod", error);
  }

  if (!itdb_write(itdb, &error)) {
    itdb_free(itdb);
    return fail_gerror("Could not write iTunesDB", error);
  }

  GString *buf = g_string_new("{");
  jint(buf, "id", track->id, TRUE);
  jstr(buf, "ipodPath", track->ipod_path, FALSE);
  g_string_append_c(buf, '}');
  puts(buf->str);
  g_string_free(buf, TRUE);
  itdb_free(itdb);
  return 0;
}

static int cmd_remove(const char *mountpoint, guint32 trackId) {
  GError *error = NULL;
  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) return fail_gerror("Could not read iTunesDB on this drive", error);

  Itdb_Track *track = itdb_track_by_id(itdb, trackId);
  if (!track) {
    itdb_free(itdb);
    return fail("Track not found");
  }

  gchar *realfile = itdb_filename_on_ipod(track);
  /* itdb_playlist_remove_track(NULL, ...) only detaches from the master playlist, so walk
     every playlist explicitly - otherwise a playlist could keep a dangling pointer. */
  for (GList *pl = itdb->playlists; pl != NULL; pl = pl->next) {
    itdb_playlist_remove_track((Itdb_Playlist *)pl->data, track);
  }
  itdb_track_unlink(track);
  itdb_track_free(track);

  if (realfile) {
    g_unlink(realfile);
    g_free(realfile);
  }

  if (!itdb_write(itdb, &error)) {
    itdb_free(itdb);
    return fail_gerror("Could not write iTunesDB", error);
  }

  puts("{\"removed\":true}");
  itdb_free(itdb);
  return 0;
}

static int cmd_extract(const char *mountpoint, guint32 trackId, const char *destfile) {
  GError *error = NULL;
  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) return fail_gerror("Could not read iTunesDB on this drive", error);

  Itdb_Track *track = itdb_track_by_id(itdb, trackId);
  if (!track) {
    itdb_free(itdb);
    return fail("Track not found");
  }

  gchar *realfile = itdb_filename_on_ipod(track);
  if (!realfile) {
    itdb_free(itdb);
    return fail("Could not resolve track path on the iPod");
  }

  if (!itdb_cp(realfile, destfile, &error)) {
    g_free(realfile);
    itdb_free(itdb);
    return fail_gerror("Could not copy file from the iPod", error);
  }
  g_free(realfile);

  GString *buf = g_string_new("{");
  jstr(buf, "destfile", destfile, FALSE);
  g_string_append_c(buf, '}');
  puts(buf->str);
  g_string_free(buf, TRUE);
  itdb_free(itdb);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    return fail("Usage: ipodctl <info|list|add|remove|extract> <mountpoint> [...]");
  }
  const char *cmd = argv[1];
  const char *mountpoint = argv[2];

  if (strcmp(cmd, "info") == 0) return cmd_info(mountpoint);
  if (strcmp(cmd, "list") == 0) return cmd_list(mountpoint);
  if (strcmp(cmd, "add") == 0) return cmd_add(argc, argv);
  if (strcmp(cmd, "remove") == 0) {
    if (argc < 4) return fail("remove requires mountpoint and trackId");
    return cmd_remove(mountpoint, (guint32)strtoul(argv[3], NULL, 10));
  }
  if (strcmp(cmd, "extract") == 0) {
    if (argc < 5) return fail("extract requires mountpoint, trackId and destfile");
    return cmd_extract(mountpoint, (guint32)strtoul(argv[3], NULL, 10), argv[4]);
  }
  return fail("Unknown command");
}
