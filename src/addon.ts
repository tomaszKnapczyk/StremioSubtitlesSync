import { addonBuilder, type Subtitle } from "stremio-addon-sdk";
import { baseUrl } from "./context";
import { encodeConfig, resolveConfig, type RawUserConfig, type ResolvedConfig } from "./config";
import { probeEmbedded } from "./embedded/reference";
import { iso639_2 } from "./lang";
import { log } from "./log";
import { manifest } from "./manifest";
import { OpenSubtitlesClient, isFileCached, isQuotaExhausted } from "./opensubtitles/client";
import { pickAnchor, rankCandidates, type Anchor } from "./picker";
import {
  directUrl,
  embeddedUrl,
  encodeHint,
  napiUrl,
  napisy24AlignedUrl,
  napisy24ListedUrl,
  napisy24Url,
  proxyUrl,
  slugify,
  syncUrl,
  type VideoHint,
} from "./urls";
import {
  bestListedNapisy24,
  napiSubtitleFor,
  napisy24SubtitleFor,
  proxySubtitleFor,
} from "./providers/lookup";
import { isUnalignable, noReferenceKey, unalignableKey } from "./sync-failures";

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
/**
 * Puts an IMDb id back into the form the outside world uses.
 *
 * It is carried here as a number, which loses the leading zeros, and services
 * asked with "tt111161" instead of "tt0111161" simply find nothing.
 */
export function imdbTag(imdbId: number): string {
  return `tt${String(imdbId).padStart(7, "0")}`;
}

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

/**
 * Stremio reads this field as an ISO 639-2 code and draws the menu entry from
 * it. A label it cannot map to a language came out blank in the player, taking
 * the entry's name with it, so the verbose form now leads with the code and
 * only then says how the timing was arrived at. Verbose remains a diagnostic
 * aid: it puts each method in its own entry instead of grouping the subtitles
 * under the player's own language heading.
 */
/**
 * Best first. A file made for this release beats anything moved onto it; a
 * hash-matched anchor beats the video's own sampled track, which beats a guess
 * from the release name; and a file left as uploaded comes last, since other
 * addons already serve it that way.
 */
const TIMING_RANK: Record<Timing, number> = {
  exact: 0,
  synced: 1,
  "synced-embedded": 2,
  "synced-weak": 3,
  unsynced: 4,
};

