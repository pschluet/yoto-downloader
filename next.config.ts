import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained .next/standalone build (only traced files, not all
  // of node_modules) so the Docker runtime image stays small.
  output: "standalone",
};

export default nextConfig;
