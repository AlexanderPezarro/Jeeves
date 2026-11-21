import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { BASE_PATH } from "./env";

/** A tiny history router under the mount ("/admin/" or "/app/"). Paths here are relative to it, e.g. "/workflows/x". */
const BASE = BASE_PATH.replace(/\/$/, "");

function current(): string {
  const p = window.location.pathname;
  const rel = p.startsWith(BASE) ? p.slice(BASE.length) : p;
  return rel || "/";
}

type Guard = () => boolean;
let guard: Guard | null = null;
/** Pages with unsaved changes register a guard that may veto navigation. */
export function setNavigationGuard(g: Guard | null) {
  guard = g;
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (guard && !guard()) return;
  const url = BASE + to;
  if (opts.replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new Event("jeeves:navigate"));
  if (!opts.replace) window.scrollTo(0, 0);
}

export function useLocation(): { path: string; search: URLSearchParams } {
  const [loc, setLoc] = useState(() => ({ path: current(), search: window.location.search }));
  useEffect(() => {
    const update = () => setLoc({ path: current(), search: window.location.search });
    window.addEventListener("popstate", update);
    window.addEventListener("jeeves:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("jeeves:navigate", update);
    };
  }, []);
  return { path: loc.path, search: new URLSearchParams(loc.search) };
}

/** Matches "/workflows/:id" style patterns; returns decoded params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) out[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}

export function Link({ to, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={BASE + to} onClick={onClick} />;
}
