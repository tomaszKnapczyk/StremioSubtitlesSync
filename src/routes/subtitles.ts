import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { TtlCache } from "../cache";
import { decodeConfig, resolveConfig } from "../config";
import { log } from "../log";
import { OpenSubtitlesClient, decodeSubtitle } from "../opensubtitles/client";
import { cachedSubtitle, napisy24SubtitleFor } from "../providers/lookup";
import { isFileHash } from "../providers/napiprojekt";
import { OpenSubtitlesError } from "../opensubtitles/types";
import { align, applyAlignment } from "../subtitles/align";
import { parseSubtitle } from "../subtitles/parse";
import { toSrt, toVtt } from "../subtitles/serialize";
import type { Cue } from "../subtitles/types";
import { decodeHint, decodeRef, type FileRef } from "../urls";
import { markUnalignable, noReferenceKey, unalignableKey } from "../sync-failures";
import { RateLimitedError } from "../embedded/ffprobe";
import { embeddedReference } from "../embedded/reference";

/** Aligning is not expensive, but a player may refetch, and seeking does too. */
const outputCache = new TtlCache<string>(6 * 60 * 60_000, 200);

const CONTENT_TYPE: Record<string, string> = {
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
};

function extensionOf(name: string | undefined): "srt" | "vtt" {
  return name?.toLowerCase().endsWith(".vtt") ? "vtt" : "srt";
}

function render(cues: Cue[], ext: "srt" | "vtt"): string {
  return ext === "vtt" ? toVtt(cues) : toSrt(cues);
}

function clientFor(req: Request): OpenSubtitlesClient {
  const config = resolveConfig(decodeConfig(req.params["cfg"]));
  if (!config.osApiKey) {
    throw new OpenSubtitlesError("No OpenSubtitles API key for this request", 400);
  }
  return new OpenSubtitlesClient({
    apiKey: config.osApiKey,
    username: config.osUsername,
    password: config.osPassword,
  });
}

function send(res: Response, ext: "srt" | "vtt", body: string, cacheable = true): void {
  res.setHeader("Content-Type", CONTENT_TYPE[ext]!);
  // A fallback served because something failed must not outlive the failure.
  res.setHeader("Cache-Control", cacheable ? "public, max-age=21600" : "no-store");
  res.send(body);
}

