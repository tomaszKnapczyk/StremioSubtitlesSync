import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { napiUrl } from "../src/urls";
import {
  NAPI_HASH_BYTES,
  isFileHash,
  napiSubhash,
  readResponse,
  subtitleUrl,
} from "../src/providers/napiprojekt";

/**
 * The checksum's digit picks, multipliers and offsets are arbitrary, so there
 * is nothing to reason about here, only something to reproduce exactly. These
 * are the reference implementation's own vectors.
 */
test("the checksum matches the reference implementation", () => {
  assert.equal(napiSubhash("d41d8cd98f00b204e9800998ecf8427e"), "8030b");

  const zeros = createHash("md5").update(Buffer.alloc(NAPI_HASH_BYTES)).digest("hex");
  assert.equal(zeros, "f1c9645dbc14efddc7d8a322685f26eb", "the hash is over the first 10 MiB");
  assert.equal(napiSubhash(zeros), "a4a87");
});

test("only a real digest is treated as a file hash", () => {
  assert.equal(isFileHash("8d35d9df565a815a3f3c86003fc1fe46"), true);
  // Anything arriving from a URL has to be rejected before it reaches the
  // service, so an id from outside cannot steer the request.
  assert.equal(isFileHash("8D35D9DF565A815A3F3C86003FC1FE46"), false, "uppercase is not our form");
  assert.equal(isFileHash("../../etc/passwd"), false);
  assert.equal(isFileHash("8d35d9df"), false);
  assert.equal(isFileHash(""), false);
});

test("the request carries the hash, its checksum and the language", () => {
  const url = new URL(subtitleUrl("8d35d9df565a815a3f3c86003fc1fe46"));

  assert.equal(url.searchParams.get("f"), "8d35d9df565a815a3f3c86003fc1fe46");
  assert.equal(url.searchParams.get("t"), napiSubhash("8d35d9df565a815a3f3c86003fc1fe46"));
  assert.equal(url.searchParams.get("l"), "PL");
  // dreambox is what makes the service answer with the file itself rather than
  // with an archive.
  assert.equal(url.searchParams.get("v"), "dreambox");
});

test("NPc0 means the service has nothing, and is not a subtitle", () => {
  // Observed live, both for a file it does not know and when it starts
  // refusing repeat requests.
  assert.deepEqual(readResponse(Buffer.from("NPc0")), { kind: "none" });
  assert.deepEqual(readResponse(Buffer.alloc(0)), { kind: "none" });
});

test("subtitle text comes back as bytes, not as a decoded string", () => {
  // These files are routinely in a national code page, so decoding here would
  // destroy the characters the existing decoder knows how to recover.
  const body = Buffer.concat([Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n"), Buffer.alloc(64, 0x41)]);
  const result = readResponse(body);

  assert.equal(result.kind, "subtitle");
  assert.ok(result.kind === "subtitle" && result.body.equals(body));
});

test("an archive is reported rather than unpacked on a guess", () => {
  const sevenZip = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf]), Buffer.alloc(200)]);
  assert.deepEqual(readResponse(sevenZip), { kind: "archive" });
});

test("a few stray bytes are not mistaken for a subtitle file", () => {
  const result = readResponse(Buffer.from("error"));
  assert.equal(result.kind, "unexpected");
});

test("the served link carries the file hash and nothing else", () => {
  const md5 = "8d35d9df565a815a3f3c86003fc1fe46";
  const url = napiUrl("https://host/tok3n", "_", md5, "film-2026", "srt");

  // No anchor and no hint: the hash alone says which subtitle this is, because
  // the service timed it against this very file.
  assert.equal(url, `https://host/tok3n/_/n/${md5}/film-2026.srt`);
  // The access prefix baked into the base has to survive intact.
  assert.ok(url.startsWith("https://host/tok3n/"));
});

test("a bot-check page is never mistaken for a subtitle", () => {
  // Captured live: the service answers 200 with an HTML challenge, and it was
  // read as a subtitle because it was comfortably longer than a few bytes.
  const blocked = fs.readFileSync(
    path.join(__dirname, "fixtures", "providers", "napi-blocked.html"),
  );

  assert.ok(blocked.length > 7000, "the page is long enough to pass any length test");
  assert.deepEqual(readResponse(blocked), { kind: "blocked" });
});

test("length alone never makes something a subtitle", () => {
  // Plenty of bytes, no timed lines: not a subtitle, whatever its size.
  const prose = Buffer.from("Nie znaleziono napisow dla tego pliku. ".repeat(40));
  assert.equal(readResponse(prose).kind, "unexpected");
});
