import { TtlCache } from "../cache";
import { log } from "../log";
import { streamSourceFor } from "../embedded/reference";
import { fetchSubtitle, isFileHash } from "./napiprojekt";
import { videoFileHash } from "./video-hash";
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
