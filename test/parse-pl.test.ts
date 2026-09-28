import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat, parseSubtitle } from "../src/subtitles/parse";

/**
 * The Polish subtitle services serve these three formats far more often than
 * SRT, and each one times its lines differently: MicroDVD counts frames, MPL2
 * counts tenths of a second, and TMPlayer gives no end time at all.
 */

test("each Polish format is recognised by its first line", () => {
  assert.equal(detectFormat("{100}{200}Pierwsza kwestia"), "microdvd");
  assert.equal(detectFormat("[100][200]Pierwsza kwestia"), "mpl2");
  assert.equal(detectFormat("00:00:10:Pierwsza kwestia"), "tmplayer");
  assert.equal(detectFormat("1\n00:00:01,000 --> 00:00:02,000\nPierwsza"), "srt");
});

test("a blank first line does not hide the format", () => {
  assert.equal(detectFormat("\n\n{100}{200}Kwestia"), "microdvd");
});

test("MicroDVD uses the frame rate the file declares", () => {
  const cues = parseSubtitle("{1}{1}25.000\n{100}{200}Kwestia\n{250}{300}Druga");

  // The declaration is a header, not a line of dialogue.
  assert.equal(cues.length, 2);
  // At 25 fps, frame 100 is exactly four seconds in.
  assert.equal(cues[0]!.start, 4000);
  assert.equal(cues[0]!.end, 8000);
  assert.equal(cues[1]!.start, 10000);
});

test("without a declaration MicroDVD takes the rate the source gave", () => {
  const cues = parseSubtitle("{100}{200}Kwestia", { fps: 25 });
  assert.equal(cues[0]!.start, 4000);
});

test("with no rate anywhere MicroDVD falls back to the usual film rate", () => {
  const cues = parseSubtitle("{100}{200}Kwestia");
  // 23.976 fps: frame 100 lands just past 4.17 s.
  assert.equal(cues[0]!.start, 4171);
});

test("a pipe is a line break and styling tags are dropped", () => {
  const cues = parseSubtitle("{1}{1}25.000\n{25}{50}{y:i}Pierwsza|Druga");
  assert.equal(cues[0]!.text, "Pierwsza\nDruga");
});

test("MPL2 counts tenths of a second and marks italics with a slash", () => {
  const cues = parseSubtitle("[100][200]/Kwestia|Druga");

  assert.equal(cues[0]!.start, 10000);
  assert.equal(cues[0]!.end, 20000);
  assert.equal(cues[0]!.text, "Kwestia\nDruga");
});

test("TMPlayer runs a line until the next one, but not for ever", () => {
  const cues = parseSubtitle(
    ["00:00:05:Pierwsza", "00:00:06:Druga", "00:10:00:Po dlugiej przerwie"].join("\n"),
  );

  assert.equal(cues.length, 3);
  // The next line is a second away, so this one ends there.
  assert.equal(cues[0]!.start, 5000);
  assert.equal(cues[0]!.end, 6000);
  // Nothing follows for ten minutes, so the cap applies instead.
  assert.equal(cues[2]!.start, 600000);
  assert.equal(cues[2]!.end, 602000);
});

test("cues come back in time order whatever the file's order", () => {
  const cues = parseSubtitle("{1}{1}25.000\n{250}{300}Druga\n{25}{50}Pierwsza");
  assert.deepEqual(
    cues.map((c) => c.text),
    ["Pierwsza", "Druga"],
  );
});

test("an empty line carries no cue", () => {
  assert.deepEqual(parseSubtitle("{1}{1}25.000\n{25}{50}\n{75}{100}Kwestia").length, 1);
});
