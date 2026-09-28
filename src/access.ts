import type { RequestHandler } from "express";

/**
 * A private instance whose API keys come from the environment spends those keys
 * on every request it answers, so its hostname alone must not be enough to use
 * it. With ACCESS_TOKEN set the addon answers only under /<token>/…, and
 * everything else is a plain 404 that tells a stranger nothing.
 *
 * /health stays public: the platform healthcheck has no way to carry the token,
 * and it reveals only that the process is up.
 */
export function accessGate(token: string | undefined): RequestHandler | null {
  const clean = token?.trim();
  if (!clean) return null;
  const prefix = `/${clean}`;
  return (req, res, next) => {
    if (req.path === "/health") return next();
    const url = req.url;
    if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
      // The rest of the addon is written as if it were mounted at the root, so
      // the prefix is stripped here and added back by accessPrefix() wherever a
      // URL is handed out.
      req.url = url.slice(prefix.length) || "/";
      return next();
    }
    res.status(404).type("text/plain").send("Not found");
  };
}

/** The path prefix every generated link has to carry, "" when the gate is off. */
export function accessPrefix(): string {
  const clean = process.env.ACCESS_TOKEN?.trim();
  return clean ? `/${clean}` : "";
}
