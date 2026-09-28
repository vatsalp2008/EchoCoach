import path from "path";
import type { NextConfig } from "next";

// In production the browser only ever talks to this app's own origin: /api/*
// is proxied to the FastAPI backend at BACKEND_URL (e.g. its Railway URL).
// That keeps the session cookie first-party - Safari drops cookies set by a
// different site - and takes CORS out of the picture. Local dev leaves
// BACKEND_URL unset and calls http://localhost:8000 directly (see lib/api.ts).
const BACKEND_URL = process.env.BACKEND_URL?.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // Pin the workspace root to this dir. Without this, Turbopack sees the root
  // package-lock.json (added for `npm run dev` at the repo root) and picks the
  // repo root as the workspace, which breaks its React Server Components
  // module manifest resolution.
  turbopack: {
    root: path.join(__dirname),
  },
  async rewrites() {
    return BACKEND_URL ? [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }] : [];
  },
  async headers() {
    // API responses are per-user (/api/me, sessions...) - never let Vercel's
    // CDN cache them, whatever headers the backend sends.
    return BACKEND_URL
      ? [{ source: "/api/:path*", headers: [{ key: "x-vercel-enable-rewrite-caching", value: "0" }] }]
      : [];
  },
};

export default nextConfig;
