import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnalignable, markUnalignable, noReferenceKey, unalignableKey } from "../src/sync-failures";
import { encodeHint } from "../src/urls";

const videoA = encodeHint({ videoHash: "bf8292e206fb4e6c", videoSize: 2336098950, filename: "a.mkv" });
const videoB = encodeHint({ videoHash: "6a17055a0223fc3c", videoSize: 6153853113, filename: "b.mkv" });

test("nothing is unalignable until it has actually failed", () => {
  assert.equal(isUnalignable(unalignableKey(videoA, 999001)), false);
});

test("a failure is remembered for that video and that file", () => {
  markUnalignable(unalignableKey(videoA, 999002));
  assert.equal(isUnalignable(unalignableKey(videoA, 999002)), true);
});

test("a failure says nothing about another file, or another video", () => {
  markUnalignable(unalignableKey(videoA, 999003));

  // Same video, a different subtitle file: that one may still line up.
  assert.equal(isUnalignable(unalignableKey(videoA, 999004)), false);
  // Same subtitle file, a different video: a new release is a new question,
  // which is the whole reason the video belongs in the key.
  assert.equal(isUnalignable(unalignableKey(videoB, 999003)), false);
});

test("a video whose own track is unusable is remembered for that video alone", () => {
  markUnalignable(noReferenceKey(videoA));
  assert.equal(isUnalignable(noReferenceKey(videoA)), true);
  assert.equal(isUnalignable(noReferenceKey(videoB)), false);
});

test("an unusable video does not mark its subtitles unalignable elsewhere", () => {
  markUnalignable(noReferenceKey(videoB));
  // The per-file question stays open: the same subtitle may align against
  // another release that does have a readable track.
  assert.equal(isUnalignable(unalignableKey(videoB, 999005)), false);
});
