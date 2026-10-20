import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {},
  serverExternalPackages: ["node:sqlite", "node:crypto", "node:fs", "node:path"],
  webpack: (config, { nextRuntime }) => {
    // instrumentation.ts is also bundled by the edge compiler in dev, where the
    // node: scheme is otherwise unhandled. Those imports are only executed under
    // NEXT_RUNTIME=nodejs (see the guard in register), so keep them external.
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