function label(language: string, timing: Timing, verbose: boolean): string {
  const code = iso639_2(language);
  if (!verbose) return code;
  return `${code} - ${TIMING_NOTE[timing]}`;
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
  const hint: VideoHint = {
    videoHash: args.extra.videoHash,
    videoSize: args.extra.videoSize ? Number(args.extra.videoSize) : undefined,
    filename,
  };

  const client = new OpenSubtitlesClient({
    apiKey: config.osApiKey,
    username: config.osUsername,
    password: config.osPassword,
  });

  // Asked alongside the search, not after it. NapiProjekt has to read 10 MiB
  // off the stream source before it can even be queried, and the player does
  // not wait long for a list, so the two waits overlap instead of stacking.
  //
  // One search covers everything OpenSubtitles is asked for: the languages the
  // user wants plus the ones allowed to anchor. The hash goes along so it can
  // flag the subtitles belonging to this exact file.
  const wantsPolish = config.languages.includes("pl");
  const [all, napi, napisy24, napisy24Listed, proxy] = await Promise.all([
    client.search({
      type: video.type,
      imdbId: video.imdbId,
      season: video.type === "episode" ? video.season : undefined,
      episode: video.type === "episode" ? video.episode : undefined,
      moviehash: args.extra.videoHash,
      languages: [...new Set([...config.languages, ...config.anchorLanguages])],
    }),
    // A failure in either must never cost the OpenSubtitles results.
    // Off unless asked for. The service answers with a bot-check page, and
    // every attempt still reads 10 MiB off the stream source first -- real work
    // on every request for an answer that does not come.
    wantsPolish && process.env.NAPIPROJEKT === "on"
      ? napiSubtitleFor(hint, config).catch(() => null)
      : Promise.resolve(null),
    wantsPolish ? napisy24SubtitleFor(hint).catch(() => null) : Promise.resolve(null),
    // The listing covers versions nobody uploaded against this file's hash,
    // which is most of them. Only an exact byte size is acted on.
    wantsPolish
      ? bestListedNapisy24(
          imdbTag(video.imdbId),
          video.type === "episode" ? video.season : undefined,
          video.type === "episode" ? video.episode : undefined,
          hint.videoSize,
          filename,
        ).catch(() => null)
      : Promise.resolve(null),
    // Somebody else's service, so it goes last and only as a fallback -- but
    // it is asked alongside the rest, because waiting for the others to fail
    // first would put its round trip on top of theirs.
    wantsPolish
      ? proxySubtitleFor(
          video.type === "episode" ? "series" : "movie",
          args.id,
          args.extra.videoHash,
          hint.videoSize,
        ).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Empty only counts as empty when no source had anything.
  if (
    all.length === 0 &&
    napi === null &&
    napisy24 === null &&
    napisy24Listed === null &&
    proxy === null
  ) {
    return { subtitles: [], cacheMaxAge: 1800 };
  }

  const anchor = pickAnchor(all, config.anchorLanguages, filename);

  // The link handed to the player carries this hint and nothing else, so the
  // file has to be findable from it later. Without a hash or a size it is not,
  // and an offer built on it would answer 404 when the player follows it.
  // Stremio asks again with both as soon as the stream is resolved.
  const locatable = hint.videoHash !== undefined || hint.videoSize !== undefined;

  // Only worth the round trips when OpenSubtitles gave us nothing to trust.
  // A hash-matched anchor is normally better than anything read from the file
  // -- but not when it cannot be downloaded. With the daily allowance spent,
  // such an anchor is worth nothing, while the reference inside the video is
  // free, so it is worth the round trips after all.
  const quotaSpent = isQuotaExhausted();
  const anchorIsUsable = anchor?.tier === "hash" && !quotaSpent;
  const embedded =
    anchorIsUsable || !locatable || isUnalignable(noReferenceKey(encodeHint(hint)))
      ? false
      : await hasEmbeddedReference(hint, config, args.id);

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

  // Collected with how each was timed, then sorted so the ones actually fitted
  // to this file come first. The player keeps the order an addon returns, and
  // with every entry under the same name, position is the only signal it has.
  const offers: { subtitle: Subtitle; rank: number }[] = [];
  const offer = (subtitle: Subtitle, timing: Timing): void => {
    offers.push({ subtitle, rank: TIMING_RANK[timing] });
  };

  // First, and without any aligning: NapiProjekt indexes by the video's own
  // hash, so this subtitle was made for this exact file. Nothing the addon can
  // compute from a reference beats that.
  if (napi) {
    log.info(`${args.id}: NapiProjekt has subtitles timed to this file`);
    offer(
      {
        id: `napi-${napi.md5.slice(0, 12)}`,
        url: napiUrl(base, configToken, napi.md5, slug, ext),
        lang: label("pl", "exact", config.verboseLabels),
      },
      "exact",
    );
  }

  if (napisy24) {
    log.info(`${args.id}: Napisy24 has subtitles timed to this file`);
    offer(
      {
        id: `n24-${hint.videoHash ?? "file"}`,
        url: napisy24Url(base, configToken, hint, slug, ext),
        lang: label("pl", "exact", config.verboseLabels),
      },
      "exact",
    );
  }

  // Skipped when the hash lookup already produced a subtitle for this file.
  if (napisy24Listed && !napisy24) {
    if (napisy24Listed.exact) {
      // The listing states this file's byte size, so it needs no moving.
      offer(
        {
          id: `n24l-${napisy24Listed.id}`,
          url: napisy24ListedUrl(base, configToken, napisy24Listed.id, slug, ext),
          lang: label("pl", "exact", config.verboseLabels),
        },
        "exact",
      );
    } else if (embedded) {
      // Made for another release, so it has to be moved onto this one. Only
      // worth offering when there is a reference in the video to move it to.
      log.info(`${args.id}: offering Napisy24 entry ${napisy24Listed.id} to be aligned`);
      offer(
        {
          id: `n24a-${napisy24Listed.id}`,
          url: napisy24AlignedUrl(base, configToken, hint, napisy24Listed.id, slug, ext),
          lang: label("pl", "synced-embedded", config.verboseLabels),
        },
        "synced-embedded",
      );
    }
  }

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

      // With the daily allowance spent, a file that has not already been
      // fetched cannot be served at all: following the link would answer 406
      // and the player would show nothing, having offered the entry anyway.
      if (quotaSpent && !isFileCached(subtitle.fileId)) {
        log.debug(`${args.id}: no quota left to fetch file ${subtitle.fileId}, not offering it`);
        continue;
      }

      // This pair was already tried against this video and would not line up.
      // Offering it again only puts a dead entry in the player's menu.
      if (
        entry.timing === "synced-embedded" &&
        isUnalignable(unalignableKey(encodeHint(hint), ref.fileId))
      ) {
        log.debug(`${args.id}: file ${ref.fileId} does not align to this video, not offering it`);
        continue;
      }

      // An anchor that cannot be downloaded leaves the file unshifted when it
      // is served, whatever it was offered as, so it is ranked for what it
      // will actually be.
      const anchorLost =
        (entry.timing === "synced" || entry.timing === "synced-weak") &&
        quotaSpent &&
        anchor !== null &&
        !isFileCached(anchor.subtitle.fileId);
      offer(
        {
          id: `${entry.timing}-${subtitle.fileId}`,
          url: entry.url,
          lang: label(language, entry.timing, config.verboseLabels),
        },
        anchorLost ? "unsynced" : entry.timing,
      );
      offered++;
    }
  }

  // Last, after everything this instance can reach on its own account.
  if (proxy) {
    log.info(`${args.id}: offering a Polish subtitle by way of Stremio's addon`);
    const timing: Timing = embedded ? "synced-embedded" : "unsynced";
    offer(
      {
        id: `proxy-${proxy.fileId}`,
        url: proxyUrl(base, configToken, hint, proxy.fileId, slug, ext),
        lang: label("pl", timing, config.verboseLabels),
      },
      timing,
    );
  }

  // Stable sort: within one tier the sources keep the order they were asked
  // in -- Napisy24, then OpenSubtitles on this instance's key, then the proxy.
  offers.sort((a, b) => a.rank - b.rank);
  const subtitles = offers.map((o) => o.subtitle);

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
