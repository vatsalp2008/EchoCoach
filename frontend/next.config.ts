import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this dir. Without this, Turbopack sees the root
  // package-lock.json (added for `npm run dev` at the repo root) and picks the
  // repo root as the workspace, which breaks its React Server Components
  // module manifest resolution.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
