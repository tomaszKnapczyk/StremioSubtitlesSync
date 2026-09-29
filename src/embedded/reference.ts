import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TtlCache } from "../cache";
import type { ResolvedConfig } from "../config";
import { log } from "../log";
import { TorBoxSource } from "../sources/torbox";
import type { FileHint, ResolvedFile, StreamSource } from "../sources/types";
import type { Cue } from "../subtitles/types";
import {
  planIntervals,
  probeMedia,
  RateLimitedError,
  readSubtitleTimings,
  type SubtitleTrack,
} from "./ffprobe";
import { readIndexedSubtitles, type IndexedTrack } from "./mkvcues";
import { hashRemoteFile } from "./oshash";

/**
 * Builds a timing reference out of the video's own subtitle track.
 *
 * This is the fallback for the case option A cannot cover: OpenSubtitles has
 * never seen this file, so nothing in its index is known to match. The video
 * itself, though, usually carries a subtitle track that is correct by
 * definition. We do not need its words, only its timings, so a handful of short
 * reads scattered through the file is enough.
 *
 * It runs in two stages on purpose. The probe is cheap and answers "is this
 * possible", so it can run while the subtitle list is being built. The read is
 * expensive and only runs when a player actually asks for a file.
 */

export interface EmbeddedTarget {
  file: ResolvedFile;
  /** The best track. Kept for callers that only want the headline answer. */
  track: SubtitleTrack;
  /** Every usable track, best first, so a sparse one can be given up on. */
  tracks: SubtitleTrack[];
  durationSeconds: number;
}

/** Below this the reference is too thin to align anything against. */
const MIN_CUES = 15;
/**
 * How many tracks to try before giving up on the file.
 *
 * Sampling is the expensive path: each attempt pulls windows out of the video
 * over the network and was measured at tens of seconds, while the player waits
 * about ten for the whole answer. Three is as far as that can reasonably go.
 *
 * Reading the file's own subtitle index costs a fraction of a second, so there
 * the limit can be far higher -- and it needs to be, because a file carrying
 * eight tracks of on-screen text before its real one would otherwise be given
 * up on while the usable track sat two places down the list.
 */
const MAX_TRACK_ATTEMPTS = 3;
const MAX_INDEXED_TRACK_ATTEMPTS = 10;

/**
 * How long a found file is kept. The answer cannot change for a given file, but
 * it carries a download link that lasts about three hours, and TorBox links are
 * themselves cached for up to an hour. An hour here keeps every link handed out
 * well inside its life.
 */
const PROBE_TTL_MS = 60 * 60_000;
const probeCache = new TtlCache<EmbeddedTarget | null>(PROBE_TTL_MS, 200);
/** A reference costs real bandwidth, so it is held for a long time. */
const referenceCache = new TtlCache<Cue[] | null>(24 * 60 * 60_000, 100);
/**
 * Failures are remembered too, so a file with nothing usable in it is not read
 * again on every request. Only briefly though: an expired link, a refused
 * connection or a slow CDN all look the same as "nothing here", and none of
 * them should keep a file out for a day.
 */
const FAILURE_TTL_MS = 30 * 60_000;
/** One read per video at a time. A second request for it waits for the first. */
const referenceInFlight = new Map<string, Promise<Cue[] | null>>();

export function streamSourceFor(config: ResolvedConfig): StreamSource | null {
  if (config.torboxApiKey) return new TorBoxSource(config.torboxApiKey);
  return null;
}

/**
 * One entry per video per account. A probe holds that account's download link,
 * and whether the file is there at all differs between accounts. Only a hash of
 * the key goes into the cache key.
 */
function cacheKey(hint: FileHint, config: ResolvedConfig): string {
  const account = createHash("sha256")
    .update(config.torboxApiKey ?? "")
    .digest("hex")
    .slice(0, 16);
  return `${account}:${hint.videoHash ?? `${hint.videoSize ?? 0}:${hint.filename ?? ""}`}`;
}

/**
 * Picks the track to read.
 *
 * Forced tracks are ruled out: they only cover foreign-language lines, so most
 * of the dialogue is missing and they make a poor reference. Text tracks are
 * preferred over image tracks only because they are more predictable, not
 * because the words matter.
 */
