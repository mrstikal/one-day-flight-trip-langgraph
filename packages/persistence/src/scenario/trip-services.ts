import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  SyntheticAccommodationSearchProvider,
  SyntheticAttractionsProvider,
  SyntheticRestaurantSearchProvider,
  SyntheticRoutingProvider,
} from "@odft/data";
import type { ServiceKey, ServiceLevel, TripPreferences } from "@odft/contracts";
import { tripPreferencesSchema } from "@odft/contracts";
import { getTrip } from "../trips.js";
import { loadSnapshotContent, PostgresSnapshotSource } from "./snapshots.js";

/**
 * Deterministic Phase 07 service research, program application, and selected
 * logistics (serial, no LLM). Phase 09 replaces the serial research with a
 * `Send` fan-out while keeping these result shapes.
 */

export type ResearchMeal = "breakfast" | "lunch" | "dinner";

export interface TripResearchResult {
  readonly status: "ok" | "partial";
  readonly hotelOfferIds: string[];
  readonly mealOfferIds: {
    readonly breakfast: string[];
    readonly lunch: string[];
    readonly dinner: string[];
  };
  readonly activityIds: string[];
  readonly mealDefaults: {
    readonly breakfast: string | null;
    readonly lunch: string | null;
    readonly dinner: string | null;
  };
  readonly dinnerNotIncludedReason: string | null;
}

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

/** A selection that cannot be applied; `code` is a safe terminal conflict code. */
export class ServiceSelectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceSelectionError";
    this.code = code;
  }
}

const MEALS: readonly ResearchMeal[] = ["breakfast", "lunch", "dinner"];

function effectiveLevel(preferences: TripPreferences, service: ServiceKey): ServiceLevel {
  return preferences.serviceOverrides[service] ?? preferences.defaultServiceLevel;
}

function nightsForVariant(variant: "one_night" | "two_nights"): number {
  return variant === "one_night" ? 1 : 2;
}

function shiftDate(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return date.toISOString().slice(0, 10);
}

function nightDates(sightseeingDate: string, variant: "one_night" | "two_nights"): string[] {
  const checkIn = shiftDate(sightseeingDate, -1);
  return Array.from({ length: nightsForVariant(variant) }, (_unused, index) =>
    shiftDate(checkIn, index),
  );
}

/** Deterministic default: lowest party total, then lowest id. */
function pickDefault<T extends { id: string; partyTotalMinor: number }>(
  offers: readonly T[],
): string | null {
  if (offers.length === 0) {
    return null;
  }
  const sorted = [...offers].sort(
    (a, b) => a.partyTotalMinor - b.partyTotalMinor || a.id.localeCompare(b.id),
  );
  return sorted[0]?.id ?? null;
}

function contentFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function localParts(
  instant: string,
  zone: string,
): { date: string; hour: number; clock: string } | null {
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
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    const hour = Number.parseInt(get("hour"), 10);
    if (date.length !== 10 || !Number.isFinite(hour)) {
      return null;
    }
    const clock = `${String(hour).padStart(2, "0")}:${get("minute")}`;
    return { date, hour, clock };
  } catch {
    return null;
  }
}

/**
 * Deterministic dinner-slot assessment. Dinner is unavailable when the return
 * leg leaves the destination before the dinner window opens on the sightseeing
 * day (a return on a later day leaves the evening free). With no confirmed
 * flight the check is not binding and dinner is treated as available.
 */
export async function dinnerSlotAvailable(
  client: Pick<PoolClient, "query">,
  tripId: string,
  content: NonNullable<Awaited<ReturnType<typeof loadSnapshotContent>>>,
): Promise<{ available: boolean; reason: string | null }> {
  const reservation = await client.query<{ offer_id: string }>(
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
  const parts = localParts(
    firstReturnSegment.departureInstant,
    firstReturnSegment.departureZone || content.context.cityZone,
  );
  if (!parts) {
    return { available: true, reason: null };
  }
  const leavesLaterDay = parts.date > content.context.sightseeingDate;
  if (!leavesLaterDay && parts.hour < 18) {
    return {
      available: false,
      reason: `Not included - your return flight leaves at ${String(parts.hour).padStart(2, "0")}:00 local time, before the dinner window.`,
    };
  }
  return { available: true, reason: null };
}

async function recordRecommendation(
  client: Pick<PoolClient, "query">,
  input: {
    readonly tripId: string;
    readonly serviceKey: string;
    readonly snapshotId: string;
    readonly rankedOfferIds: readonly string[];
  },
): Promise<void> {
  await client.query(
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
      "Deterministic serial research (Phase 07).",
    ],
  );
}

