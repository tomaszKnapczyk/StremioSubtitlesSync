import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  forEpisode,
  isSubtitleFile,
  parseCheckSubResponse,
  parseNapisy24Listing,
} from "../src/providers/napisy24";

/**
 * Fixtures captured from the live service during the spike. Nothing here goes
 * near the network: the shapes Napisy24 answers in are undocumented, so they
 * are pinned to real recorded responses instead of to an assumption.
 */
const FIXTURES = path.join(__dirname, "fixtures", "providers");

const read = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));
const readText = (name: string): string => read(name).toString("utf8");

test("a real 'nothing found' response is read as nothing found", () => {
  for (const name of ["n24-checksub-unabomber.bin", "n24-checksub-tedlasso.bin"]) {
    const parsed = parseCheckSubResponse(read(name));
    assert.equal(parsed.status, "none", name);
    assert.equal(parsed.archive, null);
  }
});

test("rejected credentials are told apart from an empty result", () => {
  // The service answers 200 either way, so only the body distinguishes a
  // password problem from a film it does not have.
  const parsed = parseCheckSubResponse(Buffer.from("login error", "utf8"));
  assert.equal(parsed.status, "login-error");
});

test("a found response yields the archive and the header fields", () => {
  const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
  const body = Buffer.concat([Buffer.from("OK-2|lp:12345|fps:23.976|imdb:tt0111161||"), archive]);

  const parsed = parseCheckSubResponse(body);
  assert.equal(parsed.status, "found");
  assert.deepEqual(parsed.fields, { lp: "12345", fps: "23.976", imdb: "tt0111161" });
  assert.deepEqual(parsed.archive, archive);
});

test("subtitles sourced from elsewhere are marked so they can be skipped", () => {
  assert.equal(parseCheckSubResponse(Buffer.from("OK-3||")).status, "foreign");
  assert.equal(parseCheckSubResponse(Buffer.from("OK-1||")).status, "no-subtitles");
});

test("a status this parser does not know is not mistaken for a result", () => {
  const parsed = parseCheckSubResponse(Buffer.from("SOMETHING-NEW||data"));
  assert.equal(parsed.status, "unknown");
  assert.equal(parsed.archive, null, "an unknown status must not hand back an archive");
  assert.equal(parsed.raw, "SOMETHING-NEW");
});

test("a found response with no bytes after the separator is not a result", () => {
  assert.equal(parseCheckSubResponse(Buffer.from("OK-2||")).archive, null);
});

test("the real film listing parses despite having no root element", () => {
  const listings = parseNapisy24Listing(readText("n24-webapi-tt0111161.xml"));

  assert.equal(listings.length, 7);
  const first = listings[0]!;
  assert.equal(first.id, "33058");
  assert.equal(first.title, "The Shawshank Redemption");
  assert.equal(first.year, "1994");
  assert.equal(first.fps, 23.976);
  // Byte sizes are what a file can actually be identified by.
  assert.ok(first.sizes.includes(13279965201), "the declared file size has to survive parsing");
  // A film carries no episode numbering.
  assert.equal(first.season, undefined);
});

test("the real series listing keeps its season and episode numbers", () => {
  const listings = parseNapisy24Listing(readText("n24-webapi-tt10986410.xml"));

  assert.equal(listings.length, 1);
  const only = listings[0]!;
  assert.equal(only.season, 1);
  assert.equal(only.episode, 1);
  // One entry covers many releases of the same episode.
  assert.ok(only.releases.length > 1, "a series entry lists several releases");
});

test("an episode is narrowed here, because the service ignores the query", () => {
  const listings = parseNapisy24Listing(readText("n24-webapi-tt10986410.xml"));

  assert.equal(forEpisode(listings, 1, 1).length, 1);
  // Asking for an episode the service does not have must yield nothing rather
  // than the wrong episode's subtitles.
  assert.equal(forEpisode(listings, 1, 5).length, 0);
  // A film has nothing to narrow by.
  assert.equal(forEpisode(listings, undefined, undefined).length, 1);
});

test("an empty result is not mistaken for an entry", () => {
  assert.deepEqual(parseNapisy24Listing("brak wynikow"), []);
  assert.deepEqual(parseNapisy24Listing(""), []);
});

test("a stray <br> inside the listing does not break it", () => {
  const xml = "<subtitle><id>7</id><title>Film<br>ciag dalszy</title><fps>25.000</fps></subtitle>";
  const parsed = parseNapisy24Listing(xml);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.fps, 25);
  assert.match(parsed[0]!.title, /^Film\s+ciag dalszy$/);
});

test("the archive's advertising file is never taken for a subtitle", () => {
  assert.equal(isSubtitleFile("The.Film.1994.srt"), true);
  assert.equal(isSubtitleFile("napisy.TXT"), true);
  assert.equal(isSubtitleFile("Napisy24.pl.url"), false);
  assert.equal(isSubtitleFile("readme"), false);
});
