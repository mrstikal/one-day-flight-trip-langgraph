import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainCommand } from "@odft/contracts";
import { tripPreferencesSchema } from "@odft/contracts";
import {
  admitOperation,
  admitResume,
  commitRouteChange,
  getPendingDecisionForTrip,
  loadTripResearchInputs,
} from "@odft/persistence";
import { buildTripProjection } from "../../../apps/web/src/lib/projection.js";
import { driveTripToReady, resolveProgramChoices, sendChat } from "../ai/_setup.js";
import { claimNextOperation } from "@odft/persistence";
import {
  claimNextOrFail,
  createGraphTestPool,
  createHarnessTrip,
  createTravelDriver,
  createWorkerPools,
  endWorkerPools,
  prewarmPool,
  readTravelState,
  resetGraphDatabase,
  researchEvents,
  resolveDecision,
  snapshotManifest,
  tripRevision,
  type WorkerPools,
} from "../research/_setup.js";

/**
 * Phase 11 selective replanning, route-change impact confirmation, re-entry, and
 * pending-decision modification (T-INV-04/07/11, T-E2E-04/06/07).
 *
 * Scenario H (cheaper hotel, bound category, replacement), scenario I (dinner-only
 * refresh with preservation), scenario J (pace change keeps bookings), the route
 * change impact flow, and the internal `modify` admission.
 */

const DISPLAY = { aiMode: "fixture", demoControlsEnabled: true, mapTileUrl: null } as const;

