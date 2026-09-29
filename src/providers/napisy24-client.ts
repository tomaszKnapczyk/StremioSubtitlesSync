import { unzipSync } from "fflate";
import { log } from "../log";
import {
  forEpisode,
  isSubtitleFile,
  parseCheckSubResponse,
  parseNapisy24Listing,
  type Napisy24Listing,
} from "./napisy24";
import type { FileHint } from "../sources/types";

/**
 * Asking Napisy24 whether it has subtitles for the file being played.
 *
 * Cheaper than any other provider here: it looks up by the OpenSubtitles hash,
 * which Stremio already sends, so nothing has to be read off the video. A hit
 * comes back as a ZIP in the same response, which means one request gets both
 * the answer and the file.
 *
 * The match is by hash, so what comes back was timed against this exact
 * release and needs no aligning.
 */

const ENDPOINT = "http://napisy24.pl/run/CheckSubAgent.php";

/**
 * The credentials shipped by the subliminal project, used when the operator
 * has none of their own. Documented rather than hidden: they are public, and a
 * private account is the better choice where one exists.
 */
const PUBLIC_USER = "subliminal";
const PUBLIC_PASSWORD = "lanimilbus";

function credentials(): { user: string; password: string } {
  const user = process.env.N24_USERNAME?.trim();
  const password = process.env.N24_PASSWORD?.trim();
  return user && password
    ? { user, password }
    : { user: PUBLIC_USER, password: PUBLIC_PASSWORD };
}

/** Pulls the subtitle out of the archive, ignoring the site's own link file. */
function subtitleFromArchive(archive: Buffer): Buffer | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive);
  } catch (error) {
    log.warn(`Napisy24 archive could not be opened: ${describe(error)}`);
    return null;
  }

  for (const [name, bytes] of Object.entries(files)) {
    // Position is not enough: the archive also holds an advertising link.
    if (!isSubtitleFile(name)) continue;
    if (bytes.length === 0) continue;
    log.debug(`Napisy24 archive holds ${name} (${bytes.length} bytes)`);
    return Buffer.from(bytes);
  }

  log.warn(`Napisy24 archive held no subtitle file, only ${Object.keys(files).join(", ")}`);
  return null;
}

/**
 * The subtitle Napisy24 holds for this exact file, or null.
 *
 * Needs the hash and the size: the service matches on both, and without them
 * there is nothing to ask about.
 */
export async function fetchByHash(
  hint: FileHint,
  timeoutMs = 15_000,
): Promise<Buffer | null> {
  if (!hint.videoHash || hint.videoSize === undefined) return null;

  const { user, password } = credentials();
  const form = new URLSearchParams({
    postAction: "CheckSub",
    ua: user,
    ap: password,
    fh: hint.videoHash,
    fs: String(hint.videoSize),
    fn: hint.filename ?? "",
    n24pref: "1",
  });

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log.debug(`Napisy24 answered ${response.status}`);
      return null;
    }

    const parsed = parseCheckSubResponse(Buffer.from(await response.arrayBuffer()));
    switch (parsed.status) {
      case "found":
        return parsed.archive ? subtitleFromArchive(parsed.archive) : null;
      case "login-error":
        // Worth a warning: with the public credentials this means they have
        // stopped working, and with private ones that they are wrong.
        log.warn("Napisy24 rejected the credentials");
        return null;
      case "foreign":
        // Sourced from outside Napisy24, so another addon already serves it.
        log.debug("Napisy24 has only subtitles from elsewhere for this file");
        return null;
      case "unknown":
        log.warn(`Napisy24 answered with an unknown status: ${parsed.raw}`);
        return null;
      default:
        log.debug("Napisy24 has nothing for this file");
        return null;
    }
  } catch (error) {
    log.debug(`Napisy24 lookup failed: ${describe(error)}`);
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


const LISTING_ENDPOINT = "http://napisy24.pl/libs/webapi.php";
const DOWNLOAD_ENDPOINT = "http://napisy24.pl/run/pages/download.php";

/**
 * Every version the service lists for a title.
 *
 * The hash lookup only finds a release somebody uploaded subtitles for
 * directly; this listing also covers other releases of the same film, which is
 * most of them. Season and episode are filtered here because the service
 * ignores them in the query and answers with the whole series.
 */
export async function fetchListing(
  imdbId: string,
  season: number | undefined,
  episode: number | undefined,
  timeoutMs = 15_000,
): Promise<Napisy24Listing[]> {
  try {
    const response = await fetch(`${LISTING_ENDPOINT}?imdb=${encodeURIComponent(imdbId)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return [];
    return forEpisode(parseNapisy24Listing(await response.text()), season, episode);
  } catch (error) {
    log.debug(`Napisy24 listing failed: ${describe(error)}`);
    return [];
  }
}

/**
 * The listing entry timed against this exact file, if there is one.
 *
 * Byte size is the only thing here worth trusting. Two different encodes are
 * never the same number of bytes, so an exact match means the same file --
 * while a matching release name means very little, as this addon found out the
 * hard way when tags alone handed a film another title's timings.
 */
export function listingForExactFile(
  listings: Napisy24Listing[],
  videoSize: number | undefined,
): Napisy24Listing | null {
  if (videoSize === undefined) return null;
  return listings.find((entry) => entry.sizes.includes(videoSize)) ?? null;
}

/** Downloads one listed version and pulls the subtitle out of its archive. */
export async function fetchListed(id: string, timeoutMs = 20_000): Promise<Buffer | null> {
  if (!/^\d+$/.test(id)) return null;

  try {
    const response = await fetch(`${DOWNLOAD_ENDPOINT}?napisId=${id}&typ=sr`, {
      headers: { Referer: "http://napisy24.pl/" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log.debug(`Napisy24 download of ${id} answered ${response.status}`);
      return null;
    }
    return subtitleFromArchive(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    log.debug(`Napisy24 download of ${id} failed: ${describe(error)}`);
    return null;
  }
}
