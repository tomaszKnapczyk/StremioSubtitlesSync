import { test } from "node:test";
import assert from "node:assert/strict";
import { hashFromChunks } from "../src/embedded/oshash";
import {
  parseTimings,
  planIntervals,
  coveredMs,
  isSaturated,
  type SubtitleTrack,
} from "../src/embedded/ffprobe";
import { pickTrack } from "../src/embedded/reference";
import { rankCandidates, isVideoFile, type CandidateFile } from "../src/sources/match";
import { align, applyAlignment } from "../src/subtitles/align";
import { decodeHint, encodeHint } from "../src/urls";
import type { Cue } from "../src/subtitles/types";

test("the file hash matches the reference implementation", () => {
  // Same deterministic bytes the published Python implementation was run over.
  const size = 200000;
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) data[i] = (i * 37 + 11) % 256;

  const head = data.subarray(0, 65536);
  const tail = data.subarray(size - 65536);
  assert.equal(hashFromChunks(size, head, tail), "6020dfa05f22cd40");
});

test("ffprobe packet output becomes cues", () => {
  const cues = parseTimings(
    ["59.000000,1.500000", "62.000000,1.500000", "", "65.500000,N/A", "bad line"].join("\n"),
  );

  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { start: 59_000, end: 60_500, text: "" });
  // A missing duration still marks that something was on screen.
  assert.equal(cues[2]!.start, 65_500);
  assert.equal(cues[2]!.end, 67_500);
});

test("overlapping cues are counted once", () => {
  assert.equal(coveredMs([{ start: 0, end: 1000, text: "" }]), 1000);
  // Three overlapping cues still only cover one second.
  assert.equal(
    coveredMs([
      { start: 0, end: 1000, text: "" },
      { start: 200, end: 800, text: "" },
      { start: 400, end: 1000, text: "" },
    ]),
    1000,
  );
  assert.equal(
    coveredMs([
      { start: 0, end: 1000, text: "" },
      { start: 5000, end: 6000, text: "" },
    ]),
    2000,
  );
});

test("a karaoke burst is recognised and not treated as dialogue", () => {
  // What a real opening song looked like: 144 overlapping cues in 12 seconds.
  const karaoke = Array.from({ length: 144 }, (_, i) => ({
    start: 88_000 + i * 80,
    end: 88_000 + i * 80 + 1200,
    text: "",
  }));
  assert.equal(isSaturated(karaoke, 12), true);
});

test("ordinary dialogue is not mistaken for karaoke", () => {
  // Twelve seconds holding five spoken lines with gaps between them.
  const dialogue = [
    { start: 0, end: 1400, text: "" },
    { start: 2000, end: 3600, text: "" },
    { start: 4500, end: 6000, text: "" },
    { start: 7000, end: 8800, text: "" },
    { start: 9500, end: 11_000, text: "" },
  ];
  assert.equal(isSaturated(dialogue, 12), false);
  // A handful of cues is never enough to judge.
  assert.equal(isSaturated(dialogue.slice(0, 3), 12), false);
});

test("a window that is on screen the whole time carries no timing", () => {
  const solid = Array.from({ length: 10 }, (_, i) => ({
    start: i * 1200,
    end: i * 1200 + 1300,
    text: "",
  }));
  assert.equal(isSaturated(solid, 12), true);
});

test("sample windows spread across the film and avoid both ends", () => {
  const intervals = planIntervals(7200, 6, 20);

  assert.equal(intervals.length, 6);
  // Wide enough margins to clear an opening or closing song.
  assert.ok(intervals[0]!.startSeconds >= 7200 * 0.10, "first window is too close to the start");
  const last = intervals[5]!;
  assert.ok(last.startSeconds + last.durationSeconds <= 7200 * 0.90, "last window runs too late");
  // Evenly spaced, so the baseline is as long as possible.
  const gaps = intervals.slice(1).map((iv, i) => iv.startSeconds - intervals[i]!.startSeconds);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1);
});

test("a film shorter than the window still yields one interval", () => {
  assert.deepEqual(planIntervals(10, 6, 20), [{ startSeconds: 0, durationSeconds: 10 }]);
  assert.deepEqual(planIntervals(0, 6, 20), []);
});

