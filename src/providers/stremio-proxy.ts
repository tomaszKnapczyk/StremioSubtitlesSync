import { log } from "../log";

/**
 * OpenSubtitles by way of Stremio's own public addon.
 *
 * The official OpenSubtitles addon does not hand out opensubtitles.com links;
 * it serves every file through Stremio's own host, on Stremio's account. That
 * is why it keeps working when a private API key has spent its twenty daily
 * downloads, and why it is worth having here as a last resort: it reaches the
 * same catalogue without touching the operator's own allowance.
 *
 * It is somebody else's infrastructure, so it is asked last, once per video,
 * and the answer is kept. It can disappear without notice, and every failure
 * here is silent -- the other sources must stand on their own.
 */

const ADDON = "https://opensubtitles-v3.strem.io";
/** Files are served from Stremio's host, and only from there. */
const ALLOWED_FILE_HOST = "subs5.strem.io";

export interface ProxySubtitle {
  /** The file id at the end of the download URL, which is all we need to keep. */
  fileId: string;
  language: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The last path segment of a download URL, but only when the URL is one of
 * Stremio's own. An id is put back into a URL later, so anything pointing
 * elsewhere has to be dropped here rather than followed.
 */
function fileIdOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== ALLOWED_FILE_HOST) return null;
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    return /^\d+$/.test(last) ? last : null;
  } catch {
    return null;
  }
}

/** Rebuilds the download URL from an id. */
export function proxyFileUrl(fileId: string): string | null {
  if (!/^\d+$/.test(fileId)) return null;
  return `https://${ALLOWED_FILE_HOST}/en/download/subencoding-stremio-utf8/src-api/file/${fileId}`;
}

/**
 * What the public addon offers for this video, in one language.
 *
 * The hash goes along because it is what makes the answer specific to this
 * file rather than to the title.
 */
export async function searchProxy(
  type: "movie" | "series",
  videoId: string,
  language: string,
  videoHash: string | undefined,
  videoSize: number | undefined,
  timeoutMs = 15_000,
): Promise<ProxySubtitle[]> {
  const extra = new URLSearchParams();
  if (videoHash) extra.set("videoHash", videoHash);
  if (videoSize !== undefined) extra.set("videoSize", String(videoSize));

  const suffix = extra.toString() === "" ? "" : `/${extra.toString()}`;
  const url = `${ADDON}/subtitles/${type}/${encodeURIComponent(videoId)}${suffix}.json`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      log.debug(`Stremio's subtitle addon answered ${response.status}`);
      return [];
    }

    const body: unknown = await response.json();
    const list = isRecord(body) && Array.isArray(body["subtitles"]) ? body["subtitles"] : [];

    const found: ProxySubtitle[] = [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const lang = String(entry["lang"] ?? "").toLowerCase();
      if (!lang.startsWith(language.toLowerCase())) continue;

      const fileId = fileIdOf(entry["url"]);
      if (fileId === null) continue;
      found.push({ fileId, language: lang });
    }
    return found;
  } catch (error) {
    log.debug(`Stremio's subtitle addon is unavailable: ${describe(error)}`);
    return [];
  }
}

/** Fetches one file. Returns null on anything that is not a subtitle. */
export async function fetchProxyFile(fileId: string, timeoutMs = 20_000): Promise<Buffer | null> {
  const url = proxyFileUrl(fileId);
  if (!url) return null;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      log.debug(`Stremio's subtitle host answered ${response.status} for ${fileId}`);
      return null;
    }

    const body = Buffer.from(await response.arrayBuffer());
    // Same rule as everywhere else here: length is not evidence. Only a body
    // with timed lines in it is a subtitle.
    if (!/\d\d:\d\d:\d\d[,.]\d/.test(body.subarray(0, 4000).toString("latin1"))) {
      log.warn(`Stremio's subtitle host returned something without timings for ${fileId}`);
      return null;
    }
    return body;
  } catch (error) {
    log.debug(`Stremio's subtitle host failed for ${fileId}: ${describe(error)}`);
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
