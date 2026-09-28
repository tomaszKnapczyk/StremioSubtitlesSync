import express from "express";
import { getRouter } from "stremio-addon-sdk";
import { addonInterface } from "./addon";
import { accessGate, accessPrefix } from "./access";
import { landingPage } from "./landing";
import { runWithRequest } from "./context";
import { log, logToFile } from "./log";
import { subtitleRoutes } from "./routes/subtitles";

const port = Number(process.env.PORT ?? 7000);
const app = express();

// A copy of the log that outlives the terminal. LOG_FILE=off writes nothing.
const logFile = process.env.LOG_FILE ?? "subtitle-sync.log";
if (logFile !== "off") logToFile(logFile);

// Behind a proxy, trust the forwarded headers so req.protocol is the real one.
app.set("trust proxy", true);
app.disable("x-powered-by");

// Stremio clients are not same-origin with the addon. A client on a public
// https site calling this addon on 127.0.0.1 also sends a private network
// preflight, which needs its own opt-in header.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});

// Keys from the environment are spent on every request, so on a public host the
// addon answers only under a secret path prefix. This sits after CORS but
// before the log: the token must never reach a hosting platform's log.
const gate = accessGate(process.env.ACCESS_TOKEN);
if (gate) app.use(gate);

// One line per request. Stremio shows the same empty menu whether a request
// failed, never arrived, or was given up on, so the log has to tell them apart.
app.use((req, res, next) => {
  const started = Date.now();
  // An installed addon's first path segment is its config, API keys included.
  // The SDK installs it as plain JSON; subtitle file URLs carry it as base64.
  const path = req.path.replace(/^\/(?:[A-Za-z0-9_-]{20,}|[^/]*(?:%7B|\{)[^/]*)(?=\/)/i, "/<config>");
  let finished = false;
  res.on("finish", () => {
    finished = true;
    log.info(`${req.method} ${path} -> ${res.statusCode} in ${Date.now() - started}ms`);
  });
  res.on("close", () => {
    if (finished) return;
    log.warn(
      `${req.method} ${path} -> client closed the connection after ` +
        `${Date.now() - started}ms, before the answer was sent`,
    );
  });
  next();
});

// Carry the request origin into the subtitle handler, which the SDK calls
// without any reference to the request.
app.use((req, _res, next) => {
  runWithRequest(req, next);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: addonInterface.manifest.version });
});

// getRouter serves the manifest and the resource endpoints, but not the
// install page. serveHTTP adds that, and this app does not use serveHTTP, so
// the same template is mounted here.
const page = landingPage(addonInterface.manifest, accessPrefix());
const servePage = (_req: express.Request, res: express.Response): void => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(page);
};
app.get("/", servePage);
app.get("/configure", servePage);
// An already-configured install links back to /<config>/configure.
app.get("/:config/configure", servePage);

// Our own file routes come first; the SDK router owns everything else.
app.use(subtitleRoutes());
app.use(getRouter(addonInterface));

app.listen(port, () => {
  const base = process.env.BASE_URL?.replace(/\/+$/, "") ?? `http://127.0.0.1:${port}`;
  log.info(`Subtitle Sync listening on port ${port}`);
  // The real token stays out of the log; the line only shows where it goes.
  const shown = accessPrefix() ? "/<ACCESS_TOKEN>" : "";
  log.info(`Manifest:  ${base}${shown}/manifest.json`);
  log.info(`Configure: ${base}${shown}/configure`);
  if (!process.env.OS_API_KEY) {
    log.warn("OS_API_KEY is not set. Users must supply their own key via /configure.");
  }
});