function track(over: Partial<SubtitleTrack> = {}): SubtitleTrack {
  return { order: 0, codec: "subrip", language: "eng", forced: false, bitmap: false, ...over };
}

test("forced tracks are never used as a reference", () => {
  const picked = pickTrack(
    [track({ order: 0, forced: true }), track({ order: 1, language: "fre" })],
    ["eng"],
  );
  assert.equal(picked?.order, 1);
  assert.equal(pickTrack([track({ forced: true })], ["eng"]), null);
});

test("text tracks are preferred, then the wanted language", () => {
  const picked = pickTrack(
    [
      track({ order: 0, codec: "hdmv_pgs_subtitle", bitmap: true, language: "eng" }),
      track({ order: 1, language: "fre" }),
      track({ order: 2, language: "eng" }),
    ],
    ["eng", "fre"],
  );
  assert.equal(picked?.order, 2);
});

test("an unlabelled track beats one labelled with a language nobody asked for", () => {
  // Seen in the wild: files whose English track carries only on-screen text
  // while the untagged stream is the film's own full subtitles. An untagged
  // track is unlabelled, not worse, so it is tried before a dead end.
  const picked = pickTrack(
    [track({ order: 0, language: "rus" }), track({ order: 1, language: undefined })],
    ["eng", "pol"],
  );
  assert.equal(picked?.order, 1);

  // "und" is how a container spells the same thing.
  const undTagged = pickTrack(
    [track({ order: 0, language: "rus" }), track({ order: 1, language: "und" })],
    ["eng", "pol"],
  );
  assert.equal(undTagged?.order, 1);
});

test("a wanted language still outranks an unlabelled track", () => {
  const picked = pickTrack(
    [track({ order: 0, language: undefined }), track({ order: 1, language: "eng" })],
    ["eng"],
  );
  assert.equal(picked?.order, 1);
});

test("a bitmap track is still used when it is all there is", () => {
  const picked = pickTrack([track({ codec: "hdmv_pgs_subtitle", bitmap: true })], ["eng"]);
  assert.equal(picked?.codec, "hdmv_pgs_subtitle");
});

test("file matching trusts byte size over names", () => {
  const files: CandidateFile[] = [
    { containerId: 1, fileId: 0, name: "Exactly.The.Right.Name.mkv", size: 111, kind: "torrents" },
    { containerId: 2, fileId: 3, name: "some.other.release.mkv", size: 5_000_000_000, kind: "torrents" },
  ];
  const ranked = rankCandidates(files, {
    filename: "Exactly.The.Right.Name.mkv",
    videoSize: 5_000_000_000,
    videoHash: undefined,
  });

  // The name matches the first file perfectly, but its size does not, and a
  // size mismatch means it is a different file.
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.fileId, 3);
});

test("a hash supplied by the source beats an exact size match", () => {
  const files: CandidateFile[] = [
    { containerId: 1, fileId: 1, name: "a.mkv", size: 5_000_000_000, kind: "torrents" },
    {
      containerId: 2,
      fileId: 2,
      name: "b.mkv",
      size: 4_000_000_000,
      kind: "torrents",
      hash: "13ef24b4dbd75f1d",
    },
  ];
  const ranked = rankCandidates(files, {
    filename: "a.mkv",
    videoSize: 5_000_000_000,
    videoHash: "13ef24b4dbd75f1d",
  });

  // Both qualify, but only one is provably the right file.
  assert.equal(ranked[0]!.fileId, 2);
  assert.equal(ranked.length, 2);
});

