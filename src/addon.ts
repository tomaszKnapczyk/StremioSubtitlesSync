import { addonBuilder, type Subtitle } from "stremio-addon-sdk";
import { baseUrl } from "./context";
import { encodeConfig, resolveConfig, type RawUserConfig, type ResolvedConfig } from "./config";
import { probeEmbedded } from "./embedded/reference";
import { iso639_2, languageName } from "./lang";
import { log } from "./log";
import { manifest } from "./manifest";
import { OpenSubtitlesClient } from "./opensubtitles/client";
import { pickAnchor, rankCandidates, type Anchor } from "./picker";
import { directUrl, embeddedUrl, encodeHint, slugify, syncUrl, type VideoHint } from "./urls";
import { isUnalignable, unalignableKey } from "./sync-failures";

/**
 * The community typings for the SDK are behind the protocol: they know nothing
 * about `filename` or `config`, both of which this addon needs. Declare the
 * real shape here and cast once, at the point the handler is registered.
 */
interface SubtitlesArgs {
  type: "movie" | "series";
  id: string;
  extra: {
    videoHash?: string;
    videoSize?: string;
    filename?: string;
  };
  config?: RawUserConfig;
}

type VideoId =
  | { type: "movie"; imdbId: number }
  | { type: "episode"; imdbId: number; season: number; episode: number };

/** Stremio ids are "tt1234567" for a film and "tt1234567:1:4" for an episode. */
export function parseVideoId(id: string): VideoId | null {
  const parts = id.split(":");
  const match = /^tt(\d+)$/.exec(parts[0] ?? "");
  if (!match) return null;
  const imdbId = Number(match[1]);

  if (parts.length >= 3) {
    const season = Number(parts[1]);
    const episode = Number(parts[2]);
    if (Number.isInteger(season) && Number.isInteger(episode)) {
      return { type: "episode", imdbId, season, episode };
    }
  }
  return { type: "movie", imdbId };
}

/** How a subtitle's timing was arrived at. The user gets told which. */
type Timing = "exact" | "synced" | "synced-embedded" | "synced-weak" | "unsynced";

const TIMING_NOTE: Record<Timing, string> = {
  exact: "exact match",
  synced: "auto-synced",
  "synced-embedded": "synced to the video",
  "synced-weak": "auto-synced, weak reference",
  unsynced: "not synced",
};

function label(language: string, timing: Timing, verbose: boolean): string {
  if (!verbose) return iso639_2(language);
  return `${languageName(language)} - ${TIMING_NOTE[timing]}`;
}

export async function getSubtitles(args: SubtitlesArgs): Promise<{
  subtitles: Subtitle[];
  cacheMaxAge?: number;
  staleRevalidate?: number;
  staleError?: number;
}> {
  const config = resolveConfig(args.config);

  // Stremio only sends what the stream addon told it. With no hash and no
  // filename there is nothing to find the file by, so log what arrived.
  const has = (value: unknown): string => (value ? "yes" : "no");
  log.info(
    `${args.id}: hash ${has(args.extra.videoHash)}, size ${has(args.extra.videoSize)}, ` +
      // The SDK hands over an empty object when the install URL carries no config.
      `filename ${has(args.extra.filename)}, ` +
      `install config ${has(args.config && Object.keys(args.config).length > 0)}`,
  );

  if (!config.osApiKey) {
    log.warn("request ignored: no OpenSubtitles API key in config or environment");
    return { subtitles: [], cacheMaxAge: 60 };
  }

  const video = parseVideoId(args.id);
  if (!video) {
    return { subtitles: [], cacheMaxAge: 3600 };
  }

  const filename = args.extra.filename;
  const client = new OpenSubtitlesClient({
    apiKey: config.osApiKey,
    username: config.osUsername,
    password: config.osPassword,
  });

  // One search covers everything: the languages the user wants plus the ones
  // allowed to anchor. The hash goes along so OpenSubtitles can flag the
  // subtitles that belong to this exact file.
  const all = await client.search({
    type: video.type,
    imdbId: video.imdbId,
    season: video.type === "episode" ? video.season : undefined,
    episode: video.type === "episode" ? video.episode : undefined,
    moviehash: args.extra.videoHash,
    languages: [...new Set([...config.languages, ...config.anchorLanguages])],
  });

  if (all.length === 0) {
    return { subtitles: [], cacheMaxAge: 1800 };
  }

  const anchor = pickAnchor(all, config.anchorLanguages, filename);
  const hint: VideoHint = {
    videoHash: args.extra.videoHash,
    videoSize: args.extra.videoSize ? Number(args.extra.videoSize) : undefined,
    filename,
  };

  // Only worth the round trips when OpenSubtitles gave us nothing to trust.
  // A hash-matched anchor is already better than anything read from the file.
  const embedded =
    anchor?.tier === "hash" ? false : await hasEmbeddedReference(hint, config, args.id);

  log.info(
    anchor
      ? `anchor for ${args.id}: file ${anchor.subtitle.fileId} (${anchor.subtitle.language}, ${anchor.tier})`
      : embedded
        ? `no OpenSubtitles anchor for ${args.id}, using the video's own subtitles`
        : `no anchor for ${args.id}, ` +
          (config.includeUnsynced ? "serving subtitles as uploaded" : "offering nothing"),
  );

  const base = baseUrl();
  const configToken = encodeConfig(args.config);
  const slug = slugify(filename ?? args.id);
  const ext = config.format;

  const subtitles: Subtitle[] = [];
  for (const language of config.languages) {
    const inLanguage = all.filter((s) => s.language === language);
    if (inLanguage.length === 0) continue;

    // Hash matches need no work, so they go first and take the top slots.
    const exact = rankCandidates(inLanguage.filter((s) => s.moviehashMatch));
    const rest = rankCandidates(inLanguage.filter((s) => !s.moviehashMatch));

    let offered = 0;
    for (const subtitle of [...exact, ...rest]) {
      if (offered >= config.maxPerLang) break;

      const ref = { fileId: subtitle.fileId, lang: subtitle.language };
      const entry = buildEntry(subtitle.moviehashMatch, anchor, embedded, ref, hint, {
        base,
        configToken,
        slug,
        ext,
      });

      // Skipping rather than breaking, so a droppable entry does not use up a
      // slot that a later alignable one could fill.
      if (entry.timing === "unsynced" && !config.includeUnsynced) continue;

      // This pair was already tried against this video and would not line up.
      // Offering it again only puts a dead entry in the player's menu.
      if (
        entry.timing === "synced-embedded" &&
        isUnalignable(unalignableKey(encodeHint(hint), ref.fileId))
      ) {
        log.debug(`${args.id}: file ${ref.fileId} does not align to this video, not offering it`);
        continue;
      }

      subtitles.push({
        id: `${entry.timing}-${subtitle.fileId}`,
        url: entry.url,
        lang: label(language, entry.timing, config.verboseLabels),
      });
      offered++;
    }
  }

  log.info(`${args.id}: offering ${subtitles.length} subtitles`);
  if (subtitles.length === 0) {
    // Often a passing problem: a busy file host, a spent quota, a stream that
    // came without details. Stremio would otherwise keep the empty list for hours.
    return { subtitles, cacheMaxAge: 300 };
  }
  return {
    subtitles,
    cacheMaxAge: 6 * 3600,
    staleRevalidate: 24 * 3600,
    staleError: 7 * 24 * 3600,
  };
}

