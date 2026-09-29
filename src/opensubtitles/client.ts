import { createHash } from "node:crypto";
import { TtlCache } from "../cache";
import { log } from "../log";
import {
  OpenSubtitlesError,
  QuotaExceededError,
  type OsSubtitle,
  type SearchQuery,
} from "./types";

/** Overridable so the end-to-end test can point at a stub server. */
const API = (process.env.OS_API_BASE ?? "https://api.opensubtitles.com/api/v1").replace(/\/+$/, "");
const TIMEOUT_MS = 20_000;

/**
 * OpenSubtitles requires a registered User-Agent naming the app and version.
 * Override it once you register your own consumer.
 */
const USER_AGENT = process.env.OS_USER_AGENT ?? "stremio-subtitle-sync v1.0.0";

/** Search results are unmetered, but caching keeps the rate limit happy. */
const searchCache = new TtlCache<OsSubtitle[]>(30 * 60_000, 500);
/** Downloads cost quota, so hold on to them hard. */
const fileCache = new TtlCache<string>(12 * 60 * 60_000, 300);
/** JWTs last about a day; refresh well before that. */
const tokenCache = new TtlCache<string>(20 * 60 * 60_000, 20);
/**
 * When the daily download allowance ran out.
 *
 * Worth remembering, because it changes what the addon should even offer: an
 * anchor that cannot be downloaded is no better than no anchor, and the
 * reference inside the video costs nothing. Cleared at midnight UTC, which is
 * when OpenSubtitles resets the count.
 */
let quotaExhaustedUntil = 0;

function noteQuotaExhausted(): void {
  const now = new Date();
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  quotaExhaustedUntil = reset;
  log.warn(`OpenSubtitles download quota is spent; not counting on it again before ${new Date(reset).toISOString()}`);
}

/** Whether a download would fail right now for want of quota. */
export function isQuotaExhausted(): boolean {
  return Date.now() < quotaExhaustedUntil;
}

/** Stand-in for "we tried to log in and it was rejected". */
const LOGIN_FAILED = "";
const LOGIN_RETRY_MINUTES = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Where a login is remembered.
 *
 * The password is part of it, so a cached token is only reused by someone who
 * gave the same password, and a wrong password cannot mark the right one as
 * failed. Only a hash goes into the key, never the password itself.
 */
export function tokenCacheKey(apiKey: string, username: string, password: string): string {
  const digest = createHash("sha256").update(`${apiKey}\0${username}\0${password}`).digest("hex");
  return `${username}:${digest}`;
}

export interface ClientOptions {
  apiKey: string;
  username?: string | undefined;
  password?: string | undefined;
}

export class OpenSubtitlesClient {
  constructor(private readonly options: ClientOptions) {
    if (!options.apiKey) {
      throw new OpenSubtitlesError("No OpenSubtitles API key configured");
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Api-Key": this.options.apiKey,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extra,
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.ok) return response;

    const body = await response.text().catch(() => "");
    if (response.status === 429) {
      const retryAfter = num(response.headers.get("Retry-After"), 10);
      throw new OpenSubtitlesError("Rate limited by OpenSubtitles", 429, retryAfter);
    }
    if (response.status === 406) {
      noteQuotaExhausted();
      throw new QuotaExceededError("OpenSubtitles download quota is used up for today");
    }
    throw new OpenSubtitlesError(
      `OpenSubtitles returned ${response.status}: ${body.slice(0, 200)}`,
      response.status,
    );
  }

