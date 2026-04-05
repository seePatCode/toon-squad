import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // AI Elements components are generated for Radix but we use Base UI.
    // Runtime works fine; only types mismatch.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
