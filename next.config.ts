import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained .next/standalone build (only traced files, not all
  // of node_modules) so the Docker runtime image stays small.
  output: "standalone",
  // Next's own gzip would buffer the /api/jobs/[id]/events response before
  // sending it, defeating response streaming end-to-end through the Lambda
  // Web Adapter + Function URL + CloudFront chain. CloudFront's own
  // per-behavior compression is also disabled for that route in
  // infra/lib/edge-stack.ts for the same reason.
  compress: false,
};

export default nextConfig;