test("a stored hash finds the file even with no size to match on", () => {
  const files: CandidateFile[] = [
    { containerId: 1, fileId: 1, name: "unrelated.name.mkv", size: 900_000_000, kind: "torrents", hash: "aaaa" },
    { containerId: 2, fileId: 2, name: "other.name.mkv", size: 800_000_000, kind: "torrents", hash: "bbbb" },
  ];
  const ranked = rankCandidates(files, {
    filename: undefined,
    videoSize: undefined,
    videoHash: "bbbb",
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.fileId, 2);
});

test("release tags alone never identify a file, whatever the title", () => {
  // Seen in production: a film was given the timings of an unrelated Korean
  // series because both releases shared MULTi/1080p/WEB-DL/H264/DDP5.1/Atmos
  // and the same release group, which scores 0.85 on release tags alone.
  const files: CandidateFile[] = [
    {
      containerId: 1,
      fileId: 1,
      name: "Donggung.S01E01.MULTi.1080p.DSNP.WEB-DL.H264.DDP5.1.Atmos-K83.mkv",
      size: 3_000_000_000,
      kind: "torrents",
    },
  ];
  const hint = {
    filename: "Unabomber.2026.MULTi.1080p.NF.WEB-DL.H264.DDP5.1.Atmos-K83.mkv",
    videoSize: undefined,
    videoHash: undefined,
  };

  assert.deepEqual(rankCandidates(files, hint), [], "a name is not proof of identity");

  // The same file is still found the moment there is real evidence for it.
  assert.equal(rankCandidates(files, { ...hint, videoSize: 3_000_000_000 }).length, 1);
});

test("samples and non-video files are never candidates", () => {
  assert.equal(isVideoFile("movie.mkv", 5_000_000_000), true);
  assert.equal(isVideoFile("sample.mkv", 5_000_000_000), false);
  assert.equal(isVideoFile("movie.nfo", 5_000_000_000), false);
  assert.equal(isVideoFile("tiny.mkv", 1024), false);
});

test("video hints survive the round trip through a URL segment", () => {
  const hint = { videoHash: "8e245d9679d31e12", videoSize: 1632335363, filename: "A Movie.mkv" };
  assert.deepEqual(decodeHint(encodeHint(hint)), hint);
  assert.deepEqual(decodeHint(encodeHint({ videoHash: "abc", videoSize: undefined, filename: undefined })), {
    videoHash: "abc",
    videoSize: undefined,
    filename: undefined,
  });
  assert.equal(decodeHint("not-valid"), null);
});

/* --- The point of the whole feature: does a sampled reference actually work? --- */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Two hours of dialogue at a realistic rate of roughly 20 lines a minute. */
function feature(seed = 11): Cue[] {
  const rand = rng(seed);
  const cues: Cue[] = [];
  let t = 20_000;
  while (t < 7_000_000) {
    const duration = 1000 + Math.floor(rand() * 2500);
    cues.push({ start: t, end: t + duration, text: `line at ${t}` });
    t += duration + 200 + Math.floor(rand() * 2400);
  }
  return cues;
}

/** Keeps only the cues that fall inside the sampled windows. */
function sampled(cues: Cue[], durationSeconds: number, windows: number, seconds: number): Cue[] {
  const intervals = planIntervals(durationSeconds, windows, seconds);
  return cues
    .filter((c) =>
      intervals.some(
        (iv) =>
          c.start >= iv.startSeconds * 1000 &&
          c.start < (iv.startSeconds + iv.durationSeconds) * 1000,
      ),
    )
    .map((c) => ({ start: c.start, end: c.end, text: "" }));
}

test("six sampled windows are enough to find the offset", () => {
  const full = feature();
  const reference = sampled(full, 7200, 6, 20);
  const target = full.map((c) => ({ start: c.start + 9_400, end: c.end + 9_400, text: c.text }));

  assert.ok(reference.length >= 15, `only ${reference.length} sampled cues`);

  const result = align(reference, target);
  assert.equal(result.applied, true);
  assert.ok(Math.abs(result.offsetMs + 9_400) <= 60, `offset was ${result.offsetMs}`);

  const fixed = applyAlignment(target, result);
  assert.ok(Math.abs(fixed[0]!.start - full[0]!.start) <= 60);
});

test("a sampled reference still catches a frame rate stretch", () => {
  const full = feature(3);
  const reference = sampled(full, 7200, 6, 20);
  const ratio = 25 / (24000 / 1001);
  const target = full.map((c) => ({
    start: Math.round(c.start * ratio),
    end: Math.round(c.end * ratio),
    text: c.text,
  }));

  const result = align(reference, target);
  assert.equal(result.applied, true);
  assert.ok(Math.abs(result.ratio - 1 / ratio) < 0.001, `ratio was ${result.ratio}`);
});

test("a sampled reference does not match an unrelated subtitle", () => {
  const reference = sampled(feature(1), 7200, 6, 20);
  const unrelated = feature(4242);

  const result = align(reference, unrelated);
  assert.equal(result.applied, false, `matched with confidence ${result.confidence}`);
});
