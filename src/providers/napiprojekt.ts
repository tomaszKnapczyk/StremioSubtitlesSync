/**
 * NapiProjekt as a subtitle source.
 *
 * It indexes by the MD5 of a video file's first 10 MiB, which Stremio never
 * sends, so the file has to be read back from the stream source before the
 * service can even be asked. That makes a lookup expensive in a way an
 * OpenSubtitles search is not, and the service itself starts refusing repeat
 * requests from one address, so every answer -- including "nothing here" -- is
 * worth keeping.
 *
 * Nothing in this file talks to the network except `fetchSubtitle`, and that
 * one asks for exactly one file.
 */

const ENDPOINT = "https://napiprojekt.pl/unit_napisy/dl.php";

/** How much of the file the hash is taken over. Fixed by the service. */
export const NAPI_HASH_BYTES = 10 * 1024 * 1024;

/** The service's way of saying it has nothing for this file. */
const NOT_FOUND = "NPc0";

/** 7z, which the dreambox mode is not supposed to return. */
const SEVEN_ZIP = Buffer.from([0x37, 0x7a, 0xbc, 0xaf]);

/**
 * A checksum NapiProjekt derives from the file hash and demands alongside it.
 *
 * Ported from the reference implementation and pinned to its test vectors: the
 * digits it picks, the multipliers and the offsets are all arbitrary, so there
 * is nothing here to reason about, only something to reproduce exactly.
 */
export function napiSubhash(md5: string): string {
  const idx = [0xe, 0x3, 0x6, 0x8, 0x2];
  const mul = [2, 2, 5, 4, 3];
  const add = [0, 0xd, 0x10, 0xb, 0x5];

  let out = "";
  for (let k = 0; k < idx.length; k++) {
    const at = add[k]! + parseInt(md5[idx[k]!]!, 16);
    const value = parseInt(md5.slice(at, at + 2), 16);
    out += (value * mul[k]!).toString(16).slice(-1);
  }
  return out;
}

/** Only a 32-character lowercase hex digest is a file hash. */
export function isFileHash(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

export function subtitleUrl(md5: string, language = "PL"): string {
  const params = new URLSearchParams({
    v: "dreambox",
    kolejka: "false",
    nick: "",
    pass: "",
    napios: "Linux",
    l: language,
    f: md5,
    t: napiSubhash(md5),
  });
  return `${ENDPOINT}?${params.toString()}`;
}

export type NapiResult =
  /** The service has no subtitles for this file. */
  | { kind: "none" }
  /** Subtitle text, in whatever format and code page the uploader used. */
  | { kind: "subtitle"; body: Buffer }
  /**
   * An archive, which the dreambox mode should never produce. Reported rather
   * than unpacked: adding archive handling on a guess is how you end up serving
   * whatever happens to be inside.
   */
  | { kind: "archive" }
  /** Anything else, kept for the log. */
  | { kind: "unexpected"; head: string };

/**
 * Reads one response.
 *
 * Kept away from the network so the shapes the service answers in can be
 * tested. The body is deliberately not decoded here: these files are often in
 * a national code page rather than UTF-8, and the existing decoder picks that
 * apart properly given the bytes.
 */
export function readResponse(body: Buffer): NapiResult {
  if (body.length === 0) return { kind: "none" };
  if (body.subarray(0, NOT_FOUND.length).toString("latin1") === NOT_FOUND) return { kind: "none" };
  if (body.subarray(0, 4).equals(SEVEN_ZIP)) return { kind: "archive" };

  // A handful of bytes cannot be a subtitle file, whatever it is.
  if (body.length < 64) {
    return { kind: "unexpected", head: body.subarray(0, 16).toString("latin1") };
  }
  return { kind: "subtitle", body };
}

export interface FetchOptions {
  timeoutMs?: number;
  language?: string;
}

/** Asks for one file. The caller is responsible for not asking twice. */
export async function fetchSubtitle(md5: string, options: FetchOptions = {}): Promise<NapiResult> {
  if (!isFileHash(md5)) return { kind: "none" };

  const response = await fetch(subtitleUrl(md5, options.language ?? "PL"), {
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    return { kind: "unexpected", head: `HTTP ${response.status}` };
  }
  return readResponse(Buffer.from(await response.arrayBuffer()));
}