  /**
   * Logs in for a JWT, so downloads count against the user's own quota.
   *
   * Bad credentials must not take the addon down with them: downloads still
   * work anonymously, just against a smaller quota. So a failed login is
   * reported and then treated as "no token", and the failure is remembered for
   * a while. OpenSubtitles counts failed login attempts and locks the account
   * after a handful, so retrying on every request would do real damage.
   */
  private async token(): Promise<string | undefined> {
    const { username, password } = this.options;
    if (!username || !password) return undefined;

    const key = tokenCacheKey(this.options.apiKey, username, password);
    const cached = tokenCache.get(key);
    if (cached !== undefined) return cached === LOGIN_FAILED ? undefined : cached;

    try {
      const response = await this.request(`${API}/login`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ username, password }),
      });
      const body: unknown = await response.json();
      const jwt = isRecord(body) ? body["token"] : undefined;
      if (typeof jwt !== "string" || jwt === "") {
        throw new OpenSubtitlesError("Login succeeded but returned no token");
      }
      log.info("OpenSubtitles login ok");
      tokenCache.set(key, jwt);
      return jwt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(
        `OpenSubtitles login failed, falling back to the anonymous download quota. ` +
          `Check OS_USERNAME and OS_PASSWORD. Not retrying for ${LOGIN_RETRY_MINUTES} minutes, ` +
          `because repeated failures lock the account. (${message})`,
      );
      tokenCache.set(key, LOGIN_FAILED, LOGIN_RETRY_MINUTES * 60_000);
      return undefined;
    }
  }

  async search(query: SearchQuery): Promise<OsSubtitle[]> {
    const params = new URLSearchParams();
    params.set("type", query.type);
    // Stremio hands us the series id for an episode, never the episode's own,
    // so it has to go out as parent_imdb_id or the search returns nothing.
    params.set(query.type === "episode" ? "parent_imdb_id" : "imdb_id", String(query.imdbId));
    // Sorted, so the same request always produces the same cache key.
    params.set("languages", [...new Set(query.languages)].sort().join(","));
    if (query.season !== undefined) params.set("season_number", String(query.season));
    if (query.episode !== undefined) params.set("episode_number", String(query.episode));
    if (query.moviehash) params.set("moviehash", query.moviehash);
    params.sort();

    const url = `${API}/subtitles?${params.toString()}`;
    return searchCache.wrap(url, async () => {
      const response = await this.request(url, { method: "GET", headers: this.headers() });
      const body: unknown = await response.json();
      const data = isRecord(body) && Array.isArray(body["data"]) ? body["data"] : [];
      const results = data.flatMap(flattenItem);
      log.debug(`search returned ${results.length} results`, {
        imdbId: query.imdbId,
        type: query.type,
      });
      return results;
    });
  }

  /**
   * Fetches one subtitle file as text. Spends one unit of download quota the
   * first time; later calls for the same file come from cache.
   */
  async fetchFile(fileId: number, language: string): Promise<string> {
    return fileCache.wrap(`file:${fileId}`, async () => {
      const jwt = await this.token();
      const response = await this.request(`${API}/download`, {
        method: "POST",
        headers: this.headers(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        body: JSON.stringify({ file_id: fileId, sub_format: "srt" }),
      });

      const body: unknown = await response.json();
      const link = isRecord(body) ? body["link"] : undefined;
      if (typeof link !== "string" || link === "") {
        throw new OpenSubtitlesError(`Download for file ${fileId} returned no link`);
      }
      if (isRecord(body) && body["remaining"] !== undefined) {
        log.info(`download quota remaining: ${String(body["remaining"])}`);
        // The service says this was the last one, so there is no need to spend
        // a failed request finding that out on the next file.
        if (Number(body["remaining"]) <= 0) noteQuotaExhausted();
      }

      const file = await fetch(link, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!file.ok) {
        throw new OpenSubtitlesError(`Subtitle file fetch failed: ${file.status}`, file.status);
      }
      return decodeSubtitle(Buffer.from(await file.arrayBuffer()), language);
    });
  }
}

const CODE_PAGE_BY_LANGUAGE: Record<string, string> = {
  pl: "windows-1250",
  cs: "windows-1250",
  sk: "windows-1250",
  hu: "windows-1250",
  sl: "windows-1250",
  hr: "windows-1250",
  bs: "windows-1250",
  ro: "windows-1250",
  sq: "windows-1250",
  ru: "windows-1251",
  uk: "windows-1251",
  bg: "windows-1251",
  sr: "windows-1251",
  mk: "windows-1251",
  el: "windows-1253",
  tr: "windows-1254",
  he: "windows-1255",
  ar: "windows-1256",
  th: "windows-874",
  vi: "windows-1258",
  "zh-cn": "gbk",
  "zh-tw": "big5",
  ja: "shift_jis",
  ko: "euc-kr",
};

/** Older uploads use a national code page. Try UTF-8, then guess by language. */
export function decodeSubtitle(bytes: Buffer, language: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const fallback = CODE_PAGE_BY_LANGUAGE[language] ?? "windows-1252";
    log.debug(`subtitle is not UTF-8, decoding as ${fallback}`);
    try {
      return new TextDecoder(fallback).decode(bytes);
    } catch {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }
}

function flattenItem(item: unknown): OsSubtitle[] {
  if (!isRecord(item)) return [];
  const attrs = item["attributes"];
  if (!isRecord(attrs)) return [];

  const files = Array.isArray(attrs["files"]) ? attrs["files"] : [];
  const first = files.find(isRecord);
  const fileId = first ? num(first["file_id"], 0) : 0;
  if (fileId === 0) return [];

  const fps = num(attrs["fps"], 0);

  return [
    {
      subtitleId: String(item["id"] ?? fileId),
      fileId,
      fileName: String(first?.["file_name"] ?? ""),
      language: String(attrs["language"] ?? "").toLowerCase(),
      release: String(attrs["release"] ?? ""),
      downloadCount: num(attrs["download_count"]),
      ratings: num(attrs["ratings"]),
      fps: fps > 0 ? fps : null,
      hearingImpaired: attrs["hearing_impaired"] === true,
      aiTranslated: attrs["ai_translated"] === true,
      machineTranslated: attrs["machine_translated"] === true,
      fromTrusted: attrs["from_trusted"] === true,
      moviehashMatch: attrs["moviehash_match"] === true,
    },
  ];
}
