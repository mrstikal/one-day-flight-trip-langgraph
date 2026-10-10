import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Unit tests exercise shared-package source (fast, no build required).
 * Integration tests require a disposable PostgreSQL 17 database via
 * TEST_DATABASE_URL and exercise real SQL migrations and the official
 * LangGraph checkpointer.
 */
const alias = {
  "@odft/contracts": src("./packages/contracts/src/index.ts"),
  "@odft/domain": src("./packages/domain/src/index.ts"),
  "@odft/data": src("./packages/data/src/index.ts"),
  "@odft/ai": src("./packages/ai/src/index.ts"),
  "@odft/persistence": src("./packages/persistence/src/index.ts"),
  "@odft/workflow": src("./packages/workflow/src/index.ts"),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: ["tests/setup-env.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: ["tests/setup-env.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
