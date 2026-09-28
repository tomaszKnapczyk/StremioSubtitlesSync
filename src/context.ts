import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import { accessPrefix } from "./access";

/**
 * The subtitle handler has to hand Stremio absolute URLs back, but the SDK
 * gives the handler no access to the request. Rather than force everyone to set
 * BASE_URL, stash the incoming origin per request and read it inside the
 * handler. BASE_URL still wins when it is set, which is what you want behind a
 * proxy chain that rewrites the host. The one exception is a loopback BASE_URL
 * seen by a client on another device, which could never follow such a link.
 */

interface RequestContext {
  baseUrl: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

function originOf(request: Request): string {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  const protocol = forwardedProto || request.protocol || "http";
  const host = forwardedHost || request.get("host") || `127.0.0.1:${process.env.PORT ?? 7000}`;
  return `${protocol}://${host}`;
}

export function runWithRequest<T>(request: Request, fn: () => T): T {
  return storage.run({ baseUrl: originOf(request) }, fn);
}

export function baseUrl(): string {
  const configured = process.env.BASE_URL?.trim().replace(/\/+$/, "");
  const fromRequest = storage.getStore()?.baseUrl;

  // A loopback BASE_URL only works on the machine running the addon. A TV or
  // phone on the same network would be handed links pointing back at itself,
  // so for those the address they actually connected to wins.
  const wrongForClient =
    configured !== undefined &&
    fromRequest !== undefined &&
    isLoopback(configured) &&
    !isLoopback(fromRequest);

  const origin =
    configured && !wrongForClient
      ? configured
      : (fromRequest ?? `http://127.0.0.1:${process.env.PORT ?? 7000}`);

  return withAccessPrefix(origin);
}

/**
 * Links have to point back through the access gate, which strips the prefix
 * before the rest of the addon ever sees a request. BASE_URL is documented as
 * the bare origin, but a token pasted onto it anyway must not be doubled.
 */
function withAccessPrefix(origin: string): string {
  const prefix = accessPrefix();
  if (!prefix) return origin;
  const trimmed = origin.replace(/\/+$/, "");
  if (trimmed === prefix || trimmed.endsWith(prefix)) return trimmed;
  return `${trimmed}${prefix}`;
}

function isLoopback(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}
