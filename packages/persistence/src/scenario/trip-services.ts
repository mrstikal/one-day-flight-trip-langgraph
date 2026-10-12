import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SyntheticRoutingProvider } from "@odft/data";
import type { BookableKey, ServiceKey } from "@odft/contracts";
import { tripPreferencesSchema } from "@odft/contracts";
import { getTrip } from "../trips.js";
import { loadSnapshotContent } from "./snapshots.js";

/**
 * Deterministic Phase 07 program application and selected logistics (serial, no
 * LLM). Phase 09 replaced the serial service research with a `Send` fan-out in
 * `research-domains.ts`; the program and logistics shapes are unchanged.
 *
 * Pool safety: this module never holds a connection across a provider call.
 * Providers acquire their own short-lived connections, so one operation needs at
 * most the `runEffect` connection plus one pooled connection at a time. Holding a
 * connection while calling providers could exhaust the worker pool under
 * concurrency.
 */

/** Minimal query surface shared by `Pool` and `PoolClient`. */
type Queryable = { query: PoolClient["query"] };

export type ResearchMeal = "breakfast" | "lunch" | "dinner";

export interface ProgramSelection {
  readonly serviceKey: ServiceKey;
  readonly offerId: string;
  readonly snapshotId: string;
  readonly sourceFingerprint: string;
}

export interface ProgramPlan {
  readonly selections: ProgramSelection[];
  readonly replacements: { readonly serviceKey: ServiceKey; readonly offerId: string }[];
  readonly dinnerExcluded: boolean;
}

export interface TripLogisticsResult {
  readonly status: "valid" | "conflict";
  readonly reason: string | null;
}

export interface TripProgress {
  readonly flightConfirmed: boolean;
  readonly hotelConfirmed: boolean;
  /** Phase 11: every service with an active confirmed reservation. */
  readonly confirmedServices: readonly BookableKey[];
  /** Phase 11: every service with an active (unbooked) selection. */
  readonly selectedServices: readonly BookableKey[];
  /** Phase 11: true when the meal/activity program has been applied. */
  readonly programApplied: boolean;
}

/** A selection that cannot be applied; `code` is a safe terminal conflict code. */
export class ServiceSelectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceSelectionError";
    this.code = code;
  }
}

const MEAL_SERVICES: readonly ("breakfast" | "lunch" | "dinner")[] = [
  "breakfast",
  "lunch",
  "dinner",
];

function contentFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Parse an `HH:MM` clock, tolerating decorated values like `22:00 (simulated)`. */
export function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

