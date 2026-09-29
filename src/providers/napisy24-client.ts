import { unzipSync } from "fflate";
import { log } from "../log";
import { isSubtitleFile, parseCheckSubResponse } from "./napisy24";
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