export function rankTracks(
  tracks: SubtitleTrack[],
  preferredLanguages: string[],
): SubtitleTrack[] {
  const usable = tracks.filter((track) => !track.forced);

  // An untagged track is not a worse track, only an unlabelled one, and in
  // practice it is often the film's own full subtitle stream -- which is
  // exactly what a timing reference wants. A track labelled with a language
  // nobody asked for is a likelier dead end, so it ranks below the unlabelled
  // one rather than beside it.
  const languageRank = (track: SubtitleTrack): number => {
    const language = track.language;
    if (language === undefined || language === "und" || language === "" ) {
      return preferredLanguages.length;
    }
    const index = preferredLanguages.indexOf(language);
    return index === -1 ? preferredLanguages.length + 1 : index;
  };

  return [...usable].sort((a, b) => {
    if (a.bitmap !== b.bitmap) return a.bitmap ? 1 : -1;
    const byLanguage = languageRank(a) - languageRank(b);
    if (byLanguage !== 0) return byLanguage;
    return a.order - b.order;
  });
}

export function pickTrack(
  tracks: SubtitleTrack[],
  preferredLanguages: string[],
): SubtitleTrack | null {
  return rankTracks(tracks, preferredLanguages)[0] ?? null;
}

/**
 * Finds the file and checks it carries a usable subtitle track.
 *
 * Reads only container headers plus 128 KiB for the hash check, so this is safe
 * to call while answering a subtitles request.
 */
export async function probeEmbedded(
  hint: FileHint,
  config: ResolvedConfig,
): Promise<EmbeddedTarget | null> {
  const source = streamSourceFor(config);
  if (!source) return null;

  return probeCache.wrap(`probe:${cacheKey(hint, config)}`, async () => {
    let candidates: ResolvedFile[];
    try {
      candidates = await source.resolve(hint);
    } catch (error) {
      log.warn(`${source.name} lookup failed: ${describe(error)}`);
      return null;
    }

    for (const file of candidates) {
      // Confirm it is byte for byte the file Stremio is playing before trusting
      // anything read out of it. Skipped when the source already proved it, or
      // when Stremio sent no hash to check against.
      if (file.verified) {
        log.debug(`${file.name}: hash confirmed by ${file.source}, no range check needed`);
      } else if (hint.videoHash) {
        const actual = await hashRemoteFile(file.url, file.size).catch(() => null);
        if (actual !== hint.videoHash) {
          log.debug(`${file.name}: hash ${actual ?? "unavailable"} is not ${hint.videoHash}`);
          continue;
        }
      } else if (hint.videoSize !== undefined && file.size !== hint.videoSize) {
        continue;
      }

      const media = await probeMedia(file.url);
      if (!media || media.tracks.length === 0) {
        log.info(`${file.name} carries no subtitle track`);
        continue;
      }

      const tracks = rankTracks(media.tracks, config.anchorLanguages);
      if (tracks.length === 0) continue;

      log.info(
        `embedded reference available for ${file.name}: ` +
          `${tracks.length} candidate track(s), best is ` +
          `${tracks[0]!.order} (${tracks[0]!.codec}, ${tracks[0]!.language ?? "unknown"})`,
      );
      return { file, track: tracks[0]!, tracks, durationSeconds: media.durationSeconds };
    }

    return null;
    // A miss is often temporary (a failed lookup, a slow CDN), so it is not
    // kept for as long as a find.
  }, (target) => (target ? PROBE_TTL_MS : FAILURE_TTL_MS));
}

/**
 * Builds the cues to align against: from the file's subtitle index when it has
 * a usable one, from sampled windows otherwise.
 */
export async function embeddedReference(
  hint: FileHint,
  config: ResolvedConfig,
): Promise<Cue[] | null> {
  const key = `ref:${cacheKey(hint, config)}`;
  const cached = referenceCache.get(key);
  if (cached !== undefined) return cached;

  // Picking a second subtitle, or a player retry, while the first read is still
  // running would open another set of connections to the same file. That is
  // exactly what gets a debrid link refused.
  const pending = referenceInFlight.get(key);
  if (pending) return pending;

  // A rejection is not cached: a refused read says nothing about the file.
  const task = buildReference(hint, config)
    .then(({ cues, ttlMs }) => {
      referenceCache.set(key, cues, ttlMs);
      return cues;
    })
    .finally(() => referenceInFlight.delete(key));
  referenceInFlight.set(key, task);
  return task;
}

interface BuiltReference {
  cues: Cue[] | null;
  /** How long to keep the result. Unset means the normal, long lifetime. */
  ttlMs?: number;
}