/** Minutes the destination-local wall clock reads for an instant, or null. */
function localMinutes(instant: string, zone: string): { date: string; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(instant));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    const hour = Number.parseInt(get("hour"), 10);
    const minute = Number.parseInt(get("minute"), 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

/** Airport buffer required after the last planned activity before departure. */
const AIRPORT_BUFFER_MINUTES = 120;

/**
 * Deterministic dinner-slot assessment. Dinner is infeasible when the return leg
 * leaves the destination the same day before the dinner window plus the meal
 * duration and the airport buffer have elapsed. A return on a later day leaves
 * the evening free; with no confirmed flight the check is not binding.
 */
export async function dinnerSlotAvailable(
  queryable: Queryable,
  tripId: string,
  content: NonNullable<Awaited<ReturnType<typeof loadSnapshotContent>>>,
): Promise<{ available: boolean; reason: string | null }> {
  const dinnerOffers = content.restaurants.filter((offer) => offer.meal === "dinner");
  if (dinnerOffers.length === 0) {
    return {
      available: false,
      reason: "Not included - no dinner offers are available for this trip.",
    };
  }
  const reservation = await queryable.query<{ offer_id: string }>(
    `SELECT offer_id FROM odft_app.reservations
      WHERE trip_id = $1 AND service_key = 'flights' AND status = 'confirmed'`,
    [tripId],
  );
  const offerId = reservation.rows[0]?.offer_id;
  if (!offerId) {
    return { available: true, reason: null };
  }
  const flight = content.flights.find((combination) => combination.id === offerId);
  const firstReturnSegment = flight?.inbound.segments[0];
  if (!firstReturnSegment) {
    return { available: true, reason: null };
  }
  const departure = localMinutes(
    firstReturnSegment.departureInstant,
    firstReturnSegment.departureZone || content.context.cityZone,
  );
  if (!departure) {
    return { available: true, reason: null };
  }
  if (departure.date > content.context.sightseeingDate) {
    return { available: true, reason: null };
  }
  const feasible = dinnerOffers.some((offer) => {
    const start = parseClock(offer.windowStart);
    return (
      start !== null && departure.minutes >= start + offer.durationMinutes + AIRPORT_BUFFER_MINUTES
    );
  });
  if (feasible) {
    return { available: true, reason: null };
  }
  const minutes = Math.floor(departure.minutes);
  const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return {
    available: false,
    reason: `Not included - your return flight leaves at ${clock} local time, too early to finish dinner and reach the airport.`,
  };
}

async function recordRecommendation(
  queryable: Queryable,
  input: {
    readonly tripId: string;
    readonly serviceKey: string;
    readonly snapshotId: string;
    readonly rankedOfferIds: readonly string[];
    readonly explanation?: string | null;
  },
): Promise<void> {
  await queryable.query(
    `INSERT INTO odft_app.recommendation_artifacts
       (id, trip_id, service_key, input_fingerprint, snapshot_refs, ranked_offers, explanation)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      randomUUID(),
      input.tripId,
      input.serviceKey,
      contentFingerprint({ service: input.serviceKey, snapshotId: input.snapshotId }),
      JSON.stringify([input.snapshotId]),
      JSON.stringify(input.rankedOfferIds),
      input.explanation ?? "Deterministic serial research (Phase 07).",
    ],
  );
}

/** Confirmed flight/hotel progress used to resume a preference change at the right step. */
export async function loadTripProgress(pool: Pool, tripId: string): Promise<TripProgress> {
  const [reservations, selections, program] = await Promise.all([
    pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    ),
    pool.query<{ service_key: string }>(
      `SELECT service_key FROM odft_app.trip_selections WHERE trip_id = $1`,
      [tripId],
    ),
    pool.query<{ applied: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM odft_app.trip_selections
          WHERE trip_id = $1 AND service_key IN ('breakfast','lunch')
       ) AS applied`,
      [tripId],
    ),
  ]);
  const confirmedServices = reservations.rows.map((row) => row.service_key as BookableKey);
  const services = new Set(confirmedServices);
  return {
    flightConfirmed: services.has("flights"),
    hotelConfirmed: services.has("hotel"),
    confirmedServices,
    selectedServices: selections.rows.map((row) => row.service_key as BookableKey),
    programApplied: program.rows[0]?.applied ?? false,
  };
}