export async function researchTripServices(
  pool: Pool,
  tripId: string,
): Promise<TripResearchResult> {
  const client = await pool.connect();
  try {
    const trip = await getTrip(client, tripId);
    if (!trip) {
      throw new ServiceSelectionError("NOT_FOUND", `trip ${tripId} not found`);
    }
    const snapshotId = trip.activeScenarioSnapshotId;
    if (!snapshotId) {
      throw new ServiceSelectionError("CONFLICT", "trip has no active scenario snapshot");
    }
    const content = await loadSnapshotContent(client, snapshotId);
    if (!content) {
      throw new ServiceSelectionError("CONFLICT", `snapshot ${snapshotId} is not materialized`);
    }
    const source = new PostgresSnapshotSource(pool);
    const accommodation = new SyntheticAccommodationSearchProvider(source);
    const restaurant = new SyntheticRestaurantSearchProvider(source);
    const attractions = new SyntheticAttractionsProvider(source);

    let partial = false;
    const hotelResult = await accommodation.search({
      snapshotId,
      level: effectiveLevel(trip.preferences, "hotel"),
      adults: trip.adults,
      dates: nightDates(trip.sightseeingDate, trip.travelVariant),
    });
    const hotelOffers = hotelResult.status === "ok" ? hotelResult.value : [];
    if (hotelResult.status !== "ok") {
      partial = true;
    }

    const mealOfferIds: Record<ResearchMeal, string[]> = { breakfast: [], lunch: [], dinner: [] };
    const mealDefaults: Record<ResearchMeal, string | null> = {
      breakfast: null,
      lunch: null,
      dinner: null,
    };
    for (const meal of MEALS) {
      const result = await restaurant.search({
        snapshotId,
        meal,
        level: effectiveLevel(trip.preferences, meal),
        adults: trip.adults,
      });
      const offers = result.status === "ok" ? result.value : [];
      if (result.status !== "ok") {
        partial = true;
      }
      mealOfferIds[meal] = offers.map((offer) => offer.id);
      mealDefaults[meal] = pickDefault(offers);
      await recordRecommendation(client, {
        tripId,
        serviceKey: meal,
        snapshotId,
        rankedOfferIds: mealOfferIds[meal],
      });
    }

    const attractionResult = await attractions.list({ snapshotId, cityId: trip.destinationCityId });
    const activities = attractionResult.status === "ok" ? attractionResult.value : [];
    if (attractionResult.status !== "ok") {
      partial = true;
    }

    await recordRecommendation(client, {
      tripId,
      serviceKey: "hotel",
      snapshotId,
      rankedOfferIds: hotelOffers.map((offer) => offer.id),
    });
    await recordRecommendation(client, {
      tripId,
      serviceKey: "activities",
      snapshotId,
      rankedOfferIds: activities.map((activity) => activity.id),
    });

    let dinnerNotIncludedReason: string | null = null;
    if (mealOfferIds.dinner.length === 0) {
      mealDefaults.dinner = null;
      dinnerNotIncludedReason = "Not included - no dinner offers are available for this trip.";
    } else {
      const slot = await dinnerSlotAvailable(client, tripId, content);
      if (!slot.available) {
        mealDefaults.dinner = null;
        dinnerNotIncludedReason = slot.reason;
      }
    }

    return {
      status: partial ? "partial" : "ok",
      hotelOfferIds: hotelOffers.map((offer) => offer.id),
      mealOfferIds,
      activityIds: activities.map((activity) => activity.id),
      mealDefaults,
      dinnerNotIncludedReason,
    };
  } finally {
    client.release();
  }
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
    const services: readonly ("breakfast" | "lunch" | "dinner")[] = [
      "breakfast",
      "lunch",
      "dinner",
    ];
    for (const service of services) {
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
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO odft_app.recommendation_artifacts
         (id, trip_id, service_key, input_fingerprint, snapshot_refs, ranked_offers, explanation)
       VALUES ($1, $2, 'activities', $3, '[]'::jsonb, $4::jsonb, $5)`,
      [
        randomUUID(),
        input.tripId,
        contentFingerprint({ preferred: [...input.preferredActivityIds].sort() }),
        JSON.stringify(input.preferredActivityIds),
        "User program activity preferences (Phase 07).",
      ],
    );
  } finally {
    client.release();
  }
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
 * must be within the policy bound. It never edits a reservation.
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
      ? localParts(
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
        if (windowEnd !== null && windowEnd > returnDeparture.clock) {
          return {
            status: "conflict",
            reason: `The confirmed ${meal.service_key} window ends at ${mealOffer.windowEnd}, after your return flight leaves at ${returnDeparture.clock}.`,
          };
        }
      }
    }

    return { status: "valid", reason: null };
  } finally {
    client.release();
  }
}

function parseClock(value: string): string | null {
  return /^\d{2}:\d{2}$/.test(value) ? value : null;
}

async function loadAirportAnchor(
  client: Pick<PoolClient, "query">,
  airportId: string,
): Promise<{ lat: number; lon: number } | undefined> {
  const result = await client.query<{ lat: number; lon: number }>(
    `SELECT lat, lon FROM odft_app.reference_airports WHERE id = $1`,
    [airportId],
  );
  const row = result.rows[0];
  return row ? { lat: row.lat, lon: row.lon } : undefined;
}
