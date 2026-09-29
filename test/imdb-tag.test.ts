import { test } from "node:test";
import assert from "node:assert/strict";
import { imdbTag, parseVideoId } from "../src/addon";
import { napisy24AlignedUrl, napisy24ListedUrl } from "../src/urls";

/**
 * The id is carried through the addon as a number, so the leading zeros an
 * IMDb id starts with are gone by the time an outside service is asked. A
 * service given "tt111161" instead of "tt0111161" just finds nothing, and the
 * failure is silent, which is why it is pinned here.
 */
test("an IMDb id survives the round trip through a number", () => {
  const parsed = parseVideoId("tt0111161");
  assert.ok(parsed);
  assert.equal(imdbTag(parsed.imdbId), "tt0111161");
});

test("an id that needs no padding is left alone", () => {
  const parsed = parseVideoId("tt10986410:1:5");
  assert.ok(parsed);
  assert.equal(imdbTag(parsed.imdbId), "tt10986410");
  assert.equal(parsed.type === "episode" && parsed.season, 1);
  assert.equal(parsed.type === "episode" && parsed.episode, 5);
});

test("the listed-version link carries the entry id and the access prefix", () => {
  const url = napisy24ListedUrl("https://host/tok3n", "_", "33058", "film-1994", "srt");
  assert.equal(url, "https://host/tok3n/_/l/33058/film-1994.srt");
});

test("the aligning link carries both the video and the entry to move", () => {
  const hint = { videoHash: "4df6889aeec2b25e", videoSize: 28282395589, filename: "film.mkv" };
  const url = napisy24AlignedUrl("https://host/tok3n", "_", hint, "33058", "film", "srt");

  // The hint says which video to read the reference out of, the id which
  // subtitle to move onto it. Both have to survive, or the link cannot work.
  assert.match(url, /^https:\/\/host\/tok3n\/_\/a\/[A-Za-z0-9_-]+\/33058\/film\.srt$/);
});