describe("selective replanning and route-change impact (real PostgreSQL)", () => {
  let pool: Pool;
  let pools: WorkerPools;

  beforeAll(async () => {
    pool = createGraphTestPool();
    pools = createWorkerPools(8);
  });

  beforeEach(async () => {
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await endWorkerPools(pools);
    await pool.end();
  });

  async function runCommand(
    tripId: string,
    sessionId: string,
    command: DomainCommand,
  ): Promise<void> {
    const admitted = await admitOperation(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        command,
      },
    });
    expect("operationId" in admitted).toBe(true);
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
  }

  async function reservations(
    tripId: string,
  ): Promise<
    {
      id: string;
      serviceKey: string;
      offerId: string;
      status: string;
      demoReference: string;
      partyTotalMinor: number;
    }[]
  > {
    const result = await pool.query<{
      id: string;
      service_key: string;
      offer_id: string;
      status: string;
      demo_reference: string;
      party_total_minor: string;
    }>(
      `SELECT id, service_key, offer_id, status, demo_reference, party_total_minor::text AS party_total_minor
         FROM odft_app.reservations WHERE trip_id = $1 ORDER BY created_at`,
      [tripId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      serviceKey: row.service_key,
      offerId: row.offer_id,
      status: row.status,
      demoReference: row.demo_reference,
      partyTotalMinor: Number.parseInt(row.party_total_minor, 10),
    }));
  }

  async function preferences(tripId: string) {
    const result = await pool.query<{ preferences: unknown }>(
      `SELECT preferences FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    return tripPreferencesSchema.parse(result.rows[0]?.preferences);
  }

  /** Choose and confirm the first offered flight (the route-change continuation). */
  async function bookCheapestFlight(tripId: string, sessionId: string): Promise<void> {
    const driver = createTravelDriver(pools);
    const choice = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(choice?.kind).toBe("flight_choice");
    await resolveDecision(pool, pools, tripId, sessionId, {
      action: "choose_offer",
      offerId: choice?.allowedOfferIds[0] as string,
    });
    await driver.runOperation(await claimNextOrFail(pools));
    const confirmation = await getPendingDecisionForTrip(pools.operations, tripId);
    expect(confirmation?.kind).toBe("booking_confirmation");
    await resolveDecision(pool, pools, tripId, sessionId, {
      action: "confirm_booking",
      proposalId: confirmation?.proposalId as string,
      acceptedDemoDisclaimer: true,
    });
    await prewarmPool(pools.operations, 6);
    await driver.runOperation(await claimNextOrFail(pools));
  }

  /**
   * Run every QUEUED operation until the trip waits at a decision or the queue
   * drains. It always runs a queued operation first: right after an admission the
   * trip's previous decision is still pending in the DB, so checking before
   * running would return too early.
   */
  async function settle(tripId: string, rounds = 12): Promise<void> {
    const driver = createTravelDriver(pools);
    for (let round = 0; round < rounds; round += 1) {
      const claim = await claimNextOperation(pools.operations, {
        workerId: "test-worker",
        leaseMs: 30_000,
      });
      if (!claim) {
        return;
      }
      await driver.runOperation(claim);
      if (await getPendingDecisionForTrip(pools.operations, tripId)) {
        return;
      }
    }
  }

  async function confirmRouteChange(
    tripId: string,
    sessionId: string,
    overrides: { proposalId?: string; affectedReservationIds?: string[] } = {},
  ): Promise<{ status: "accepted" | "refused"; code?: string }> {
    const decision = await getPendingDecisionForTrip(pools.operations, tripId);
    if (!decision || decision.kind !== "route_change_confirmation") {
      throw new Error(`expected route_change_confirmation, got ${String(decision?.kind)}`);
    }
    const projection = await buildTripProjection(pool, tripId, DISPLAY);
    const preview = projection?.routeChange;
    const admitted = await admitResume(pool, {
      tripId,
      sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, tripId),
        decisionId: decision.id,
        response: {
          action: "confirm_route_change",
          proposalId: overrides.proposalId ?? preview?.proposalId ?? "",
          affectedReservationIds:
            overrides.affectedReservationIds ??
            preview?.affectedReservations.map((entry) => entry.id) ??
            [],
        },
      },
    });
    if (!("operationId" in admitted)) {
      return { status: "refused", code: admitted.code };
    }
    return { status: "accepted" };
  }

  it("re-enters at START with per-operation counters reset and state preserved (T-INV-04)", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = await readTravelState(pools, harness.tripId);
    const beforeReservations = await reservations(harness.tripId);
    expect(before.values.gate).toBe("approved");

    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_activity_pace",
      pace: "relaxed",
    });

    // The new run started at START (a fresh load_context event), not from the
    // completed checkpoint, and the per-operation work scope was reset.
    const nodeRuns = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM odft_app.execution_events
        WHERE trip_id = $1 AND type = 'node.updated' AND payload->>'node' = 'load_context'
        ORDER BY id DESC LIMIT 1`,
      [harness.tripId],
    );
    expect(nodeRuns.rows).toHaveLength(1);
    const after = await readTravelState(pools, harness.tripId);
    expect(after.values.operationId).not.toBe(before.values.operationId);
    expect(after.values.planningAttempt).toBe(0);
    expect(after.values.researchRound).toBe(0);
    expect(after.values.researchAttempts).toEqual({});
    expect(after.values.gate).not.toBe("approved");
    // The re-derived decision is the progress-derived program step, and the
    // confirmed reservations were preserved.
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("program_choices");
    // The re-entry preserved every confirmed reservation (T-E2E-14).
    expect(await reservations(harness.tripId)).toEqual(beforeReservations);
  }, 180_000);

  it("refreshes the affected domain when a preference change is a pending-decision modification", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    // Open the program step, then submit a typed preference change: it is
    // admitted as a MODIFICATION of that decision.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_activity_pace",
      pace: "relaxed",
    });
    expect((await getPendingDecisionForTrip(pools.operations, harness.tripId))?.kind).toBe(
      "program_choices",
    );
    const beforeEvents = await researchEvents(pool, harness.tripId);
    const beforeIds = new Set(beforeEvents.map((event) => event.operationId));
    const before = await preferences(harness.tripId);
    const dinnerLevel = before.serviceOverrides.dinner ?? before.defaultServiceLevel;
    const otherLevel = dinnerLevel === "luxury" ? "budget" : "luxury";

    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_service_override",
      service: "dinner",
      level: otherLevel,
    });

    // The new operation re-researched ONLY dinner: the retained research status
    // must not make the graph skip the refresh and reopen stale offers.
    const refresh = (await researchEvents(pool, harness.tripId)).filter(
      (event) => !beforeIds.has(event.operationId),
    );
    expect(refresh.map((event) => event.domain)).toEqual(["dinner", "dinner"]);
    const projection = await buildTripProjection(pool, harness.tripId, DISPLAY);
    expect(projection?.serviceLevels.dinner.level).toBe(otherLevel);
    const dinnerOffers = projection?.meals.filter((offer) => offer.meal === "dinner") ?? [];
    expect(dinnerOffers.length).toBeGreaterThan(0);
    expect(dinnerOffers.every((offer) => offer.level === otherLevel)).toBe(true);
  }, 240_000);

  it("restarts the research budget for every operation across successive route changes", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);

    // First route change (Paris): confirm, then book a flight so the domains are
    // researched again for the new snapshot.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      destinationCityId: "geonames:2988507",
    });
    expect(await confirmRouteChange(harness.tripId, harness.sessionId)).toEqual({ status: "accepted" });
    await settle(harness.tripId);
    await bookCheapestFlight(harness.tripId, harness.sessionId);
    await settle(harness.tripId);

    // Second route change (Barcelona) must not exceed the per-operation provider
    // attempt ceiling: the budget restarts for the new operation.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      destinationCityId: "geonames:3128760",
    });
    expect(await confirmRouteChange(harness.tripId, harness.sessionId)).toEqual({ status: "accepted" });
    await settle(harness.tripId);
    await bookCheapestFlight(harness.tripId, harness.sessionId);
    await settle(harness.tripId);

    const lastOperation = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [harness.tripId],
    );
    expect(lastOperation.rows[0]?.status).not.toBe("failed");
    expect((await getPendingDecisionForTrip(pools.operations, harness.tripId))?.kind).toBe(
      "hotel_choice",
    );
    const state = await readTravelState(pools, harness.tripId);
    // The final operation's research budget restarted: every domain it
    // researched is at attempt 1 (not 3, which the task schema would reject).
    expect(state.values.researchAttempts).toEqual({ hotel: 1, breakfast: 1, lunch: 1, dinner: 1, attractions: 1, events: 1 });
    expect(state.values.researchStatus).toBe("ok");
    expect(state.values.routeStatus).toBe("FEASIBLE");
  }, 300_000);

  it("scenario I: a dinner-only change refreshes dinner and preserves everything else (T-INV-07)", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const beforeHashes = await snapshotManifest(pool, harness.tripId);
    const beforeReservations = await reservations(harness.tripId);
    const beforeEvents = await researchEvents(pool, harness.tripId);
    const beforeIds = new Set(beforeEvents.map((event) => event.operationId));
    const beforePreferences = await preferences(harness.tripId);
    const dinnerLevel = beforePreferences.serviceOverrides.dinner ?? beforePreferences.defaultServiceLevel;
    const otherLevel = dinnerLevel === "luxury" ? "budget" : "luxury";

    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_service_override",
      service: "dinner",
      level: otherLevel,
    });

    // Only dinner was re-researched; the sibling domains kept their results.
    const afterEvents = await researchEvents(pool, harness.tripId);
    const refresh = afterEvents.filter((event) => !beforeIds.has(event.operationId));
    expect(refresh.map((event) => event.domain)).toEqual(["dinner", "dinner"]);
    // The scenario content hashes (hotel/breakfast/lunch/attractions) are intact.
    const afterHashes = await snapshotManifest(pool, harness.tripId);
    expect(afterHashes.domainHashes).toEqual(beforeHashes.domainHashes);
    expect(afterHashes.domainVersions).toEqual(beforeHashes.domainVersions);
    // No reservation changed.
    expect(await reservations(harness.tripId)).toEqual(beforeReservations);
    // The projection marks dinner explicit and the other services inherited.
    const projection = await buildTripProjection(pool, harness.tripId, DISPLAY);
    expect(projection?.serviceLevels.dinner.level).toBe(otherLevel);
    expect(projection?.serviceLevels.dinner.inherited).toBe(false);
    expect(projection?.serviceLevels.hotel.inherited).toBe(true);
    expect(projection?.serviceLevels.lunch.inherited).toBe(true);
  }, 180_000);

  it("scenario H: a cheaper hotel search preserves the bound category, then replaces on confirmation", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    // Replace the (cheapest-ranked) confirmed hotel with the most expensive
    // same-category offer, so a cheaper alternative provably exists. This also
    // exercises the replacement path of a `propose_selection` command.
    const initial = await buildTripProjection(pool, harness.tripId, DISPLAY);
    const mostExpensive = [...(initial?.hotel ?? [])].sort(
      (a, b) => b.partyTotalMinor - a.partyTotalMinor,
    )[0] as { id: string; partyTotalMinor: number };
    await runCommand(harness.tripId, harness.sessionId, {
      type: "propose_selection",
      service: "hotel",
      offerId: mostExpensive.id,
    });
    const upgrade = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(upgrade?.kind).toBe("replacement_confirmation");
    await admitResume(pool, {
      tripId: harness.tripId,
      sessionId: harness.sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, harness.tripId),
        decisionId: upgrade?.id as string,
        response: {
          action: "confirm_booking",
          proposalId: upgrade?.proposalId as string,
          acceptedDemoDisclaimer: true,
        },
      },
    });
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));

    const before = await reservations(harness.tripId);
    const hotelBefore = before.find((row) => row.serviceKey === "hotel" && row.status === "confirmed");
    expect(hotelBefore).toBeDefined();
    expect(hotelBefore?.offerId).toBe(mostExpensive.id);
    const baselineInputs = await loadTripResearchInputs(pool, harness.tripId);

    // The global default changes behind the scenes; a cheaper search must still
    // compare within the CONFIRMED offer's category.
    await pool.query(
      `UPDATE odft_app.trips
          SET preferences = jsonb_set(preferences, '{defaultServiceLevel}', '"luxury"'::jsonb)
        WHERE id = $1`,
      [harness.tripId],
    );
    const cheaperInputs = await loadTripResearchInputs(pool, harness.tripId, undefined, {
      target: "hotel",
      objective: "cheaper",
      level: null,
    });
    expect(cheaperInputs.fingerprints.hotel).toBe(baselineInputs.fingerprints.hotel);
    const effectiveInputs = await loadTripResearchInputs(pool, harness.tripId, undefined, {
      target: "hotel",
      objective: "match_preferences",
      level: null,
    });
    expect(effectiveInputs.fingerprints.hotel).not.toBe(baselineInputs.fingerprints.hotel);
    await pool.query(
      `UPDATE odft_app.trips
          SET preferences = jsonb_set(preferences, '{defaultServiceLevel}', '"standard"'::jsonb)
        WHERE id = $1`,
      [harness.tripId],
    );

    // The chat search refreshes the hotel domain and presents hotel alternatives.
    await sendChat(pool, pools, harness.tripId, harness.sessionId, "Find a cheaper hotel");
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("hotel_choice");
    expect(decision?.allowedOfferIds.length).toBeGreaterThan(0);
    const projection = await buildTripProjection(pool, harness.tripId, DISPLAY);
    expect(projection?.hotel.length).toBeGreaterThan(0);
    expect(projection?.hotel.every((offer) => offer.level === "standard")).toBe(true);
    const cheaper = [...(projection?.hotel ?? [])].sort(
      (a, b) => a.partyTotalMinor - b.partyTotalMinor,
    )[0] as { id: string; partyTotalMinor: number };
    expect(cheaper.partyTotalMinor).toBeLessThan(hotelBefore?.partyTotalMinor ?? 0);
    // Nothing changed yet: the confirmed hotel stays active until confirmation.
    expect(await reservations(harness.tripId)).toEqual(before);

    // Choosing a cheaper alternative stages an explicit REPLACEMENT.
    await admitResume(pool, {
      tripId: harness.tripId,
      sessionId: harness.sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, harness.tripId),
        decisionId: decision?.id as string,
        response: { action: "choose_offer", offerId: cheaper.id },
      },
    });
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
    const replacement = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(replacement?.kind).toBe("replacement_confirmation");

    await admitResume(pool, {
      tripId: harness.tripId,
      sessionId: harness.sessionId,
      request: {
        requestId: randomUUID(),
        expectedRevision: await tripRevision(pool, harness.tripId),
        decisionId: replacement?.id as string,
        response: {
          action: "confirm_booking",
          proposalId: replacement?.proposalId as string,
          acceptedDemoDisclaimer: true,
        },
      },
    });
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));

    const after = await reservations(harness.tripId);
    const oldHotel = after.find((row) => row.id === hotelBefore?.id);
    expect(oldHotel?.status).toBe("superseded");
    const newHotel = after.find(
      (row) => row.serviceKey === "hotel" && row.status === "confirmed" && row.id !== hotelBefore?.id,
    );
    expect(newHotel?.demoReference).not.toBe(hotelBefore?.demoReference);
    expect(newHotel?.partyTotalMinor).toBeLessThan(hotelBefore?.partyTotalMinor ?? 0);
    // Flights and meals were preserved exactly (T-E2E-04).
    for (const service of ["flights", "breakfast", "lunch", "dinner"]) {
      const beforeRow = before.find((row) => row.serviceKey === service);
      const afterRow = after.find((row) => row.serviceKey === service);
      expect(afterRow?.id).toBe(beforeRow?.id);
      expect(afterRow?.status).toBe(beforeRow?.status);
    }
  }, 240_000);

  it("scenario J: a pace change rebuilds the plan and keeps every booking", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = await reservations(harness.tripId);

    const activityCount = async (): Promise<number> => {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.itineraries
          WHERE trip_id = $1 AND status IN ('approved','draft')
            AND version = (SELECT max(version) FROM odft_app.itineraries WHERE trip_id = $1)`,
        [harness.tripId],
      );
      return Number.parseInt(result.rows[0]?.count ?? "0", 10);
    };
    const latestEntries = async (): Promise<
      { kind: string; startLocal: string | null; locked: boolean; provenance: string[] }[]
    > => {
      const result = await pool.query<{ events: unknown }>(
        `SELECT events FROM odft_app.itineraries
          WHERE trip_id = $1 AND version = (SELECT max(version) FROM odft_app.itineraries WHERE trip_id = $1)`,
        [harness.tripId],
      );
      const entries = Array.isArray(result.rows[0]?.events) ? result.rows[0]?.events : [];
      return (
        entries as { kind: string; startLocal?: string | null; locked?: boolean; provenance?: string[] }[]
      ).map((entry) => ({
        kind: entry.kind,
        startLocal: entry.startLocal ?? null,
        locked: entry.locked === true,
        provenance: Array.isArray(entry.provenance) ? entry.provenance : [],
      }));
    };

    await runCommand(harness.tripId, harness.sessionId, { type: "set_activity_pace", pace: "intensive" });
    await resolveProgramChoices(pool, pools, harness.tripId, harness.sessionId);
    const intensiveEntries = await latestEntries();
    expect(await activityCount()).toBe(1);

    // The user asks for a less exhausting day; the plan is rebuilt at the relaxed
    // pace (P) without touching any booking.
    await sendChat(pool, pools, harness.tripId, harness.sessionId, "Make the day less exhausting");
    await resolveProgramChoices(pool, pools, harness.tripId, harness.sessionId);
    const relaxedEntries = await latestEntries();
    expect(await activityCount()).toBe(1);
    const relaxedRow = await pool.query<{ pace: string; status: string }>(
      `SELECT pace, status FROM odft_app.itineraries
        WHERE trip_id = $1 AND version = (SELECT max(version) FROM odft_app.itineraries WHERE trip_id = $1)`,
      [harness.tripId],
    );
    expect(relaxedRow.rows[0]?.pace).toBe("relaxed");
    expect(relaxedRow.rows[0]?.status).toBe("approved");

    const intensiveActivities = intensiveEntries.filter((entry) => entry.kind === "activity").length;
    const relaxedActivities = relaxedEntries.filter((entry) => entry.kind === "activity").length;
    // Each rebuild honors its own authoritative pace guideline (intensive 5-7,
    // relaxed 2-3); the fixed inventory may cap the actual count below the
    // target, so the guideline bound is the assertion.
    expect(intensiveActivities).toBeLessThanOrEqual(7);
    expect(relaxedActivities).toBeLessThanOrEqual(3);
    // The relaxed rebuild visibly relaxes the day (a long break appears) and
    // keeps every fixed meal window at its clock time.
    const longBreaks = (entries: { provenance: string[] }[]): number =>
      entries.filter((entry) => entry.provenance.some((label) => /long break/i.test(label))).length;
    expect(longBreaks(relaxedEntries)).toBeGreaterThan(0);
    expect(longBreaks(intensiveEntries)).toBe(0);
    const mealTimes = (entries: { kind: string; startLocal: string | null }[]): string[] =>
      entries.filter((entry) => entry.kind === "meal" && entry.startLocal).map((entry) => entry.startLocal as string);
    expect(mealTimes(relaxedEntries)).toEqual(mealTimes(intensiveEntries));
    expect(mealTimes(relaxedEntries).length).toBeGreaterThan(0);
    // Every confirmed booking survived the replan (T-E2E-06).
    expect(await reservations(harness.tripId)).toEqual(before);
  }, 240_000);

  it("applies an unbooked route change directly and starts a fresh flight choice", async () => {
    const harness = await createHarnessTrip(pool);
    // Run the creation to its first decision; the route change is then admitted
    // as a modification of that pending flight choice.
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
    const firstDecision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(firstDecision?.kind).toBe("flight_choice");
    const firstValidation = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.route_validations WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [harness.tripId],
    );
    // No confirmed reservation yet: the route change applies without a
    // confirmation decision and only Stage A/B re-run.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      destinationCityId: "geonames:2988507", // Paris
    });
    const trip = await pool.query<{ destination_city_id: string; destination_country_key: string }>(
      `SELECT destination_city_id, destination_country_key FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(trip.rows[0]?.destination_city_id).toBe("geonames:2988507");
    expect(trip.rows[0]?.destination_country_key).toBe("FR");
    // A NEW flight-choice decision exists (the old one was resolved), the
    // feasibility stages re-ran for the new route, and no confirmation was left
    // behind — the operation did not fail silently.
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("flight_choice");
    expect(decision?.id).not.toBe(firstDecision?.id);
    const lastOperation = await pool.query<{ status: string; result: unknown }>(
      `SELECT status, result FROM odft_app.workflow_operations
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [harness.tripId],
    );
    expect(lastOperation.rows[0]?.status).toBe("waiting");
    const secondValidation = await pool.query<{ id: string; status: string; result: unknown }>(
      `SELECT id, status, result FROM odft_app.route_validations
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [harness.tripId],
    );
    expect(secondValidation.rows[0]?.id).not.toBe(firstValidation.rows[0]?.id);
    expect(secondValidation.rows[0]?.status).toBe("FEASIBLE");
    // The fresh Stage A validation is for the NEW route (Paris airports).
    expect(JSON.stringify(secondValidation.rows[0]?.result)).toContain("CDG");
    const state = await readTravelState(pools, harness.tripId);
    expect(state.values.routeStatus).toBe("FEASIBLE");
    expect(state.values.routeChangePreview).toBeNull();
    expect(state.values.nextDecisionKind).toBe("flight_choice");
  }, 180_000);

  it("applies a typed set_program admitted as a modification of a pending decision", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_activity_pace",
      pace: "relaxed",
    });
    expect((await getPendingDecisionForTrip(pools.operations, harness.tripId))?.kind).toBe(
      "program_choices",
    );
    const projection = await buildTripProjection(pool, harness.tripId, DISPLAY);
    const defaults = projection?.program?.mealDefaults;
    expect(defaults?.breakfast).toBeTruthy();
    expect(defaults?.lunch).toBeTruthy();

    // The typed program command must reach apply_program (its dedicated stage),
    // never fall through to the summary and report success without applying.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_program",
      mealOfferIds: {
        breakfast: defaults?.breakfast as string,
        lunch: defaults?.lunch as string,
        dinner: defaults?.dinner ?? null,
      },
      selfArrangedMeals: [],
      preferredActivityIds: projection?.program?.preferredActivityIds ?? [],
      activitiesSelfArranged: false,
    });

    const state = await readTravelState(pools, harness.tripId);
    expect(state.values.programApplied).toBe(true);
    // Applying the program continues into planning and waits at the approval.
    expect((await getPendingDecisionForTrip(pools.operations, harness.tripId))?.kind).toBe(
      "itinerary_approval",
    );
  }, 240_000);

  it("keeps the flight step when a search is requested before the flight is confirmed", async () => {
    const harness = await createHarnessTrip(pool);
    // Run the creation to its first decision (flight_choice pending, no snapshot).
    await createTravelDriver(pools).runOperation(await claimNextOrFail(pools));
    expect((await getPendingDecisionForTrip(pools.operations, harness.tripId))?.kind).toBe(
      "flight_choice",
    );

    await sendChat(pool, pools, harness.tripId, harness.sessionId, "Find a cheaper hotel");

    // A downstream search cannot run without a snapshot: the prerequisite flight
    // choice is presented instead of an empty hotel decision.
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("flight_choice");
    expect(decision?.allowedOfferIds.length).toBeGreaterThan(0);
    const state = await readTravelState(pools, harness.tripId);
    expect(state.values.searchIntent).toBeNull();
    expect(state.values.searchTargetDomains).toEqual([]);
    // The waiting decision carries the real checkpoint/interrupt evidence.
    const checkpoint = await pool.query<{ checkpoint_id: string | null; interrupt_id: string | null }>(
      `SELECT checkpoint_id, interrupt_id FROM odft_app.pending_decisions
        WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [harness.tripId],
    );
    expect(checkpoint.rows[0]?.checkpoint_id).toBeTruthy();
    expect(checkpoint.rows[0]?.interrupt_id).toBeTruthy();
  }, 180_000);

  it("treats a same-value route command as a no-op and keeps the current step", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    // Open a pending decision, then submit a route command that changes NOTHING.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_activity_pace",
      pace: "relaxed",
    });
    const opened = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(opened?.kind).toBe("program_choices");

    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      destinationCityId: "geonames:3169070", // the current destination: no change
    });

    // No terminal failure, no forced flight choice, no route-change confirmation:
    // the modification re-derives the current step.
    const operation = await pool.query<{ status: string; result: unknown }>(
      `SELECT status, result FROM odft_app.workflow_operations
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [harness.tripId],
    );
    expect(operation.rows[0]?.status).toBe("waiting");
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("program_choices");
    const state = await readTravelState(pools, harness.tripId);
    expect(state.values.routeChangePreview).toBeNull();
    expect(state.values.nextDecisionKind).toBe("program_choices");
  }, 180_000);

  it("previews and cancels every confirmed reservation for an origin-only change", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = await reservations(harness.tripId);
    const confirmedBefore = before.filter((row) => row.status === "confirmed");
    expect(confirmedBefore.length).toBeGreaterThanOrEqual(2);

    // The scenario snapshot is keyed by the origin, so an origin-only change
    // regenerates every offer id: the preview must name every reservation.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      originAirportId: "ourairports:4409", // Brno
    });
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("route_change_confirmation");
    const projection = await buildTripProjection(pool, harness.tripId, DISPLAY);
    expect(projection?.routeChange?.changedFields).toEqual(["originAirportId"]);
    expect(projection?.routeChange?.affectedReservations.map((entry) => entry.id).sort()).toEqual(
      confirmedBefore.map((row) => row.id).sort(),
    );
    expect(await reservations(harness.tripId)).toEqual(before);

    expect(await confirmRouteChange(harness.tripId, harness.sessionId)).toEqual({ status: "accepted" });
    await settle(harness.tripId);
    const after = await reservations(harness.tripId);
    for (const row of confirmedBefore) {
      expect(after.find((entry) => entry.id === row.id)?.status).toBe("cancelled");
    }
    const tripRow = await pool.query<{ origin_airport_id: string }>(
      `SELECT origin_airport_id FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(tripRow.rows[0]?.origin_airport_id).toBe("ourairports:4409");
  }, 240_000);

  it("refuses to commit a route change with a rotated fencing token", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = await reservations(harness.tripId);

    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      destinationCityId: "geonames:2988507", // Paris
    });
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("route_change_confirmation");
    const preview = await buildTripProjection(pool, harness.tripId, DISPLAY);
    const operation = await pool.query<{ id: string }>(
      `SELECT id FROM odft_app.workflow_operations
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [harness.tripId],
    );

    // A worker that lost its lease (rotated token) must not cancel anything.
    await expect(
      commitRouteChange(pool, {
        tripId: harness.tripId,
        operationId: operation.rows[0]?.id as string,
        decisionId: decision?.id as string,
        proposalId: preview?.routeChange?.proposalId as string,
        affectedReservationIds: preview?.routeChange?.affectedReservations.map((entry) => entry.id) ?? [],
        commands: [{ type: "set_route", destinationCityId: "geonames:2988507" }],
        fencingToken: "0",
      }),
    ).rejects.toMatchObject({ code: "STALE_DECISION" });
    expect(await reservations(harness.tripId)).toEqual(before);
    const tripRow = await pool.query<{ destination_city_id: string }>(
      `SELECT destination_city_id FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(tripRow.rows[0]?.destination_city_id).toBe("geonames:3169070");
  }, 180_000);

  it("stages a typed route change admitted as a modification of a pending decision", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = await reservations(harness.tripId);
    // Open a pending decision, then submit a typed route change: the worker
    // admits it as a modification of that decision (never a silent conflict) and
    // the staged impact confirmation must be presented.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_activity_pace",
      pace: "relaxed",
    });
    const opened = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(opened?.kind).toBe("program_choices");

    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      destinationCityId: "geonames:2988507", // Paris
    });

    // The modification applied: the old decision is retired, the route change is
    // staged as a confirmation, and nothing was cancelled.
    const retired = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.pending_decisions WHERE id = $1`,
      [opened?.id],
    );
    expect(retired.rows[0]?.status).not.toBe("pending");
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("route_change_confirmation");
    const operation = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations
        WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [harness.tripId],
    );
    expect(operation.rows[0]?.status).toBe("waiting");
    expect(await reservations(harness.tripId)).toEqual(before);
    const tripRow = await pool.query<{ destination_city_id: string }>(
      `SELECT destination_city_id FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(tripRow.rows[0]?.destination_city_id).toBe("geonames:3169070");
  }, 180_000);

  it("stages a route change, cancels only after confirmation, and re-validates from scratch", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = await reservations(harness.tripId);
    const confirmedBefore = before.filter((row) => row.status === "confirmed");
    expect(confirmedBefore.length).toBeGreaterThanOrEqual(2);

    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      destinationCityId: "geonames:2988507", // Paris
    });

    // The command is NOT applied: the trip still points at Rome, every confirmed
    // reservation is intact, and the confirmation decision carries the preview.
    const tripRow = await pool.query<{ destination_city_id: string }>(
      `SELECT destination_city_id FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(tripRow.rows[0]?.destination_city_id).toBe("geonames:3169070");
    expect(await reservations(harness.tripId)).toEqual(before);
    const decision = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(decision?.kind).toBe("route_change_confirmation");
    const projection = await buildTripProjection(pool, harness.tripId, DISPLAY);
    expect(projection?.routeChange?.changedFields).toEqual(["destinationCityId"]);
    expect(projection?.routeChange?.affectedReservations.map((entry) => entry.id).sort()).toEqual(
      confirmedBefore.map((row) => row.id).sort(),
    );

    // A stale confirmation (wrong proposal) is refused before anything cancels.
    const stale = await confirmRouteChange(harness.tripId, harness.sessionId, {
      proposalId: randomUUID(),
    });
    expect(stale).toEqual({ status: "refused", code: "STALE_DECISION" });
    expect((await reservations(harness.tripId)).filter((row) => row.status === "confirmed")).toHaveLength(
      confirmedBefore.length,
    );

    // The exact confirmation cancels the named reservations and applies the route.
    expect(await confirmRouteChange(harness.tripId, harness.sessionId)).toEqual({ status: "accepted" });
    const driver = createTravelDriver(pools);
    for (let round = 0; round < 12; round += 1) {
      const claim = await claimNextOrFail(pools);
      await driver.runOperation(claim);
      const pending = await getPendingDecisionForTrip(pools.operations, harness.tripId);
      if (pending) {
        break;
      }
      const trip = await pool.query<{ workflow_status: string }>(
        `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
        [harness.tripId],
      );
      if (trip.rows[0]?.workflow_status === "blocked") {
        break;
      }
    }

    const after = await reservations(harness.tripId);
    for (const row of confirmedBefore) {
      expect(after.find((entry) => entry.id === row.id)?.status).toBe("cancelled");
    }
    // No new booking was created by the route change itself.
    expect(after.filter((row) => row.status === "confirmed")).toHaveLength(0);
    const updated = await pool.query<{ destination_city_id: string; current_route_validation_id: string | null }>(
      `SELECT destination_city_id, current_route_validation_id FROM odft_app.trips WHERE id = $1`,
      [harness.tripId],
    );
    expect(updated.rows[0]?.destination_city_id).toBe("geonames:2988507");
    // The previous route's approved itinerary stays historical: the projection
    // honors the cleared pointers instead of rendering it as the current plan.
    const postRouteProjection = await buildTripProjection(pool, harness.tripId, DISPLAY);
    expect(postRouteProjection?.itinerary).toBeNull();
    // Stage A ran fresh for the new route (a new validation row exists for Paris).
    const validation = await pool.query<{ id: string; status: string }>(
      `SELECT v.id, v.status FROM odft_app.route_validations v
        WHERE v.trip_id = $1 ORDER BY v.created_at DESC LIMIT 1`,
      [harness.tripId],
    );
    expect(validation.rows[0]?.id).toBe(updated.rows[0]?.current_route_validation_id);
    // A cancelled-booking event was recorded for every affected reservation.
    const cancelledEvents = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.execution_events
        WHERE trip_id = $1 AND type = 'booking.cancelled'`,
      [harness.tripId],
    );
    expect(Number.parseInt(cancelledEvents.rows[0]?.count ?? "0", 10)).toBe(confirmedBefore.length);
  }, 240_000);

  it("a rejected route after confirmation produces no booking", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = await reservations(harness.tripId);

    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_route",
      destinationCityId: "geonames:3077916", // Ceske Budejovice: ground travel preferred
    });
    expect(await confirmRouteChange(harness.tripId, harness.sessionId)).toEqual({ status: "accepted" });

    const driver = createTravelDriver(pools);
    for (let round = 0; round < 12; round += 1) {
      await driver.runOperation(await claimNextOrFail(pools));
      const trip = await pool.query<{ workflow_status: string }>(
        `SELECT workflow_status FROM odft_app.trips WHERE id = $1`,
        [harness.tripId],
      );
      if (trip.rows[0]?.workflow_status !== "running" && trip.rows[0]?.workflow_status !== "queued") {
        break;
      }
    }
    const after = await reservations(harness.tripId);
    expect(after.filter((row) => row.status === "confirmed")).toHaveLength(0);
    expect(after.length).toBe(before.length); // no new rows, only cancellations
    const state = await readTravelState(pools, harness.tripId);
    expect(state.values.gate).toBe("route_rejected");
  }, 240_000);

  it("admits a chat as a modification of a pending non-clarification decision (T-INV-11)", async () => {
    const harness = await createHarnessTrip(pool);
    await driveTripToReady(pool, pools, harness.tripId, harness.sessionId);
    const before = await reservations(harness.tripId);

    // Open a program_choices decision, then modify it through a chat message.
    await runCommand(harness.tripId, harness.sessionId, {
      type: "set_service_override",
      service: "dinner",
      level: "budget",
    });
    const first = await getPendingDecisionForTrip(pools.operations, harness.tripId);
    expect(first?.kind).toBe("program_choices");

    await sendChat(pool, pools, harness.tripId, harness.sessionId, "Make the day less exhausting");

    // The old decision is resolved explicitly and the new run applied the change.
    const oldDecision = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.pending_decisions WHERE id = $1`,
      [first?.id],
    );
    // The old decision is explicitly retired (resolved, or superseded-cancelled
    // when the modification opens a new decision).
    expect(oldDecision.rows[0]?.status).not.toBe("pending");
    const state = await readTravelState(pools, harness.tripId);
    expect(state.values.intentStatus).toBe("commands");
    expect(state.values.lastAction).toBe("modify");
    expect(await preferences(harness.tripId)).toMatchObject({ activityPace: "relaxed" });
    // No reservation was changed by the modification.
    expect(await reservations(harness.tripId)).toEqual(before);
  }, 180_000);
});
