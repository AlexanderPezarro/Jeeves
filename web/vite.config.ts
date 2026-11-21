import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The server serves web/dist at /admin/. In dev, `npm run dev` proxies /admin/api to a local server
 * on :8080 and adds the Remote-User header Caddy + Authelia would set in production. The server only
 * trusts it from a trusted peer (JEEVES_TRUST_PROXY_AUTH=1 with 127.0.0.1 in JEEVES_TRUSTED_PROXY),
 * or use `npx tsx src/testserver.ts` in server/ with JEEVES_DEV_TARGET=http://127.0.0.1:8090.
 */
const target = process.env.JEEVES_DEV_TARGET ?? "http://localhost:8080";
const devUser = process.env.JEEVES_DEV_USER ?? "dev";

export default defineConfig(({ command }) => ({
  // Built with relative URLs so one build serves /admin/ and the app's /app/; the server adds a <base>.
  base: command === "build" ? "./" : "/admin/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    proxy: {
      "/admin/api": {
        target,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => req.setHeader("Remote-User", devUser));
        },
      },
    },
  },
}));