/** Latest persisted program activity preferences (may be empty). */
export async function loadPreferredActivityIds(client: Queryable, tripId: string): Promise<string[]> {
  const result = await client.query<{ ranked_offers: unknown }>(
    `SELECT ranked_offers FROM odft_app.recommendation_artifacts
      WHERE trip_id = $1 AND service_key = 'activities' AND explanation LIKE 'User program%'
      ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const raw = result.rows[0]?.ranked_offers;
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

/**
 * Validate a `submit_program` selection without writing anything. Compatible
 * unbooked meals become selections; a confirmed meal with a different offer is a
 * replacement (never moved or removed). A null dinner is accepted only with the
 * deterministic no-slot result.
 */
export async function planProgramSelections(
  pool: Pool,
  input: {
    readonly tripId: string;
    readonly mealSelections: { breakfast: string; lunch: string; dinner: string | null };
  },
): Promise<ProgramPlan> {
  const client = await pool.connect();
  try {
    const trip = await getTrip(client, input.tripId);
    if (!trip) {
      throw new ServiceSelectionError("NOT_FOUND", `trip ${input.tripId} not found`);
    }
    const snapshotId = trip.activeScenarioSnapshotId;
    if (!snapshotId) {
      throw new ServiceSelectionError("CONFLICT", "trip has no active scenario snapshot");
    }
    const content = await loadSnapshotContent(client, snapshotId);
    if (!content) {
      throw new ServiceSelectionError("CONFLICT", `snapshot ${snapshotId} is not materialized`);
    }
    tripPreferencesSchema.parse(trip.preferences);

    const confirmed = await client.query<{ service_key: ServiceKey; offer_id: string }>(
      `SELECT service_key, offer_id FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed' AND service_key IN ('breakfast','lunch','dinner')`,
      [input.tripId],
    );
    const confirmedByService = new Map<ServiceKey, string>(
      confirmed.rows.map((row) => [row.service_key, row.offer_id]),
    );

    if (input.mealSelections.dinner === null) {
      if (confirmedByService.has("dinner")) {
        throw new ServiceSelectionError(
          "CONFLICT",
          "a confirmed dinner reservation cannot be removed",
        );
      }
      const slot = await dinnerSlotAvailable(client, input.tripId, content);
      if (slot.available) {
        throw new ServiceSelectionError(
          "CONFLICT",
          "dinner can be excluded only when no feasible dinner slot exists",
        );
      }
    }

    const selections: ProgramSelection[] = [];
    const replacements: ProgramPlan["replacements"] = [];
    for (const service of MEAL_SERVICES) {
      const selected = input.mealSelections[service];
      if (selected === null) {
        continue;
      }
      const offer = content.restaurants.find(
        (candidate) => candidate.id === selected && candidate.meal === service,
      );
      if (!offer) {
        throw new ServiceSelectionError(
          "OFFER_UNAVAILABLE",
          `offer ${selected} is not a ${service} option in the active snapshot`,
        );
      }
      const active = confirmedByService.get(service);
      if (active === selected) {
        continue;
      }
      if (active !== undefined) {
        replacements.push({ serviceKey: service, offerId: selected });
        continue;
      }
      selections.push({
        serviceKey: service,
        offerId: selected,
        snapshotId,
        sourceFingerprint: contentFingerprint({
          tripId: input.tripId,
          service,
          offerId: selected,
          snapshotId,
        }),
      });
    }

    return { selections, replacements, dinnerExcluded: input.mealSelections.dinner === null };
  } finally {
    client.release();
  }
}

/**
 * Record the user's preferred program activities as a preference artifact. They
 * are never booked; this keeps the choices instead of silently discarding them.
 */
export async function recordPreferredActivities(
  pool: Pool,
  input: { readonly tripId: string; readonly preferredActivityIds: readonly string[] },
): Promise<void> {
  if (input.preferredActivityIds.length === 0) {
    return;
  }
  await recordRecommendation(pool, {
    tripId: input.tripId,
    serviceKey: "activities",
    snapshotId: "preferred",
    rankedOfferIds: input.preferredActivityIds,
    explanation: "User program activity preferences (Phase 07).",
  });
}

