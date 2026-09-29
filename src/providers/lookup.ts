import { TtlCache } from "../cache";
import { log } from "../log";
import { streamSourceFor } from "../embedded/reference";
import { fetchSubtitle, isFileHash } from "./napiprojekt";
import { videoFileHash } from "./video-hash";
import { fetchByHash, fetchListing, listingForExactFile } from "./napisy24-client";
import { releaseScore } from "../picker";
import { searchProxy, type ProxySubtitle } from "./stremio-proxy";
import type { ResolvedConfig } from "../config";
import type { FileHint } from "../sources/types";

/**
 * Asking NapiProjekt whether it has subtitles for the video being played.
 *
 * Two things make this unlike an OpenSubtitles search. The lookup key is the
 * MD5 of the file's first 10 MiB, so the file has to be found and partly read
 * before the question can even be put. And the service answers "nothing here"
 * to repeated requests from one address, so an answer is a scarce thing: the
 * subtitle that comes back is held, because asking again is likely to get
 * nothing even when the file is known.
 *
 * Everything here fails quietly. No NapiProjekt result should ever stop the
 * other sources from answering.
 */

/** Which file a video hashes to. The hash of a file never changes. */
const hashCache = new TtlCache<string | null>(24 * 60 * 60_000, 500);
/** The subtitle itself, held because the service will not hand it over twice. */
const subtitleCache = new TtlCache<Buffer | null>(12 * 60 * 60_000, 200);

/** One video, for one account. */
function videoKey(hint: FileHint, config: ResolvedConfig): string {
  const account = (config.torboxApiKey ?? "").slice(-8);
  return `${account}:${hint.videoHash ?? ""}:${hint.videoSize ?? 0}`;
}

/**
 * The file hash for the video Stremio is playing, or null when it cannot be
 * had: no stream source, the file is not on the account, or reading failed.
 */
export async function hashForVideo(
  hint: FileHint,
  config: ResolvedConfig,
): Promise<string | null> {
  // Without one of these the file cannot be identified, and guessing by name
  // is what once handed a film the timings of an unrelated series.
  if (hint.videoHash === undefined && hint.videoSize === undefined) return null;

  const source = streamSourceFor(config);
  if (!source) return null;

  return hashCache.wrap(videoKey(hint, config), async () => {
    const candidates = await source.resolve(hint).catch(() => []);
    const file = candidates[0];
    if (!file) return null;
    return videoFileHash(file);
  });
}

/**
 * The Polish subtitle for this exact file, if NapiProjekt has one.
 *
 * Indexed by file hash, so what comes back is already timed to this very file
 * and needs no aligning: that is the whole point of this route.
 */
export async function napiSubtitleFor(
  hint: FileHint,
  config: ResolvedConfig,
): Promise<{ md5: string; body: Buffer } | null> {
  const md5 = await hashForVideo(hint, config);
  if (md5 === null) return null;

  const body = await cachedSubtitle(md5);
  return body === null ? null : { md5, body };
}

