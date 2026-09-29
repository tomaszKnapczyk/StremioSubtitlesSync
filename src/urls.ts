/**
 * Subtitle URLs are self-describing.
 *
 * The addon keeps no state between the subtitle list and the moment the player
 * fetches a file, so everything needed to produce that file is in the URL: the
 * user's settings, which file to fetch, and which file to align it against.
 * That keeps the addon a plain stateless service that can be restarted or run
 * behind several instances without losing anything.
 */

export interface FileRef {
  fileId: number;
  /** Needed only to pick a code page if the file turns out not to be UTF-8. */
  lang: string;
}

export function encodeRef(ref: FileRef): string {
  return `${ref.fileId}.${ref.lang}`;
}

export function decodeRef(token: string | undefined): FileRef | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  const idPart = dot === -1 ? token : token.slice(0, dot);
  const lang = dot === -1 ? "en" : token.slice(dot + 1);
  const fileId = Number(idPart);
  if (!Number.isInteger(fileId) || fileId <= 0) return null;
  return { fileId, lang: lang.toLowerCase().replace(/[^a-z-]/g, "") || "en" };
}

/** A readable, safe last path segment. Players show it, so keep it tidy. */
export function slugify(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "subtitle";
}

/** Serve one OpenSubtitles file as-is, only re-encoded to UTF-8. */
export function directUrl(
  base: string,
  configToken: string,
  file: FileRef,
  slug: string,
  ext: string,
): string {
  return `${base}/${configToken}/s/${encodeRef(file)}/${slug}.${ext}`;
}

/**
 * Everything needed to find the video file again, packed into one path segment.
 *
 * The addon holds no state between listing subtitles and serving one, so the
 * details Stremio sent have to travel in the URL along with everything else.
 */
export interface VideoHint {
  videoHash: string | undefined;
  videoSize: number | undefined;
  filename: string | undefined;
}

export function encodeHint(hint: VideoHint): string {
  const packed = {
    h: hint.videoHash,
    s: hint.videoSize,
    n: hint.filename,
  };
  const entries = Object.entries(packed).filter(([, v]) => v !== undefined && v !== "");
  return Buffer.from(JSON.stringify(Object.fromEntries(entries)), "utf8").toString("base64url");
}

export function decodeHint(token: string | undefined): VideoHint | null {
  if (!token) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const size = Number(record["s"]);
    return {
      videoHash: typeof record["h"] === "string" ? record["h"] : undefined,
      videoSize: Number.isFinite(size) && size > 0 ? size : undefined,
      filename: typeof record["n"] === "string" ? record["n"] : undefined,
    };
  } catch {
    return null;
  }
}

/** Serve one file aligned to a reference read out of the video itself. */
export function embeddedUrl(
  base: string,
  configToken: string,
  hint: VideoHint,
  file: FileRef,
  slug: string,
  ext: string,
): string {
  return `${base}/${configToken}/f/${encodeHint(hint)}/${encodeRef(file)}/${slug}.${ext}`;
}

/**
 * Serve one subtitle NapiProjekt holds for this exact file.
 *
 * The service indexes by the video's own hash, so what it returns is already
 * timed to the file being played. There is nothing to align it to and no
 * anchor to carry: the hash alone says which subtitle this is.
 */
export function napiUrl(
  base: string,
  configToken: string,
  md5: string,
  slug: string,
  ext: string,
): string {
  return `${base}/${configToken}/n/${md5}/${slug}.${ext}`;
}

/**
 * Serve a subtitle Napisy24 holds for this exact file.
 *
 * Carries the same hint the embedded route uses, because the service is asked
 * by hash and size, and the link has to be able to ask again.
 */
export function napisy24Url(
  base: string,
  configToken: string,
  hint: VideoHint,
  slug: string,
  ext: string,
): string {
  return `${base}/${configToken}/w/${encodeHint(hint)}/${slug}.${ext}`;
}

/** Serve one file aligned to another. */
export function syncUrl(
  base: string,
  configToken: string,
  anchor: FileRef,
  file: FileRef,
  slug: string,
  ext: string,
): string {
  return `${base}/${configToken}/x/${encodeRef(anchor)}/${encodeRef(file)}/${slug}.${ext}`;
}