async function buildReference(hint: FileHint, config: ResolvedConfig): Promise<BuiltReference> {
  const target = await probeEmbedded(hint, config);
  if (!target) return { cues: null, ttlMs: FAILURE_TTL_MS };

  // The file's own seek index, when it lists subtitle packets, holds every line
  // in the film for well under a megabyte. Windows are only the fallback: on a
  // quiet film most of them hold nothing, and each one costs real bandwidth.
  const indexed = await indexedReference(target, hint);
  if (indexed) return { cues: indexed };

  const intervals = planIntervals(
    target.durationSeconds,
    config.embeddedWindows,
    config.embeddedWindowSeconds,
  );
  const sampled = intervals.reduce((total, i) => total + i.durationSeconds, 0);

  // A track can look fine in the header and still carry nothing usable:
  // "forced" is often left unset on subtitles that only translate signs, and a
  // karaoke-heavy track loses most of its windows to the saturation check. Both
  // only show up once it has been read, so move on to the next one.
  for (const track of target.tracks.slice(0, MAX_TRACK_ATTEMPTS)) {
    log.info(
      `reading ${intervals.length} windows (${Math.round(sampled)}s) from ` +
        `${target.file.name} track ${track.order} (${track.codec})`,
    );

    const started = Date.now();
    let cues: Cue[];
    try {
      cues = await readSubtitleTimings(target.file.url, track.order, intervals);
    } catch (error) {
      if (!(error instanceof RateLimitedError)) {
        log.warn(`reading track ${track.order} failed: ${describe(error)}`);
        continue;
      }
      // The host refused us, which says nothing about this track. Every other
      // track lives in the same file and would be refused the same way.
      if (error.cues.length < MIN_CUES) throw error;
      log.info(
        `got ${error.cues.length} cues from track ${track.order} with some reads refused, ` +
          `keeping them only briefly`,
      );
      return { cues: error.cues, ttlMs: FAILURE_TTL_MS };
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    if (cues.length >= MIN_CUES) {
      log.info(`got ${cues.length} cues from track ${track.order} in ${seconds}s`);
      dump(`track-${track.order}`, hint, cues);
      return { cues };
    }
    log.info(
      `track ${track.order} gave only ${cues.length} cues in ${seconds}s, ` +
        `too thin to align against (needs ${MIN_CUES}; try more or longer windows)`,
    );
  }

  return { cues: null, ttlMs: FAILURE_TTL_MS };
}

/** Fewer lines than this in the index means it lists only some packets, not every line. */
const MIN_INDEXED_LINES = 50;

/**
 * Reads the reference from the Matroska seek index.
 *
 * Returns null whenever the index cannot stand in for the whole film, so the
 * caller falls back to sampling. A busy host is thrown instead: the windows
 * would be refused the same way.
 */
async function indexedReference(target: EmbeddedTarget, hint: FileHint): Promise<Cue[] | null> {
  const started = Date.now();
  let tracks: IndexedTrack[] | null;
  try {
    tracks = await readIndexedSubtitles(target.file.url);
  } catch (error) {
    if (error instanceof RateLimitedError) throw error;
    log.info(`could not read the subtitle index of ${target.file.name}: ${describe(error)}`);
    return null;
  }
  if (!tracks) {
    log.info(`${target.file.name} has no subtitle index, sampling windows instead`);
    return null;
  }

  // Reading from the index is cheap, so a file that leads with several tracks
  // of on-screen text is not given up on before the real one is reached.
  for (const track of target.tracks.slice(0, MAX_INDEXED_TRACK_ATTEMPTS)) {
    const cues = tracks.find((t) => t.order === track.order)?.cues ?? [];
    if (!coversFilm(cues, target.durationSeconds)) continue;
    log.info(
      `read ${cues.length} lines of track ${track.order} (${track.codec}) from the subtitle ` +
        `index of ${target.file.name} in ${Date.now() - started}ms`,
    );
    dump(`index-track-${track.order}`, hint, cues);
    return cues;
  }

  log.info(`the subtitle index of ${target.file.name} does not cover the film, sampling windows instead`);
  return null;
}

/** An index that lists only a stretch of the film is no better than sampling it. */
function coversFilm(cues: Cue[], durationSeconds: number): boolean {
  if (cues.length < MIN_INDEXED_LINES) return false;
  if (!(durationSeconds > 0)) return true;
  const span = cues[cues.length - 1]!.start - cues[0]!.start;
  return span >= durationSeconds * 1000 * 0.5;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes a reference to disk when EMBEDDED_DUMP_DIR is set.
 *
 * Reading one costs real bandwidth, so when an alignment goes wrong the cues
 * are worth keeping to look at rather than paying to fetch them again.
 */
function dump(label: string, hint: FileHint, cues: Cue[]): void {
  const dir = process.env.EMBEDDED_DUMP_DIR;
  if (!dir) return;
  try {
    const name = `${(hint.videoHash ?? "nohash").replace(/[^a-z0-9]/gi, "")}-${label}.json`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({ hint: { ...hint, filename: hint.filename }, cues }, null, 1),
      "utf8",
    );
    log.info(`wrote reference cues to ${path.join(dir, name)}`);
  } catch (error) {
    log.warn(`could not write the reference dump: ${describe(error)}`);
  }
}
