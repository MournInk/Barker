import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  turbopack: {},
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Task/settings/overview responses contain live state and are re-fetched
        // every 5s; never let a proxy or browser reuse them.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
  webpack: (config, { nextRuntime }) => {
    // This hook only applies to webpack builds (`next build --webpack`);
    // Turbopack builds never invoke it. instrumentation.ts is also bundled by
    // the edge compiler in dev, where the node: scheme is otherwise unhandled.
    // Those imports are only executed under NEXT_RUNTIME=nodejs (see the guard
    // in register), so keep them external.
    if (nextRuntime === "edge") {
      config.externals = [
        ...config.externals,
        ({ request }: { request?: string }, callback: (error?: null, result?: string) => void) => {
          if (request?.startsWith("node:")) return callback(null, `commonjs ${request}`);
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