/** Persist compatible unbooked selections (idempotent upsert). */
export async function upsertProgramSelections(
  pool: Pool,
  tripId: string,
  selections: readonly ProgramSelection[],
): Promise<void> {
  if (selections.length === 0) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const selection of selections) {
      await client.query(
        `INSERT INTO odft_app.trip_selections
           (id, trip_id, service_key, offer_id, snapshot_id, selected_by, source_fingerprint, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'user', $5, now())
         ON CONFLICT (trip_id, service_key) DO UPDATE SET
           offer_id = EXCLUDED.offer_id, snapshot_id = EXCLUDED.snapshot_id,
           selected_by = EXCLUDED.selected_by, source_fingerprint = EXCLUDED.source_fingerprint,
           updated_at = now()`,
        [
          tripId,
          selection.serviceKey,
          selection.offerId,
          selection.snapshotId,
          selection.sourceFingerprint,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Deterministic selected-logistics check: the confirmed hotel's airport transfer
 * must be within the policy bound and confirmed meal windows must not run past
 * the return departure. It never edits a reservation.
 */
export async function validateTripLogistics(
  pool: Pool,
  tripId: string,
): Promise<TripLogisticsResult> {
  const client = await pool.connect();
  try {
    const trip = await getTrip(client, tripId);
    if (!trip) {
      throw new ServiceSelectionError("NOT_FOUND", `trip ${tripId} not found`);
    }
    const snapshotId = trip.activeScenarioSnapshotId;
    if (!snapshotId) {
      return { status: "valid", reason: null };
    }
    const content = await loadSnapshotContent(client, snapshotId);
    if (!content) {
      return { status: "valid", reason: null };
    }

    const flightReservation = await client.query<{ offer_id: string }>(
      `SELECT offer_id FROM odft_app.reservations
        WHERE trip_id = $1 AND service_key = 'flights' AND status = 'confirmed'`,
      [tripId],
    );
    const flightOfferId = flightReservation.rows[0]?.offer_id;
    const flight = flightOfferId
      ? content.flights.find((candidate) => candidate.id === flightOfferId)
      : undefined;
    const outboundLast = flight?.outbound.segments[flight.outbound.segments.length - 1];
    const destinationAirportId = outboundLast?.toAirportId ?? null;

    const hotel = await client.query<{ offer_id: string }>(
      `SELECT offer_id FROM odft_app.reservations
        WHERE trip_id = $1 AND service_key = 'hotel' AND status = 'confirmed'`,
      [tripId],
    );
    const hotelOfferId = hotel.rows[0]?.offer_id;
    const offer = hotelOfferId
      ? content.hotels.find((candidate) => candidate.id === hotelOfferId)
      : undefined;
    if (offer) {
      const airportAnchor = destinationAirportId
        ? await loadAirportAnchor(client, destinationAirportId)
        : undefined;
      const start = airportAnchor ?? content.context.center;
      const estimate = new SyntheticRoutingProvider().estimate({
        startRef: destinationAirportId ?? content.context.destinationCityId,
        endRef: offer.id,
        mode: "airport_transfer",
        adults: trip.adults,
        start,
        end: offer.anchor,
        ruleVersion: "phase07",
      });
      if (estimate.estimatedMinutes > 120) {
        const origin = airportAnchor ? "the airport" : "the city centre";
        return {
          status: "conflict",
          reason: `The selected hotel is ${estimate.estimatedMinutes} minutes from ${origin}, beyond the 120-minute transfer limit.`,
        };
      }
    }

    // Confirmed meal windows must not run past the return departure on the day.
    const returnFirst = flight?.inbound.segments[0];
    const returnDeparture = returnFirst
      ? localMinutes(
          returnFirst.departureInstant,
          returnFirst.departureZone || content.context.cityZone,
        )
      : null;
    const meals = await client.query<{ service_key: string; offer_id: string }>(
      `SELECT service_key, offer_id FROM odft_app.reservations
        WHERE trip_id = $1 AND status = 'confirmed'
          AND service_key IN ('breakfast','lunch','dinner')`,
      [tripId],
    );
    if (returnDeparture && returnDeparture.date === content.context.sightseeingDate) {
      for (const meal of meals.rows) {
        const mealOffer = content.restaurants.find((candidate) => candidate.id === meal.offer_id);
        if (!mealOffer) {
          continue;
        }
        const windowEnd = parseClock(mealOffer.windowEnd);
        if (windowEnd !== null && windowEnd > returnDeparture.minutes) {
          return {
            status: "conflict",
            reason: `The confirmed ${meal.service_key} window ends at ${mealOffer.windowEnd}, after your return flight leaves.`,
          };
        }
      }
    }

    return { status: "valid", reason: null };
  } finally {
    client.release();
  }
}

export async function loadAirportAnchor(
  client: Queryable,
  airportId: string,
): Promise<{ lat: number; lon: number } | undefined> {
  const result = await client.query<{ lat: number; lon: number }>(
    `SELECT lat, lon FROM odft_app.reference_airports WHERE id = $1`,
    [airportId],
  );
  const row = result.rows[0];
  return row ? { lat: row.lat, lon: row.lon } : undefined;
}