/** The subtitle for a file hash, fetched at most once per cache lifetime. */
export async function cachedSubtitle(md5: string): Promise<Buffer | null> {
  if (!isFileHash(md5)) return null;

  return subtitleCache.wrap(`napi:${md5}`, async () => {
    try {
      const result = await fetchSubtitle(md5);
      switch (result.kind) {
        case "subtitle":
          log.info(`NapiProjekt has subtitles for ${md5} (${result.body.length} bytes)`);
          return result.body;
        case "archive":
          // Documented as impossible in this mode. Reported rather than
          // unpacked, so nobody ends up serving whatever is inside.
          log.warn(`NapiProjekt returned an archive for ${md5}, which this mode should not do`);
          return null;
        case "blocked":
          // A bot check, not an answer. Saying "nothing here" would be a lie,
          // but there is nothing to serve either.
          log.warn(`NapiProjekt answered with a bot check instead of a subtitle for ${md5}`);
          return null;
        case "unexpected":
          log.warn(`NapiProjekt answered unexpectedly for ${md5}: ${result.head}`);
          return null;
        default:
          log.debug(`NapiProjekt has nothing for ${md5}`);
          return null;
      }
    } catch (error) {
      log.debug(`NapiProjekt lookup failed: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  });
}

/** Napisy24 answers and hands over the file in one request, so both are held. */
const napisy24Cache = new TtlCache<Buffer | null>(12 * 60 * 60_000, 200);

/**
 * The Napisy24 subtitle for this exact file, if it has one.
 *
 * Far cheaper than the NapiProjekt route: the lookup key is the OpenSubtitles
 * hash Stremio already sends, so nothing is read off the video. Matched by
 * hash, so the result is already timed to this release.
 */
export async function napisy24SubtitleFor(hint: FileHint): Promise<Buffer | null> {
  if (!hint.videoHash || hint.videoSize === undefined) return null;

  return napisy24Cache.wrap(`n24:${hint.videoHash}:${hint.videoSize}`, async () => {
    const body = await fetchByHash(hint).catch(() => null);
    if (body) log.info(`Napisy24 has subtitles for this file (${body.length} bytes)`);
    return body;
  });
}

/** Listings change rarely, and one title is asked about repeatedly. */
const listingCache = new TtlCache<string | null>(6 * 60 * 60_000, 300);

/**
 * The id of a listed Napisy24 version timed against this exact file.
 *
 * Where the hash lookup finds only releases somebody uploaded subtitles for
 * directly, the listing covers every version the service holds for the title,
 * and states the byte size each was timed against. An exact size match is the
 * same file, so the subtitle needs no aligning -- and a size is the only claim
 * in that listing worth acting on.
 */
export async function listedNapisy24Id(
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  videoSize: number | undefined,
): Promise<string | null> {
  if (videoSize === undefined) return null;

  const key = `n24list:${imdbId}:${season ?? ""}:${episode ?? ""}:${videoSize}`;
  return listingCache.wrap(key, async () => {
    const listings = await fetchListing(imdbId, season, episode).catch(() => []);
    if (listings.length === 0) return null;

    const match = listingForExactFile(listings, videoSize);
    if (!match) {
      log.debug(`Napisy24 lists ${listings.length} version(s) for ${imdbId}, none for this file`);
      return null;
    }
    log.info(`Napisy24 lists a version timed to this file (entry ${match.id})`);
    return match.id;
  });
}

export interface ListedChoice {
  id: string;
  /** True when the listing states this file's exact byte size. */
  exact: boolean;
  /** What the uploader timed it against, when the listing says. */
  fps: number | undefined;
}

/** Listings are asked for once per title and reused across its releases. */
const choiceCache = new TtlCache<ListedChoice | null>(6 * 60 * 60_000, 300);

/**
 * The listed version worth offering for this video.
 *
 * An exact byte size means the same file, so that entry is served unchanged.
 * Failing that, the closest release by name is taken as something to align --
 * which is what this addon is for. The name is a weak signal and is treated as
 * one: it only decides which candidate to try, never whether the result is
 * trustworthy. That call belongs to the aligner, which refuses a match it is
 * not confident about.
 */
export async function bestListedNapisy24(
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  videoSize: number | undefined,
  filename: string | undefined,
): Promise<ListedChoice | null> {
  const key = `n24best:${imdbId}:${season ?? ""}:${episode ?? ""}:${videoSize ?? 0}:${filename ?? ""}`;

  return choiceCache.wrap(key, async () => {
    const listings = await fetchListing(imdbId, season, episode).catch(() => []);
    if (listings.length === 0) return null;

    const exact = listingForExactFile(listings, videoSize);
    if (exact) {
      log.info(`Napisy24 lists a version timed to this file (entry ${exact.id})`);
      return { id: exact.id, exact: true, fps: exact.fps };
    }

    // Nothing made for this file, so pick something to align instead.
    const ranked = listings
      .map((entry) => ({
        entry,
        score: filename
          ? Math.max(0, ...entry.releases.map((release) => releaseScore(filename, release)))
          : 0,
      }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0]?.entry;
    if (!best) return null;

    log.info(
      `Napisy24 lists ${listings.length} version(s) for ${imdbId}, none for this file; ` +
        `offering entry ${best.id} to be aligned`,
    );
    return { id: best.id, exact: false, fps: best.fps };
  });
}

/** Somebody else's service, so it is asked once per video and then left alone. */
const proxyCache = new TtlCache<ProxySubtitle | null>(6 * 60 * 60_000, 300);

/**
 * The best Polish subtitle Stremio's own addon offers for this video.
 *
 * A last resort, asked only when the sources that cost nothing and the
 * operator's own OpenSubtitles key have both come up short. Kept to a single
 * entry: the point is to have something when nothing else answered, not to
 * fill the menu with another service's catalogue.
 */
export async function proxySubtitleFor(
  type: "movie" | "series",
  videoId: string,
  videoHash: string | undefined,
  videoSize: number | undefined,
): Promise<ProxySubtitle | null> {
  const key = `proxy:${videoId}:${videoHash ?? ""}:${videoSize ?? 0}`;

  return proxyCache.wrap(key, async () => {
    const found = await searchProxy(type, videoId, "pol", videoHash, videoSize).catch(() => []);
    const best = found[0];
    if (best) log.info(`Stremio's addon offers a Polish subtitle for ${videoId}`);
    return best ?? null;
  });
}