/**
 * Chooses how to serve one candidate, best evidence first.
 *
 * A hash match needs nothing done to it. Failing that, a hash-matched anchor is
 * the strongest reference. The video's own subtitles come next: reading them is
 * slow, but the file was confirmed by hash, so the reference is certain. A
 * release-name anchor is only a guess, so it ranks last.
 */
function buildEntry(
  isExact: boolean,
  anchor: Anchor | null,
  embedded: boolean,
  ref: { fileId: number; lang: string },
  hint: VideoHint,
  url: { base: string; configToken: string; slug: string; ext: string },
): { timing: Timing; url: string } {
  if (isExact) {
    return {
      timing: "exact",
      url: directUrl(url.base, url.configToken, ref, url.slug, url.ext),
    };
  }

  // Aligning a file to itself would be pointless, and would also spend the
  // anchor's download quota a second time.
  const usableAnchor = anchor && anchor.subtitle.fileId !== ref.fileId ? anchor : null;

  if (usableAnchor?.tier === "hash") {
    const anchorRef = {
      fileId: usableAnchor.subtitle.fileId,
      lang: usableAnchor.subtitle.language,
    };
    return {
      timing: "synced",
      url: syncUrl(url.base, url.configToken, anchorRef, ref, url.slug, url.ext),
    };
  }

  if (embedded) {
    return {
      timing: "synced-embedded",
      url: embeddedUrl(url.base, url.configToken, hint, ref, url.slug, url.ext),
    };
  }

  if (usableAnchor) {
    const anchorRef = {
      fileId: usableAnchor.subtitle.fileId,
      lang: usableAnchor.subtitle.language,
    };
    return {
      timing: "synced-weak",
      url: syncUrl(url.base, url.configToken, anchorRef, ref, url.slug, url.ext),
    };
  }

  return {
    timing: "unsynced",
    url: directUrl(url.base, url.configToken, ref, url.slug, url.ext),
  };
}

/**
 * Checks whether the video's own subtitles can act as a reference.
 *
 * Deliberately swallows every failure: no TorBox key, no matching file, no
 * subtitle track, network trouble. All of them mean the same thing here, which
 * is that this route is unavailable, and none of them should stop the
 * OpenSubtitles path from answering.
 */
async function hasEmbeddedReference(
  hint: VideoHint,
  config: ResolvedConfig,
  id: string,
): Promise<boolean> {
  if (!config.torboxApiKey) return false;
  try {
    return (await probeEmbedded(hint, config)) !== null;
  } catch (error) {
    log.warn(`embedded probe failed for ${id}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(
  getSubtitles as unknown as Parameters<typeof builder.defineSubtitlesHandler>[0],
);

export const addonInterface = builder.getInterface();
