import { createHash } from "node:crypto";
import { log } from "../log";
import { NAPI_HASH_BYTES } from "./napiprojekt";
import type { ResolvedFile } from "../sources/types";

/**
 * The MD5 of a video file's first 10 MiB, which is how NapiProjekt indexes.
 *
 * Stremio never sends it, so it has to be read back off the stream source. That
 * is inbound traffic, free on the usual hosts, and measured at well under a
 * second for the 10 MiB -- comfortably inside the few seconds a player waits
 * for a subtitle list. It is still a real transfer per file, so the result is
 * cached by the caller rather than recomputed per request.
 */
export async function videoFileHash(
  file: ResolvedFile,
  timeoutMs = 20_000,
): Promise<string | null> {
  if (file.size < NAPI_HASH_BYTES) {
    // Padding a short file to length would produce a hash for something that
    // is not the file, and quietly miss every real match.
    log.debug(`${file.name} is shorter than the hash window, skipping NapiProjekt`);
    return null;
  }

  try {
    const response = await fetch(file.url, {
      headers: { Range: `bytes=0-${NAPI_HASH_BYTES - 1}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 206 is the expected answer; a 200 means the host ignored the range and is
    // about to send the whole film, which must not be read.
    if (response.status !== 206) {
      log.debug(`${file.name}: range request answered ${response.status}, not 206`);
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== NAPI_HASH_BYTES) {
      log.debug(`${file.name}: got ${bytes.length} bytes of ${NAPI_HASH_BYTES}`);
      return null;
    }
    return createHash("md5").update(bytes).digest("hex");
  } catch (error) {
    // Every failure means the same thing here: this route is unavailable for
    // now. None of them should stop the other providers from answering.
    log.debug(`${file.name}: could not read the hash window (${describe(error)})`);
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
