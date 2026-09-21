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
 * Parsing the iTunesDB and (for writes) writing it back dominate the run time of every command,
 * so the *-batch commands (and "remove" with several ids) handle many tracks per invocation.
 *
 * Commands:
 *   ipodctl info   <mountpoint>
 *   ipodctl list   <mountpoint>
 *   ipodctl add    <mountpoint> <srcfile> <title> <artist> <album> <genre> <trackNr> <year> <durationMs> <bitrate> <samplerate> <filetype> [coverfile]
 *   ipodctl add-batch <mountpoint> <batchfile>      (one tab-separated line per track, same columns as "add")
 *   ipodctl remove <mountpoint> <trackId>...
 *   ipodctl reset  <mountpoint>                     (removes ALL tracks and deletes all files in iPod_Control/Music)
 *   ipodctl extract <mountpoint> <trackId> <destfile>
 *   ipodctl extract-batch <mountpoint> <batchfile>  (one "<trackId>\t<destfile>" line per track)
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

/* Fields of one track to add, in the order of the CLI arguments / batch-file columns:
   srcfile, title, artist, album, genre, trackNr, year, durationMs, bitrate, samplerate,
   filetype, coverfile (any of them may be empty except srcfile). */
#define ADD_FIELDS 12

/* Copies one file onto the iPod and adds it to the in-memory database (the caller writes the
   iTunesDB once it is done - writing is by far the slowest step, so batches share one write). */
static Itdb_Track *add_track_to_db(Itdb_iTunesDB *itdb, char *const *f, gboolean *artwork, GError **error) {
  const char *srcfile = f[0];
  *artwork = FALSE;

  if (access(srcfile, R_OK) != 0) {
    g_set_error_literal(error, G_FILE_ERROR, G_FILE_ERROR_ACCES, "Source file is not readable");
    return NULL;
  }

  Itdb_Track *track = itdb_track_new();
  track->title = opt(f[1]);
  if (!track->title) track->title = g_path_get_basename(srcfile);
  track->artist = opt(f[2]);
  track->album = opt(f[3]);
  track->genre = opt(f[4]);
  track->track_nr = atoi(f[5]);
  track->year = atoi(f[6]);
  track->tracklen = atoi(f[7]);
  track->bitrate = atoi(f[8]);
  track->samplerate = (guint16)atoi(f[9]);
  track->filetype = g_strdup(f[10][0] ? f[10] : guess_filetype(srcfile));

  itdb_track_add(itdb, track, -1);
  itdb_playlist_add_track(itdb_playlist_mpl(itdb), track, -1);

  if (!itdb_cp_track_to_ipod(track, srcfile, error)) {
    itdb_track_unlink(track);
    itdb_track_free(track);
    return NULL;
  }

  /* Optional cover image (a jpg/png file extracted by the Node side). Best-effort: a model
     without artwork support or an unreadable image must not fail the whole copy. */
  if (f[11][0] != '\0' && itdb_device_supports_artwork(itdb->device)) {
    *artwork = itdb_track_set_thumbnails(track, f[11]);
  }
  return track;
}

/* Reads a batch file into its lines (a trailing "\r" is dropped; tabs are kept - they separate
   the columns, and empty trailing columns must survive). Callers skip empty lines. */
static gchar **read_batch_lines(const char *batchfile, GError **error) {
  gchar *contents = NULL;
  if (!g_file_get_contents(batchfile, &contents, NULL, error)) return NULL;
  gchar **lines = g_strsplit(contents, "\n", -1);
  g_free(contents);
  for (gchar **l = lines; *l; l++) {
    size_t len = strlen(*l);
    if (len > 0 && (*l)[len - 1] == '\r') (*l)[len - 1] = '\0';
  }
  return lines;
}

/* Long-running batch commands print a {"progress":<items done>} line after each item (the Node
   side streams stdout and shows a progress bar); the last line is still the final result. */
static void report_progress(int done) {
  printf("{\"progress\":%d}\n", done);
  fflush(stdout);
}

