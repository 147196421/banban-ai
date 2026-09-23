import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const localDatabase = fileURLToPath(new URL("./self-hosted/cloudflare-workers-shim.mjs", import.meta.url));

const nextConfig: NextConfig = {
  experimental: {
    cpus: 1,
    webpackMemoryOptimizations: true,
  },
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^cloudflare:workers$/, localDatabase));
    return config;
  },
};

export default nextConfig;
