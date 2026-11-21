/**
 * Where the UI is mounted. The server injects `window.__JEEVES__` into index.html: `/admin/` for the
 * browser (behind Authelia) or `/app/` inside the phone app's WebView (`embedded`). The production
 * build uses relative asset URLs, so the same build serves both; `npm run dev` runs at /admin/.
 */
declare global {
  interface Window {
    __JEEVES__?: { base: string; embedded: boolean };
  }
}

const fromBuild = import.meta.env.BASE_URL.startsWith("/") ? import.meta.env.BASE_URL : "/admin/";

/** The mount with a trailing slash, e.g. "/admin/". */
export const BASE_PATH: string = window.__JEEVES__?.base ?? fromBuild;

/** True inside the phone app: no top navigation, the app has its own. */
export const EMBEDDED: boolean = window.__JEEVES__?.embedded ?? false;
