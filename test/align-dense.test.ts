import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { align } from "../src/subtitles/align";
import type { Cue } from "../src/subtitles/types";

/**
 * Two pairs captured from real files, timings only.
 *
 * "dense-match" is a sitcom episode: a Polish subtitle against the timing
 * reference read out of the same video. Subtitles are on screen 81% and 90% of
 * the time, which flattens the overlap test until a genuine match scored a
 * peak of 4.1 against a bar of 5 and was refused.
 *
 * "unrelated" is a different film's subtitle against that reference -- the
 * case every change here has to keep refusing.
 */
function load(name: string): { reference: Cue[]; target: Cue[] } {
  const read = (part: string): Cue[] =>
    (
      JSON.parse(
        fs.readFileSync(path.join(__dirname, "fixtures", "align", `${name}.${part}.json`), "utf8"),
      ) as [number, number][]
    ).map(([start, end]) => ({ start, end, text: "" }));
  return { reference: read("reference"), target: read("target") };
}

test("a real match on dense dialogue is accepted on the onset test's word", () => {
  const { reference, target } = load("dense-match");
  const result = align(reference, target);

  assert.equal(result.applied, true, "a genuine match must not be refused for being dense");
  // Both methods independently put the match about three seconds out.
  assert.ok(
    Math.abs(result.offsetMs - 3180) <= 300,
    `expected an offset near +3.2s, got ${result.offsetMs}ms`,
  );
  // The overlap test alone still thinks it is weak; the second opinion is what
  // carried it, and the result says so.
  assert.ok(result.peakRatio < 5);
  assert.ok(result.onsetPeakRatio !== undefined && result.onsetPeakRatio >= 6);
});

test("an unrelated film is still refused", () => {
  const { reference, target } = load("unrelated");
  const result = align(reference, target);

  assert.equal(result.applied, false);
  assert.equal(result.onsetPeakRatio, undefined);
});

test("the two methods have to agree on where the match is", () => {
  // Same real pair, but agreement is demanded to the nearest few milliseconds,
  // which the two methods' different bin sizes cannot meet. If agreement were
  // not load-bearing, this would still be accepted.
  const { reference, target } = load("dense-match");
  const result = align(reference, target, { onsetAgreementMs: 10 });

  assert.equal(result.applied, false);
});

test("a match the overlap test accepts on its own does not need a second opinion", () => {
  // Sparse, clean dialogue: the ordinary case. Nothing here should change.
  const reference: Cue[] = [];
  let t = 20_000;
  for (let i = 0; i < 300; i++) {
    const length = 1_000 + ((i * 617) % 2_500);
    reference.push({ start: t, end: t + length, text: "" });
    t += length + 1_500 + ((i * 331) % 5_000);
  }
  const target = reference.map((c) => ({ ...c, start: c.start - 2_000, end: c.end - 2_000 }));

  const result = align(reference, target);
  assert.equal(result.applied, true);
  assert.ok(Math.abs(result.offsetMs - 2_000) <= 40);
  assert.equal(result.onsetPeakRatio, undefined);
});
