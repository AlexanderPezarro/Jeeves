import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { UiTokens } from "./auth.js";
import type { Db, Device } from "./db.js";
import { cookies } from "./pluginapi.js";

/**
 * The web UI embedded in the phone app's WebView, at /app/. A paired phone asks for a short-lived
 * link (`POST /app/session` with its device token); opening it swaps the token for an HttpOnly
 * cookie scoped to /app/, which authenticates /app/api/* (the same routes the app's bearer token
 * reaches). Tokens come from a dedicated UiTokens, so they can never pass as plugin UI tokens.
 */
export const APP_MOUNT = "/app";
const APP_COOKIE = "jeeves_app";
const LINK_TTL = 2 * 60_000;
const COOKIE_TTL = 8 * 3600_000;
const PATH = /^[A-Za-z0-9/_.-]*$/;

const subjectFor = (device: Device) => `device:${device.id}`;

function deviceFor(db: Db, subject: string | null): Device | undefined {
  const m = subject?.match(/^device:(\d+)$/);
  return m ? db.deviceById(Number(m[1])) : undefined;
}

/** `POST /app/session {path?}` in the device-token scope: a link that opens the embedded UI at `path`. */
export function registerAppSession(authed: FastifyInstance, { tokens, now }: { tokens: UiTokens; now: () => Date }) {
  authed.post("/app/session", async (req, reply) => {
    const body = z.object({ path: z.string().max(200).regex(PATH).default("workflows") }).safeParse(req.body ?? {});
    if (!body.success || body.data.path.split("/").includes("..")) {
      return reply.code(400).send({ error: "validation", message: "path must be a relative app path" });
    }
    const t = tokens.mint(subjectFor(req.device!), LINK_TTL, now());
    const path = body.data.path.replace(/^\/+/, "");
    return { url: `${APP_MOUNT}/${path}?t=${encodeURIComponent(t.token)}`, expires_at: t.expires_at };
  });
}

/** The device behind the request's /app cookie, if the cookie is valid and the device still exists. */
export function appCookieDevice(req: FastifyRequest, db: Db, tokens: UiTokens, now: () => Date): Device | undefined {
  return deviceFor(db, tokens.subject(cookies(req)[APP_COOKIE], now()));
}

/**
 * For page loads under /app/: a `?t=` link token becomes the session cookie (when valid) and the
 * browser is redirected to the same URL without it. Returns true when it has replied.
 */
export function acceptAppLink(req: FastifyRequest, reply: FastifyReply, db: Db, tokens: UiTokens, now: () => Date): boolean {
  const t = (req.query as { t?: string }).t;
  if (!t) return false;
  const device = deviceFor(db, tokens.subject(t, now()));
  const url = new URL(req.url, "http://x");
  url.searchParams.delete("t");
  if (device) {
    const long = tokens.mint(subjectFor(device), COOKIE_TTL, now());
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    reply.header(
      "set-cookie",
      `${APP_COOKIE}=${encodeURIComponent(long.token)}; Path=${APP_MOUNT}/; Max-Age=${COOKIE_TTL / 1000}; HttpOnly; SameSite=Strict${secure}`,
    );
  }
  reply.redirect(url.pathname + url.search);
  return true;
}
