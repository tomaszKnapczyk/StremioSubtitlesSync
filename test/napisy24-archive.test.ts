import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, zipSync } from "fflate";
import { isSubtitleFile, parseCheckSubResponse } from "../src/providers/napisy24";
import { parseSubtitle } from "../src/subtitles/parse";
import { decodeSubtitle } from "../src/opensubtitles/client";

/**
 * A hit arrives as a ZIP inside the same response that answers the question,
 * and the archive holds the site's own advertising link beside the subtitle.
 * Archives are built here rather than captured, so no uploaded subtitle ends
 * up in the repository.
 */

const SRT = ["1", "00:00:04,000 --> 00:00:06,000", "Zażółć gęślą jaźń", "", ""].join("\n");

function archive(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(files)) {
    // Uploads are routinely in the national code page, not UTF-8.
    entries[name] = new Uint8Array(Buffer.from(text, "latin1"));
  }
  return Buffer.from(zipSync(entries));
}

function response(zip: Buffer): Buffer {
  return Buffer.concat([Buffer.from("OK-2|lp:473168513|fps:23.976||"), zip]);
}

test("the response splits into a header and an intact archive", () => {
  const zip = archive({ "film.srt": SRT });
  const parsed = parseCheckSubResponse(response(zip));

  assert.equal(parsed.status, "found");
  assert.equal(parsed.fields["lp"], "473168513");
  // The archive has to survive byte for byte, or it will not open.
  assert.ok(parsed.archive?.equals(zip));
});

test("the subtitle is taken by extension, not by position", () => {
  // The advertising file comes first in the archive on purpose here.
  const zip = archive({ "Napisy24.pl.url": "[InternetShortcut]", "film.srt": SRT });

  const parsed = parseCheckSubResponse(response(zip));
  assert.ok(parsed.archive);

  const files = unzipSync(new Uint8Array(parsed.archive));
  const picked = Object.keys(files).filter(isSubtitleFile);

  assert.deepEqual(picked, ["film.srt"]);
});

test("a Polish subtitle survives the archive and the code page", () => {
  const polish = SRT.replace(
    "Zażółć gęślą jaźń",
    Buffer.from("Zażółć gęślą jaźń", "utf8").toString("latin1"),
  );

  const parsed = parseCheckSubResponse(response(archive({ "film.srt": polish })));
  const files = unzipSync(new Uint8Array(parsed.archive!));
  const cues = parseSubtitle(decodeSubtitle(Buffer.from(files["film.srt"]!), "pl"));

  assert.equal(cues.length, 1);
  assert.equal(cues[0]!.start, 4000);
  assert.match(cues[0]!.text, /Zażółć gęślą jaźń/);
});
