import { test } from "node:test";
import assert from "node:assert/strict";
import { listLifetime } from "../src/addon";

/**
 * The player keeps a subtitle list as long as the addon says, and on a live
 * install it went on showing entries for hours after they had stopped working.
 * These pin the parts of the rule that do not depend on the day's quota.
 */

test("a list that will still be right later is kept for six hours", () => {
  assert.equal(listLifetime([{ rank: 0, needsQuota: false }]), 6 * 3600);
});

test("a list holding an entry left as uploaded is kept for an hour", () => {
  // The next ask may do better: a reference read, a pair learned not to align.
  assert.equal(
    listLifetime([
      { rank: 0, needsQuota: false },
      { rank: 4, needsQuota: false },
    ]),
    3600,
  );
});
