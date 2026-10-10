import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Load the repository-root `.env` (development convenience) before Next.js
 * reads its own. Production deployments provide real environment variables.
 * No secret is exposed to the client; only server processes read these values.
 */
function loadRootEnv(): void {
  const candidates = [
    fileURLToPath(new URL("../../.env", import.meta.url)),
    ".env",
    ".env.local",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        return;
      } catch {
        // Ignore; server configuration validation reports real problems.
      }
    }
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