static void append_error_entry(GString *buf, const char *msg) {
  g_string_append_c(buf, '{');
  jstr(buf, "error", msg, FALSE);
  g_string_append_c(buf, '}');
}

static int cmd_add(int argc, char **argv) {
  /* argv: add <mountpoint> <srcfile> <title> <artist> <album> <genre> <trackNr> <year> <durationMs> <bitrate> <samplerate> <filetype> [coverfile] */
  if (argc < 14) return fail("add requires mountpoint, srcfile, title, artist, album, genre, trackNr, year, durationMs, bitrate, samplerate, filetype");
  const char *mountpoint = argv[2];

  GError *error = NULL;
  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) return fail_gerror("Could not read iTunesDB on this drive", error);

  char *fields[ADD_FIELDS];
  for (int i = 0; i < 11; i++) fields[i] = argv[3 + i];
  fields[11] = argc > 14 ? argv[14] : (char *)"";

  gboolean artwork;
  Itdb_Track *track = add_track_to_db(itdb, fields, &artwork, &error);
  if (!track) {
    itdb_free(itdb);
    return fail_gerror("Could not copy file onto the iPod", error);
  }

  if (!itdb_write(itdb, &error)) {
    itdb_free(itdb);
    return fail_gerror("Could not write iTunesDB", error);
  }

  GString *buf = g_string_new("{");
  jint(buf, "id", track->id, TRUE);
  jint(buf, "artwork", artwork ? 1 : 0, TRUE);
  jstr(buf, "ipodPath", track->ipod_path, FALSE);
  g_string_append_c(buf, '}');
  puts(buf->str);
  g_string_free(buf, TRUE);
  itdb_free(itdb);
  return 0;
}

/* add-batch <mountpoint> <batchfile>: one line per track, ADD_FIELDS tab-separated columns.
   Parses the database once and writes it once, however many tracks there are. Prints
   {"results":[{"id":..,"artwork":..,"ipodPath":..} | {"error":..}, ...]} in input order. */
static int cmd_add_batch(const char *mountpoint, const char *batchfile) {
  GError *error = NULL;
  gchar **lines = read_batch_lines(batchfile, &error);
  if (!lines) return fail_gerror("Could not read the batch file", error);

  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) {
    g_strfreev(lines);
    return fail_gerror("Could not read iTunesDB on this drive", error);
  }

  GString *buf = g_string_new("{\"results\":[");
  int added = 0, entries = 0;
  for (gchar **l = lines; *l; l++) {
    if ((*l)[0] == '\0') continue;
    if (entries++ > 0) g_string_append_c(buf, ',');

    gchar **f = g_strsplit(*l, "\t", -1);
    if (g_strv_length(f) < ADD_FIELDS) {
      append_error_entry(buf, "Malformed batch line");
    } else {
      GError *track_error = NULL;
      gboolean artwork;
      Itdb_Track *track = add_track_to_db(itdb, f, &artwork, &track_error);
      if (!track) {
        append_error_entry(buf, track_error && track_error->message ? track_error->message : "Could not copy file onto the iPod");
        if (track_error) g_error_free(track_error);
      } else {
        added++;
        g_string_append_c(buf, '{');
        jint(buf, "id", track->id, TRUE);
        jint(buf, "artwork", artwork ? 1 : 0, TRUE);
        jstr(buf, "ipodPath", track->ipod_path, FALSE);
        g_string_append_c(buf, '}');
      }
    }
    g_strfreev(f);
    report_progress(entries);
  }
  g_string_append(buf, "]}");
  g_strfreev(lines);

  if (added > 0 && !itdb_write(itdb, &error)) {
    g_string_free(buf, TRUE);
    itdb_free(itdb);
    return fail_gerror("Could not write iTunesDB", error);
  }

  puts(buf->str);
  g_string_free(buf, TRUE);
  itdb_free(itdb);
  return 0;
}

/* remove <mountpoint> <trackId>...: removes any number of tracks with a single database write.
   The audio files are deleted only after the database was written successfully, so an
   interruption can leave orphaned files but never entries that point at missing files. */