function fail(res: Response, error: unknown, what: string): void {
  const status =
    error instanceof OpenSubtitlesError
      ? (error.status ?? 502)
      : error instanceof RateLimitedError
        ? 503
        : 502;
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${what} failed: ${message}`);
  // The video host was only busy. Nothing is cached, so a retry can succeed.
  if (error instanceof RateLimitedError) res.setHeader("Retry-After", "60");
  res.status(status >= 400 && status < 600 ? status : 502).type("text/plain").send(message);
}

export function subtitleRoutes(): Router {
  const router = Router();

  /** Serve one OpenSubtitles file unchanged, other than a clean UTF-8 re-encode. */
  router.get("/:cfg/s/:file/:name", async (req, res) => {
    const ext = extensionOf(req.params["name"]);
    const file = decodeRef(req.params["file"]);
    if (!file) {
      res.status(400).type("text/plain").send("Bad subtitle reference");
      return;
    }

    try {
      const cues = parseSubtitle(await clientFor(req).fetchFile(file.fileId, file.lang));
      send(res, ext, render(cues, ext));
    } catch (error) {
      fail(res, error, `serving file ${file.fileId}`);
    }
  });

  /**
   * Serve one file aligned to another.
   *
   * The anchor is a subtitle OpenSubtitles matched to this exact video, so its
   * timing is right by construction. Aligning to it fixes the target's timing
   * without the video ever being read.
   */
  router.get("/:cfg/x/:anchor/:file/:name", async (req, res) => {
    const ext = extensionOf(req.params["name"]);
    const anchor = decodeRef(req.params["anchor"]);
    const file = decodeRef(req.params["file"]);
    if (!anchor || !file) {
      res.status(400).type("text/plain").send("Bad subtitle reference");
      return;
    }

    const cacheKey = `${anchor.fileId}->${file.fileId}.${ext}`;
    const cached = outputCache.get(cacheKey);
    if (cached !== undefined) {
      res.setHeader("X-Subtitle-Sync", "cached");
      send(res, ext, cached);
      return;
    }

    let target: Cue[];
    try {
      target = await fetchCues(req, file);
    } catch (error) {
      fail(res, error, `serving file ${file.fileId}`);
      return;
    }

    try {
      const reference = await fetchCues(req, anchor);
      const result = align(reference, target);
      const body = render(applyAlignment(target, result), ext);

      res.setHeader(
        "X-Subtitle-Sync",
        result.applied
          ? `offset=${result.offsetMs}ms ratio=${result.ratio.toFixed(5)} ` +
            `confidence=${result.confidence.toFixed(3)} peak=${result.peakRatio.toFixed(1)}`
          : `skipped confidence=${result.confidence.toFixed(3)} peak=${result.peakRatio.toFixed(1)}`,
      );
      log.info(
        `sync ${file.fileId} to ${anchor.fileId}: ` +
          (result.applied
            ? `offset ${result.offsetMs}ms, ratio ${result.ratio.toFixed(5)}, confidence ${result.confidence.toFixed(2)}`
            : `left alone, confidence ${result.confidence.toFixed(2)} too low`),
      );

      outputCache.set(cacheKey, body);
      send(res, ext, body);
    } catch (error) {
      // The anchor failed, but the subtitle the user asked for is already in
      // hand. Hand it over unaligned rather than showing them nothing.
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`anchor ${anchor.fileId} unavailable (${message}), serving unaligned`);
      res.setHeader("X-Subtitle-Sync", "anchor-unavailable");
      send(res, ext, render(target, ext), false);
    }
  });

  /**
   * Serve one file aligned to the video's own subtitle track.
   *
   * This is the slow path. It finds the file on the configured stream source,
   * confirms it by hash, and reads a few short windows out of it. That can take
   * tens of seconds the first time, so the result is cached hard.
   */
  router.get("/:cfg/f/:hint/:file/:name", async (req, res) => {
    const ext = extensionOf(req.params["name"]);
    const hint = decodeHint(req.params["hint"]);
    const file = decodeRef(req.params["file"]);
    if (!hint || !file) {
      res.status(400).type("text/plain").send("Bad subtitle reference");
      return;
    }

    const config = resolveConfig(decodeConfig(req.params["cfg"]));

    let target: Cue[];
    try {
      target = await fetchCues(req, file);
    } catch (error) {
      fail(res, error, `serving file ${file.fileId}`);
      return;
    }

    try {
      const reference = await embeddedReference(hint, config);
      if (!reference) {
        // Reading it cost tens of seconds and produced nothing usable -- often
        // a track that only covers on-screen text. That will not change on the
        // next try, so the menu should stop offering this route for this video.
        markUnalignable(noReferenceKey(req.params["hint"] ?? ""));
        throw new OpenSubtitlesError("The video's own subtitles could not be read", 503);
      }

      // The reference is only a handful of sampled windows. The aligner's peak
      // test is what keeps that honest: a sparse reference lines up with almost
      // anything somewhere, so overlap alone would happily match the wrong film.
      const result = align(reference, target);
      if (!result.applied && process.env.EMBEDDED_DUMP_DIR) {
        dumpTarget(hint, target);
      }
      if (!result.applied) {
        // Learned the expensive way, so the subtitle menu can stop offering an
        // entry that will never load. Only this failure is remembered: it says
        // these two do not belong together, which a busy host does not.
        markUnalignable(unalignableKey(req.params["hint"] ?? "", file.fileId));
        throw new OpenSubtitlesError(
          `No confident alignment against the video ` +
            `(overlap ${result.confidence.toFixed(2)}, peak ${result.peakRatio.toFixed(1)}, ` +
            `${reference.length} reference cues vs ${target.length} subtitle cues)`,
          503,
        );
      }

      const body = render(applyAlignment(target, result), ext);
      res.setHeader(
        "X-Subtitle-Sync",
        `embedded offset=${result.offsetMs}ms ratio=${result.ratio.toFixed(5)} ` +
          `confidence=${result.confidence.toFixed(3)} peak=${result.peakRatio.toFixed(1)}`,
      );
      log.info(
        `sync ${file.fileId} to the video: offset ${result.offsetMs}ms, ` +
          `ratio ${result.ratio.toFixed(5)}, confidence ${result.confidence.toFixed(2)}`,
      );
      send(res, ext, body);
    } catch (error) {
      fail(res, error, `syncing file ${file.fileId} to the video`);
    }
  });

  /**
   * Serve a subtitle NapiProjekt holds for this exact file.
   *
   * Nothing is aligned here. The service indexes by the video's own hash, so
   * what it returns was timed against the very file being played -- which is
   * what makes this route worth having at all.
   */
  router.get("/:cfg/n/:md5/:name", async (req, res) => {
    const ext = extensionOf(req.params["name"]);
    const md5 = (req.params["md5"] ?? "").toLowerCase();
    // The hash comes in off a URL, so it is checked before it reaches the
    // service rather than passed along as given.
    if (!isFileHash(md5)) {
      res.status(400).type("text/plain").send("Bad subtitle reference");
      return;
    }

    try {
      const body = await cachedSubtitle(md5);
      if (!body) {
        // Either the service has nothing, or it is refusing repeats and the
        // held copy has expired. Both mean: not available right now.
        throw new OpenSubtitlesError("NapiProjekt has no subtitles for this file", 404);
      }

      // These files are routinely in a national code page, and often in a
      // Polish format that counts frames rather than milliseconds.
      const cues = parseSubtitle(decodeSubtitle(body, "pl"));
      if (cues.length === 0) {
        throw new OpenSubtitlesError("The NapiProjekt file parsed to zero cues", 502);
      }

      res.setHeader("X-Subtitle-Sync", "napiprojekt exact");
      log.info(`served ${cues.length} cues from NapiProjekt for ${md5}`);
      send(res, ext, render(cues, ext));
    } catch (error) {
      fail(res, error, `serving NapiProjekt subtitle ${md5}`);
    }
  });

  /**
   * Serve a subtitle Napisy24 holds for this exact file.
   *
   * Matched on the hash Stremio sent, so it was timed against this release and
   * nothing here aligns it. The hint travels in the link because the service
   * is asked by hash and size, and the link has to be able to ask again.
   */
  router.get("/:cfg/w/:hint/:name", async (req, res) => {
    const ext = extensionOf(req.params["name"]);
    const hint = decodeHint(req.params["hint"]);
    if (!hint) {
      res.status(400).type("text/plain").send("Bad subtitle reference");
      return;
    }

    try {
      const body = await napisy24SubtitleFor(hint);
      if (!body) {
        throw new OpenSubtitlesError("Napisy24 has no subtitles for this file", 404);
      }

      // Polish uploads are routinely in a national code page, and often in a
      // format that counts frames rather than milliseconds.
      const cues = parseSubtitle(decodeSubtitle(body, "pl"));
      if (cues.length === 0) {
        throw new OpenSubtitlesError("The Napisy24 file parsed to zero cues", 502);
      }

      res.setHeader("X-Subtitle-Sync", "napisy24 exact");
      log.info(`served ${cues.length} cues from Napisy24`);
      send(res, ext, render(cues, ext));
    } catch (error) {
      fail(res, error, "serving Napisy24 subtitle");
    }
  });

  return router;
}

/** Saves the subtitle that failed to align, next to the reference dump. */
function dumpTarget(hint: { videoHash?: string | undefined }, cues: Cue[]): void {
  const dir = process.env.EMBEDDED_DUMP_DIR;
  if (!dir) return;
  try {
    const name = `${(hint.videoHash ?? "nohash").replace(/[^a-z0-9]/gi, "")}-target.json`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ cues }, null, 1), "utf8");
    log.info(`wrote the unaligned subtitle to ${path.join(dir, name)}`);
  } catch {
    // Diagnostics must never break the response.
  }
}

async function fetchCues(req: Request, ref: FileRef): Promise<Cue[]> {
  const text = await clientFor(req).fetchFile(ref.fileId, ref.lang);
  const cues = parseSubtitle(text);
  if (cues.length === 0) {
    throw new OpenSubtitlesError(`File ${ref.fileId} parsed to zero cues`);
  }
  return cues;
}
