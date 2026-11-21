import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

/**
 * Who may claim an identity with `Remote-User`: only Caddy (after Authelia's forward_auth), i.e.
 * requests whose socket peer is in a trusted range, and only when JEEVES_TRUST_PROXY_AUTH=1.
 */
export interface ProxyAuthConfig {
  trust: boolean;
  /** CIDRs or single addresses, e.g. "172.18.0.0/16" (proxy_network) or "172.18.0.5". */
  trustedProxies: string[];
}

export function proxyAuthFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyAuthConfig {
  return {
    trust: env.JEEVES_TRUST_PROXY_AUTH === "1",
    trustedProxies: (env.JEEVES_TRUSTED_PROXY ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Builds a matcher for peer addresses. IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4. */
export function peerMatcher(cfg: ProxyAuthConfig): (address: string | undefined) => boolean {
  if (!cfg.trust || !cfg.trustedProxies.length) return () => false;
  const list = new BlockList();
  for (const entry of cfg.trustedProxies) {
    const [addr, bits] = entry.split("/");
    const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (!isIP(addr)) throw new Error(`JEEVES_TRUSTED_PROXY: "${entry}" is not an address or CIDR`);
    if (bits !== undefined) list.addSubnet(addr, Number(bits), family);
    else list.addAddress(addr, family);
  }
  return (address) => {
    if (!address) return false;
    const v4 = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
    const family = isIP(v4) === 6 ? "ipv6" : "ipv4";
    return isIP(v4) !== 0 && list.check(v4, family);
  };
}

export const IDENTITY_HEADERS = ["remote-user", "remote-groups", "remote-name", "remote-email"];

/**
 * Short-lived signed tokens for the plugin UI in the app's WebView, which cannot put a bearer
 * header on subresource requests. `?t=<token>` is swapped for a cookie scoped to the plugin path.
 */
export class UiTokens {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}

  mint(plugin: string, ttlMs: number, now = new Date()): { token: string; expires_at: string } {
    const exp = now.getTime() + ttlMs;
    const body = `${plugin}.${exp}`;
    return { token: `${body}.${this.sign(body)}`, expires_at: new Date(exp).toISOString() };
  }

  verify(token: string | undefined, plugin: string, now = new Date()): boolean {
    return this.subject(token, now) === plugin;
  }

  /** The name a valid, unexpired token was minted for, else null. */
  subject(token: string | undefined, now = new Date()): string | null {
    if (!token) return null;
    const i = token.lastIndexOf(".");
    if (i < 0) return null;
    const body = token.slice(0, i);
    const sig = Buffer.from(token.slice(i + 1));
    const want = Buffer.from(this.sign(body));
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
    const [name, exp] = [body.slice(0, body.lastIndexOf(".")), Number(body.slice(body.lastIndexOf(".") + 1))];
    return Number.isFinite(exp) && exp > now.getTime() ? name : null;
  }

  private sign(body: string) {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}