static int cmd_remove(const char *mountpoint, int count, char **ids) {
  GError *error = NULL;
  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) return fail_gerror("Could not read iTunesDB on this drive", error);

  GPtrArray *files = g_ptr_array_new_with_free_func(g_free);
  int removed = 0, missing = 0;
  for (int i = 0; i < count; i++) {
    Itdb_Track *track = itdb_track_by_id(itdb, (guint32)strtoul(ids[i], NULL, 10));
    if (!track) {
      missing++;
      continue;
    }
    gchar *realfile = itdb_filename_on_ipod(track);
    if (realfile) g_ptr_array_add(files, realfile);
    /* itdb_playlist_remove_track(NULL, ...) only detaches from the master playlist, so walk
       every playlist explicitly - otherwise a playlist could keep a dangling pointer. */
    for (GList *pl = itdb->playlists; pl != NULL; pl = pl->next) {
      itdb_playlist_remove_track((Itdb_Playlist *)pl->data, track);
    }
    itdb_track_unlink(track);
    itdb_track_free(track);
    removed++;
  }

  if (removed > 0 && !itdb_write(itdb, &error)) {
    g_ptr_array_free(files, TRUE);
    itdb_free(itdb);
    return fail_gerror("Could not write iTunesDB", error);
  }

  for (guint i = 0; i < files->len; i++) {
    g_unlink((const gchar *)g_ptr_array_index(files, i));
    report_progress((int)i + 1);
  }
  g_ptr_array_free(files, TRUE);

  GString *buf = g_string_new("{");
  jint(buf, "removed", removed, TRUE);
  jint(buf, "missing", missing, FALSE);
  g_string_append_c(buf, '}');
  puts(buf->str);
  g_string_free(buf, TRUE);
  itdb_free(itdb);
  return 0;
}

/* reset <mountpoint>: empties the whole library - every track is removed from the database
   (and all playlists), then every file under iPod_Control/Music is deleted, including files the
   database no longer knew about (leftovers of interrupted copies). Firmware, settings and other
   folders stay. As with "remove", the database is written first and files are deleted afterwards. */
static int cmd_reset(const char *mountpoint) {
  GError *error = NULL;
  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) return fail_gerror("Could not read iTunesDB on this drive", error);

  int removed = 0;
  GList *tracks = g_list_copy(itdb->tracks); /* itdb_track_unlink modifies itdb->tracks */
  for (GList *it = tracks; it != NULL; it = it->next) {
    Itdb_Track *track = (Itdb_Track *)it->data;
    for (GList *pl = itdb->playlists; pl != NULL; pl = pl->next) {
      itdb_playlist_remove_track((Itdb_Playlist *)pl->data, track);
    }
    itdb_track_unlink(track);
    itdb_track_free(track);
    removed++;
  }
  g_list_free(tracks);

  if (!itdb_write(itdb, &error)) {
    itdb_free(itdb);
    return fail_gerror("Could not write iTunesDB", error);
  }
  itdb_free(itdb);

  int files = 0;
  gchar *music = g_build_filename(mountpoint, "iPod_Control", "Music", NULL);
  GDir *music_dir = g_dir_open(music, 0, NULL);
  if (music_dir) {
    const gchar *sub;
    while ((sub = g_dir_read_name(music_dir)) != NULL) {
      gchar *subpath = g_build_filename(music, sub, NULL);
      GDir *dir = g_file_test(subpath, G_FILE_TEST_IS_DIR) ? g_dir_open(subpath, 0, NULL) : NULL;
      if (dir) {
        const gchar *name;
        while ((name = g_dir_read_name(dir)) != NULL) {
          gchar *filepath = g_build_filename(subpath, name, NULL);
          if (g_file_test(filepath, G_FILE_TEST_IS_REGULAR) && g_unlink(filepath) == 0) {
            files++;
            report_progress(files);
          }
          g_free(filepath);
        }
        g_dir_close(dir);
      }
      g_free(subpath);
    }
    g_dir_close(music_dir);
  }
  g_free(music);

  GString *buf = g_string_new("{");
  jint(buf, "removedTracks", removed, TRUE);
  jint(buf, "deletedFiles", files, FALSE);
  g_string_append_c(buf, '}');
  puts(buf->str);
  g_string_free(buf, TRUE);
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

