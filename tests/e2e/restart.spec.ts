import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Minimal Phase 05 end-to-end flow: session issuance, a trip whose creation the
 * real worker drives to an interrupt, a command admitted as 202, and the SSE
 * stream opening. It spawns the actual worker process (tsx) against the same
 * PostgreSQL database the web server uses.
 *
 * The SIGKILL restart recipe is covered by the integration worker restart test
 * (`tests/integration/worker/restart.test.ts`), which observes real OS processes.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;
const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

let worker: ChildProcess | undefined;

test.beforeAll(() => {
  worker = spawn(TSX, ["--tsconfig", "tsconfig.json", "apps/worker/src/main.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, AI_MODE: "fixture", WORKER_CONCURRENCY: "1" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
});

test.afterAll(() => {
  if (worker?.pid && worker.exitCode === null && worker.signalCode === null) {
    try {
      // Kill the whole process group so the tsx child does not linger.
      process.kill(-worker.pid, "SIGKILL");
    } catch {
      worker.kill("SIGKILL");
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("session, worker-driven interrupt, command admission (202), and SSE stream", async ({
  request,
  baseURL,
}) => {
  const sessionRes = await request.post("/api/session", { headers: { origin: ORIGIN } });
  expect([200, 201]).toContain(sessionRes.status());
  const session = (await sessionRes.json()) as { sessionId: string; csrfToken: string };
  const cookie = sessionRes.headers()["set-cookie"]?.split(";")[0] ?? "";

  const countries = (await (await request.get("/api/reference/countries")).json()) as {
    items: Array<{ countryKey: string }>;
  };
  expect(countries.items.length).toBeGreaterThan(0);
  const countryKey = countries.items[0]?.countryKey as string;

  const cities = (await (
    await request.get(`/api/reference/cities?country=${countryKey}`)
  ).json()) as { items: Array<{ id: string }> };
  expect(cities.items.length).toBeGreaterThan(0);

  const airports = (await (await request.get("/api/reference/airports")).json()) as {
    items: Array<{ id: string }>;
  };
  expect(airports.items.length).toBeGreaterThan(0);

  const created = await request.post("/api/trips", {
    headers: { origin: ORIGIN, "x-csrf-token": session.csrfToken },
    data: {
      creationRequestId: randomUUID(),
      userName: "E2E Traveller",
      adults: 1,
      originAirportId: airports.items[0]?.id,
      destinationCityId: cities.items[0]?.id,
      destinationCountryKey: countryKey,
      sightseeingDate: "2026-12-01",
      travelVariant: "one_night",
    },
  });
  expect(created.status()).toBe(201);
  const trip = (await created.json()) as { tripId: string; operationId: string };

  // The worker drives the creation operation to the interrupt (waiting_user).
  let status = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const operationStatus = (await (
      await request.get(`/api/trips/${trip.tripId}/operations/${trip.operationId}`)
    ).json()) as { status: string };
    status = operationStatus.status;
    if (status === "waiting") {
      break;
    }
    await sleep(250);
  }
  expect(status).toBe("waiting");

  const command = await request.post(`/api/trips/${trip.tripId}/commands`, {
    headers: { origin: ORIGIN, "x-csrf-token": session.csrfToken },
    data: { requestId: randomUUID(), expectedRevision: 1, command: { type: "retry_failed_domains" } },
  });
  expect(command.status()).toBe(202);

  const controller = new AbortController();
  const streamRes = await fetch(`${baseURL}/api/trips/${trip.tripId}/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
  const reader = streamRes.body?.getReader();
  const first = await reader?.read();
  controller.abort();
  expect(new TextDecoder().decode(first?.value)).toContain("connected");
});
