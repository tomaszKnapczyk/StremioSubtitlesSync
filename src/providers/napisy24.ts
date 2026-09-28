/**
 * Reading what Napisy24 sends back.
 *
 * Both of its endpoints answer in shapes of their own making rather than
 * anything standard, and neither is documented, so the parsing lives here on
 * its own and is covered by fixtures captured from the live service. Nothing in
 * this file talks to the network.
 */

/** What the first field of a CheckSub response means. */
export type CheckSubStatus =
  /** Nothing for this file. */
  | "none"
  /** The film is known, but no subtitles for this release. */
  | "no-subtitles"
  /** Found, and the archive follows the separator. */
  | "found"
  /** Found, but sourced from outside Napisy24. Skipped. */
  | "foreign"
  /** The credentials were rejected. */
  | "login-error"
  /** Something this parser does not know about. */
  | "unknown";

export interface CheckSubResponse {
  status: CheckSubStatus;
  /** The key:value pairs the header carries, such as lp, fps or imdb. */
  fields: Record<string, string>;
  /** The ZIP that follows the separator, present only when status is "found". */
  archive: Buffer | null;
  /** The raw first field, kept for the log when the status is unknown. */
  raw: string;
}

const SEPARATOR = Buffer.from("||", "latin1");

const STATUS_BY_CODE: Record<string, CheckSubStatus> = {
  "OK-0": "none",
  "OK-1": "no-subtitles",
  "OK-2": "found",
  "OK-3": "foreign",
};

/**
 * The response is a text header, then "||", then a ZIP. It cannot be decoded as
 * text up front: past the separator it is binary, and treating those bytes as
 * UTF-8 would corrupt the archive.
 */
export function parseCheckSubResponse(body: Buffer): CheckSubResponse {
  const cut = body.indexOf(SEPARATOR);
  const header = (cut === -1 ? body : body.subarray(0, cut)).toString("utf8").trim();
  const archive = cut === -1 ? null : body.subarray(cut + SEPARATOR.length);

  const [first = "", ...pairs] = header.split("|");
  const raw = first.trim();

  const fields: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf(":");
    if (at <= 0) continue;
    fields[pair.slice(0, at).trim().toLowerCase()] = pair.slice(at + 1).trim();
  }

  const status = STATUS_BY_CODE[raw] ?? (/^login error/i.test(raw) ? "login-error" : "unknown");

  return {
    status,
    fields,
    // An empty tail is not an archive. A "found" without bytes is malformed and
    // has to look like nothing found, not like an empty subtitle.
    archive: status === "found" && archive && archive.length > 0 ? archive : null,
    raw,
  };
}

/** One subtitle version as the IMDb listing describes it. */
export interface Napisy24Listing {
  id: string;
  title: string;
  year: string | undefined;
  /** Release names. The listing packs several into one field for a series. */
  releases: string[];
  /** Byte sizes of the video files this was timed against, when known. */
  sizes: number[];
  fps: number | undefined;
  author: string | undefined;
  season: number | undefined;
  episode: number | undefined;
}

/** Several values share one element, separated by these. */
function splitMulti(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function field(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(block);
  const value = match?.[1]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The listing is a run of <subtitle> elements with no parent around them, after
 * an XML declaration, so it is not a well-formed document and no XML parser
 * will take it whole. Reading it element by element also survives the stray
 * <br> the service is known to emit inside text.
 */
export function parseNapisy24Listing(xml: string): Napisy24Listing[] {
  if (/^\s*brak\s+wynikow/i.test(xml)) return [];

  const cleaned = xml.replace(/<br\s*\/?>/gi, " ");
  const listings: Napisy24Listing[] = [];

  for (const match of cleaned.matchAll(/<subtitle>([\s\S]*?)<\/subtitle>/gi)) {
    const block = match[1] ?? "";
    const id = field(block, "id");
    if (id === undefined) continue;

    listings.push({
      id,
      title: field(block, "title") ?? "",
      year: field(block, "year"),
      // One entry can cover many releases of the same episode.
      releases: splitMulti(field(block, "release") ?? "", ";"),
      sizes: splitMulti(field(block, "size") ?? "", "|")
        .map((size) => Number(size))
        .filter((size) => Number.isFinite(size) && size > 0),
      fps: toNumber(field(block, "fps")),
      author: field(block, "author"),
      season: toNumber(field(block, "season")),
      episode: toNumber(field(block, "episode")),
    });
  }

  return listings;
}

/**
 * Picks the entries for one episode.
 *
 * The service ignores season and episode in the query and answers with
 * everything it has for the series, so the narrowing happens here. A film
 * carries no episode numbers at all, and then there is nothing to narrow.
 */
export function forEpisode(
  listings: Napisy24Listing[],
  season: number | undefined,
  episode: number | undefined,
): Napisy24Listing[] {
  if (season === undefined || episode === undefined) return listings;
  return listings.filter((entry) => entry.season === season && entry.episode === episode);
}

/** Files in the archive that are not subtitles, such as the site's own link. */
const SUBTITLE_EXTENSIONS = new Set(["srt", "txt", "sub"]);

export function isSubtitleFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return SUBTITLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
