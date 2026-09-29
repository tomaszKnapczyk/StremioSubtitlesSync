import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyFileUrl } from "../src/providers/stremio-proxy";
import { proxyUrl } from "../src/urls";

/**
 * The file id travels through a URL and is put back into one before anything
 * is fetched, so what it is allowed to be matters more here than usual.
 */

test("only a numeric id ever becomes a download URL", () => {
  assert.equal(
    proxyFileUrl("1957625823"),
    "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/1957625823",
  );

  // Anything that could steer the request elsewhere is refused outright.
  assert.equal(proxyFileUrl("../../etc/passwd"), null);
  assert.equal(proxyFileUrl("1957625823/../.."), null);
  assert.equal(proxyFileUrl("http://elsewhere.example/x"), null);
  assert.equal(proxyFileUrl(""), null);
  assert.equal(proxyFileUrl("12a"), null);
});

test("the download URL always points at Stremio's own host", () => {
  const url = proxyFileUrl("42");
  assert.ok(url);
  assert.equal(new URL(url).hostname, "subs5.strem.io");
});

test("the offered link carries the video hint and the file id", () => {
  const hint = { videoHash: "04098a3ee8cad195", videoSize: 1526218384, filename: "ep.mkv" };
  const url = proxyUrl("https://host/tok3n", "_", hint, "1957625823", "odcinek", "srt");

  // The hint is what lets the route read a timing reference out of the video,
  // which is the only reason to route this through the addon at all.
  assert.match(url, /^https:\/\/host\/tok3n\/_\/p\/[A-Za-z0-9_-]+\/1957625823\/odcinek\.srt$/);
});
