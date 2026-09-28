import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { accessGate, accessPrefix } from "../src/access";
import { baseUrl, runWithRequest } from "../src/context";
import type { Request } from "express";

/**
 * The gate is the only thing standing between a public hostname and an instance
 * that spends its owner's OpenSubtitles and TorBox keys on every request, so
 * each way past it is checked here rather than by hand after a deploy.
 */

const TOKEN = "a1b2c3d4e5f60718293a4b5c";

let server: Server;
let origin: string;

before(async () => {
  const app = express();
  const gate = accessGate(TOKEN);
  assert.ok(gate, "a non-empty token has to produce a gate");
  app.use(gate);
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  // Echoes what the rest of the addon would see after the prefix is stripped.
  app.get("/manifest.json", (req, res) => {
    res.json({ path: req.path, query: req.query });
  });
  app.get("/configure", (_req, res) => {
    res.type("text/html").send("<html></html>");
  });
  app.get("/", (_req, res) => {
    res.type("text/plain").send("root");
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("an unset or blank token leaves the addon open, as a home install expects", () => {
  assert.equal(accessGate(undefined), null);
  assert.equal(accessGate(""), null);
  assert.equal(accessGate("   "), null);
});

test("health stays public so the platform healthcheck can reach it", async () => {
  const res = await fetch(`${origin}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("the right prefix passes through and is stripped before routing", async () => {
  const res = await fetch(`${origin}/${TOKEN}/manifest.json`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: "/manifest.json", query: {} });

  const page = await fetch(`${origin}/${TOKEN}/configure`);
  assert.equal(page.status, 200);

  // The prefix on its own is the landing page, not a 404.
  const root = await fetch(`${origin}/${TOKEN}`);
  assert.equal(root.status, 200);
  assert.equal(await root.text(), "root");
});

test("a query string survives the prefix being stripped", async () => {
  const res = await fetch(`${origin}/${TOKEN}/manifest.json?v=2`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: "/manifest.json", query: { v: "2" } });
});

test("anything without the prefix is a 404 that gives nothing away", async () => {
  for (const path of ["/manifest.json", "/", "/configure", "/subtitles/movie/tt0111161.json"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 404, `${path} must not be served`);
    assert.equal(await res.text(), "Not found");
  }
});

test("a refusal is logged without the path it was refused for", async (t) => {
  // A near-miss token must not reach the log, but the refusal itself has to,
  // or a mistyped install address looks like no request at all.
  const lines: string[] = [];
  t.mock.method(console, "log", (line: unknown) => {
    lines.push(String(line));
  });

  const res = await fetch(`${origin}/${TOKEN.slice(0, 20)}/manifest.json`);
  assert.equal(res.status, 404);

  const refusals = lines.filter((l) => l.includes("<blocked>"));
  assert.equal(refusals.length, 1);
  assert.ok(!refusals[0]?.includes(TOKEN.slice(0, 20)), "the attempted token must not be logged");
  assert.ok(!refusals[0]?.includes("manifest.json"), "the attempted path must not be logged");
});

test("a wrong or partial prefix is a 404 too", async () => {
  for (const path of [
    `/wrong/manifest.json`,
    `/${TOKEN}x/manifest.json`,
    `/${TOKEN.slice(0, 8)}/manifest.json`,
    `/x${TOKEN}/manifest.json`,
  ]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 404, `${path} must not be served`);
  }
});

/** Just enough of an Express request for the origin to be read from it. */
function requestTo(host: string): Request {
  return {
    headers: { host },
    protocol: "http",
    get: (name: string) => (name.toLowerCase() === "host" ? host : undefined),
  } as unknown as Request;
}

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("generated links carry the prefix, with BASE_URL and without", () => {
  withEnv({ ACCESS_TOKEN: TOKEN, BASE_URL: undefined }, () => {
    assert.equal(accessPrefix(), `/${TOKEN}`);
    assert.equal(
      runWithRequest(requestTo("subsync.up.railway.app"), baseUrl),
      `http://subsync.up.railway.app/${TOKEN}`,
    );
  });

  withEnv({ ACCESS_TOKEN: TOKEN, BASE_URL: "https://subsync.up.railway.app" }, () => {
    assert.equal(
      runWithRequest(requestTo("10.0.0.5:7000"), baseUrl),
      `https://subsync.up.railway.app/${TOKEN}`,
    );
  });
});

test("a trailing slash or a token already in BASE_URL does not double up", () => {
  withEnv({ ACCESS_TOKEN: TOKEN, BASE_URL: "https://subsync.up.railway.app/" }, () => {
    assert.equal(
      runWithRequest(requestTo("10.0.0.5:7000"), baseUrl),
      `https://subsync.up.railway.app/${TOKEN}`,
    );
  });

  withEnv({ ACCESS_TOKEN: TOKEN, BASE_URL: `https://subsync.up.railway.app/${TOKEN}` }, () => {
    assert.equal(
      runWithRequest(requestTo("10.0.0.5:7000"), baseUrl),
      `https://subsync.up.railway.app/${TOKEN}`,
    );
  });
});

test("without a token the links are exactly what they were before", () => {
  withEnv({ ACCESS_TOKEN: undefined, BASE_URL: "https://subs.example.com" }, () => {
    assert.equal(accessPrefix(), "");
    assert.equal(runWithRequest(requestTo("10.0.0.5:7000"), baseUrl), "https://subs.example.com");
  });
});