/* extract-batch <mountpoint> <batchfile>: one "<trackId>\t<destfile>" line per track; the
   database is parsed once. Prints {"results":[{"destfile":..} | {"error":..}, ...]}. */
static int cmd_extract_batch(const char *mountpoint, const char *batchfile) {
  GError *error = NULL;
  gchar **lines = read_batch_lines(batchfile, &error);
  if (!lines) return fail_gerror("Could not read the batch file", error);

  Itdb_iTunesDB *itdb = itdb_parse(mountpoint, &error);
  if (!itdb) {
    g_strfreev(lines);
    return fail_gerror("Could not read iTunesDB on this drive", error);
  }

  GString *buf = g_string_new("{\"results\":[");
  int entries = 0;
  for (gchar **l = lines; *l; l++) {
    if ((*l)[0] == '\0') continue;
    if (entries++ > 0) g_string_append_c(buf, ',');

    gchar **f = g_strsplit(*l, "\t", 2);
    if (g_strv_length(f) < 2) {
      append_error_entry(buf, "Malformed batch line");
    } else {
      Itdb_Track *track = itdb_track_by_id(itdb, (guint32)strtoul(f[0], NULL, 10));
      gchar *realfile = track ? itdb_filename_on_ipod(track) : NULL;
      GError *copy_error = NULL;
      if (!track) {
        append_error_entry(buf, "Track not found");
      } else if (!realfile) {
        append_error_entry(buf, "Could not resolve track path on the iPod");
      } else if (!itdb_cp(realfile, f[1], &copy_error)) {
        append_error_entry(buf, copy_error && copy_error->message ? copy_error->message : "Could not copy file from the iPod");
      } else {
        g_string_append_c(buf, '{');
        jstr(buf, "destfile", f[1], FALSE);
        g_string_append_c(buf, '}');
      }
      if (copy_error) g_error_free(copy_error);
      g_free(realfile);
    }
    g_strfreev(f);
    report_progress(entries);
  }
  g_string_append(buf, "]}");
  g_strfreev(lines);

  puts(buf->str);
  g_string_free(buf, TRUE);
  itdb_free(itdb);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    return fail("Usage: ipodctl <info|list|add|add-batch|remove|extract|extract-batch> <mountpoint> [...]");
  }
  const char *cmd = argv[1];
  const char *mountpoint = argv[2];

  if (strcmp(cmd, "info") == 0) return cmd_info(mountpoint);
  if (strcmp(cmd, "list") == 0) return cmd_list(mountpoint);
  if (strcmp(cmd, "add") == 0) return cmd_add(argc, argv);
  if (strcmp(cmd, "add-batch") == 0) {
    if (argc < 4) return fail("add-batch requires mountpoint and batchfile");
    return cmd_add_batch(mountpoint, argv[3]);
  }
  if (strcmp(cmd, "remove") == 0) {
    if (argc < 4) return fail("remove requires mountpoint and at least one trackId");
    return cmd_remove(mountpoint, argc - 3, argv + 3);
  }
  if (strcmp(cmd, "reset") == 0) return cmd_reset(mountpoint);
  if (strcmp(cmd, "extract") == 0) {
    if (argc < 5) return fail("extract requires mountpoint, trackId and destfile");
    return cmd_extract(mountpoint, (guint32)strtoul(argv[3], NULL, 10), argv[4]);
  }
  if (strcmp(cmd, "extract-batch") == 0) {
    if (argc < 4) return fail("extract-batch requires mountpoint and batchfile");
    return cmd_extract_batch(mountpoint, argv[3]);
  }
  return fail("Unknown command");
}
