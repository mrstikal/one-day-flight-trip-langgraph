import type { Pool } from "pg";
import {
  routeValidationSchema,
  scheduleValidationSchema,
  snapshotContentSchema,
  tripPreferencesSchema,
  workflowStatusSchema,
  type FlightCombination,
  type OperationStatus,
  type PublicFlightCombination,
  type PublicPendingDecision,
  type PublicProposal,
  type PublicReservation,
  type OperationStatusResponse,
  type TripDisplay,
  type TripProjection,
  type TripSummary,
} from "@odft/contracts";

/**
 * Read projection for a trip (FR-UI-4). Assembled from the durable tables; it is
 * always safe to serve (no secrets, no internal hashes, no provider payloads)
 * and never triggers work. The client renders only what this returns and never
 * recomputes feasibility, prices, or gating.
 */

interface TripRow {
  id: string;
  session_id: string;
  revision: number;
  user_name: string;
  adults: number;
  origin_airport_id: string;
  destination_city_id: string;
  destination_country_key: string;
  sightseeing_date: string;
  travel_variant: TripSummary["travelVariant"];
  preferences: unknown;
  workflow_status: string;
  recovery_required: boolean;
  current_route_validation_id: string | null;
  current_schedule_validation_id: string | null;
  active_scenario_snapshot_id: string | null;
}

/**
 * Door-to-door minutes for one direction: from the first departure to the last
 * arrival, so layover time between segments is included (not just flight time).
 */
function directionMinutes(direction: FlightCombination["outbound"]): number {
  const first = direction.segments[0];
  const last = direction.segments[direction.segments.length - 1];
  if (!first || !last) {
    return 0;
  }
  const minutes = Math.round(
    (Date.parse(last.arrivalInstant) - Date.parse(first.departureInstant)) / 60_000,
  );
  return Math.max(1, minutes);
}

function totalMinutes(flight: FlightCombination): number {
  return directionMinutes(flight.outbound) + directionMinutes(flight.inbound);
}

/** Strip internal hashes/scenario references before the DTO leaves the server. */
function toPublicSegments(segments: FlightCombination["outbound"]["segments"]) {
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    const layoverAfterMinutes = next
      ? Math.max(
          0,
          Math.round(
            (Date.parse(next.departureInstant) - Date.parse(segment.arrivalInstant)) / 60_000,
          ),
        )
      : 0;
    return {
      fromAirportId: segment.fromAirportId,
      toAirportId: segment.toAirportId,
      fromIata: segment.fromIata,
      toIata: segment.toIata,
      departureInstant: segment.departureInstant,
      arrivalInstant: segment.arrivalInstant,
      departureZone: segment.departureZone,
      arrivalZone: segment.arrivalZone,
      elapsedMinutes: segment.elapsedMinutes,
      layoverAfterMinutes,
      airlineName: segment.airlineName,
      airlineCode: segment.airlineCode,
      flightNumber: segment.flightNumber,
    };
  });
}

function toPublicFlight(flight: FlightCombination): PublicFlightCombination {
  return {
    id: flight.id,
    outbound: { direction: "outbound", segments: toPublicSegments(flight.outbound.segments) },
    inbound: { direction: "inbound", segments: toPublicSegments(flight.inbound.segments) },
    adults: flight.adults,
    supportedVariants: flight.supportedVariants,
    perAdultMinor: flight.perAdultMinor,
    partyTotalMinor: flight.partyTotalMinor,
    outboundStops: Math.max(0, flight.outbound.segments.length - 1),
    inboundStops: Math.max(0, flight.inbound.segments.length - 1),
    outboundTravelMinutes: directionMinutes(flight.outbound),
    inboundTravelMinutes: directionMinutes(flight.inbound),
    totalTravelMinutes: totalMinutes(flight),
    demoLabels: flight.demoLabels,
  };
}

export async function buildTripProjection(
  pool: Pool,
  tripId: string,
  display: TripDisplay,
): Promise<TripProjection | undefined> {
  const tripResult = await pool.query<TripRow>(
    `SELECT id, session_id, revision, user_name, adults, origin_airport_id, destination_city_id,
            destination_country_key, sightseeing_date::text AS sightseeing_date, travel_variant,
            preferences, workflow_status, recovery_required, current_route_validation_id,
            current_schedule_validation_id, active_scenario_snapshot_id
       FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  const row = tripResult.rows[0];
  if (!row) {
    return undefined;
  }
  const trip: TripSummary = {
    id: row.id,
    sessionId: row.session_id,
    revision: row.revision,
    userName: row.user_name,
    adults: row.adults,
    originAirportId: row.origin_airport_id,
    destinationCityId: row.destination_city_id,
    destinationCountryKey: row.destination_country_key,
    sightseeingDate: row.sightseeing_date,
    travelVariant: row.travel_variant,
    preferences: tripPreferencesSchema.parse(row.preferences),
    workflowStatus: workflowStatusSchema.parse(row.workflow_status),
    recoveryRequired: row.recovery_required,
  };

  const operationsResult = await pool.query<{
    id: string;
    status: OperationStatus;
    accepted_revision: number;
    attempts: number;
  }>(
    `SELECT id, status, accepted_revision, attempts
       FROM odft_app.workflow_operations WHERE trip_id = $1
      ORDER BY created_at ASC`,
    [tripId],
  );
  const operations: OperationStatusResponse[] = operationsResult.rows.map((operation) => ({
    operationId: operation.id,
    status: operation.status,
    acceptedRevision: operation.accepted_revision,
    attempts: operation.attempts,
  }));

  const decisionResult = await pool.query<{
    id: string;
    kind: PublicPendingDecision["kind"];
    created_revision: number;
    allowed_offer_ids: unknown;
    allowed_option_ids: unknown;
    proposal_id: string | null;
    status: PublicPendingDecision["status"];
    checkpoint_id: string | null;
  }>(
    `SELECT id, kind, created_revision, allowed_offer_ids, allowed_option_ids, proposal_id, status, checkpoint_id
       FROM odft_app.pending_decisions
      WHERE trip_id = $1 AND status = 'pending'
      LIMIT 1`,
    [tripId],
  );
  const decisionRow = decisionResult.rows[0];
  const pendingDecision: PublicPendingDecision | null = decisionRow
    ? {
        id: decisionRow.id,
        kind: decisionRow.kind,
        createdRevision: decisionRow.created_revision,
        allowedOfferIds: Array.isArray(decisionRow.allowed_offer_ids)
          ? (decisionRow.allowed_offer_ids as string[])
          : [],
        allowedOptionIds: Array.isArray(decisionRow.allowed_option_ids)
          ? (decisionRow.allowed_option_ids as string[])
          : [],
        status: decisionRow.status,
        ...(decisionRow.checkpoint_id ? { checkpointId: decisionRow.checkpoint_id } : {}),
        ...(decisionRow.proposal_id ? { proposalId: decisionRow.proposal_id } : {}),
      }
    : null;

  // Route gating (Stage A).
  let routeStatus: TripProjection["flights"]["routeStatus"] = "PENDING";
  let routeReasons: TripProjection["flights"]["routeReasons"] = [];
  let alternatives: TripProjection["flights"]["alternatives"] = [];
  if (row.current_route_validation_id) {
    const routeResult = await pool.query<{ result: unknown }>(
      `SELECT result FROM odft_app.route_validations WHERE id = $1`,
      [row.current_route_validation_id],
    );
    const parsed = routeResult.rows[0]
      ? routeValidationSchema.safeParse(routeResult.rows[0].result)
      : undefined;
    if (parsed?.success) {
      routeStatus = parsed.data.status;
      if (parsed.data.status === "FEASIBLE") {
        routeReasons = parsed.data.warnings;
      } else {
        routeReasons = parsed.data.reasons;
        alternatives = parsed.data.alternatives;
      }
    }
  }

  // Schedule gating (Stage B).
  let scheduleStatus: TripProjection["flights"]["scheduleStatus"] = "PENDING";
  let scheduleReasons: TripProjection["flights"]["scheduleReasons"] = [];
  let scheduleExplanation: string | null = null;
  let validCombinationIds: string[] = [];
  if (row.current_schedule_validation_id) {
    const scheduleResult = await pool.query<{ result: unknown }>(
      `SELECT result FROM odft_app.schedule_validations WHERE id = $1`,
      [row.current_schedule_validation_id],
    );
    const parsed = scheduleResult.rows[0]
      ? scheduleValidationSchema.safeParse(scheduleResult.rows[0].result)
      : undefined;
    if (parsed?.success) {
      scheduleStatus = parsed.data.status;
      validCombinationIds = parsed.data.validCombinationIds;
      scheduleReasons = [...new Set(parsed.data.rejected.flatMap((rejection) => rejection.codes))];
      scheduleExplanation = parsed.data.explanation;
    }
  }

  // Offers: only schedule-valid combinations from the active snapshot.
  let offers: PublicFlightCombination[] = [];
  if (row.active_scenario_snapshot_id && validCombinationIds.length > 0) {
    const snapshotResult = await pool.query<{ inventory: unknown }>(
      `SELECT inventory FROM odft_app.scenario_snapshots WHERE id = $1`,
      [row.active_scenario_snapshot_id],
    );
    const inventory = snapshotResult.rows[0]?.inventory;
    const parsed = inventory ? snapshotContentSchema.safeParse(inventory) : undefined;
    if (parsed?.success) {
      const valid = new Set(validCombinationIds);
      offers = parsed.data.flights
        .filter((flight) => valid.has(flight.id))
        .map(toPublicFlight);
    }
  }

  const proposalResult = await pool.query<{
    id: string;
    service_key: PublicProposal["serviceKey"];
    offer_id: string;
    party_total_minor: number;
    price_delta_minor: number | null;
    status: PublicProposal["status"];
    expires_at: string;
  }>(
    `SELECT id, service_key, offer_id, party_total_minor, price_delta_minor, status, expires_at::text AS expires_at
       FROM odft_app.selection_proposals
      WHERE trip_id = $1 AND status = 'proposed'
      ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const proposalRow = proposalResult.rows[0];
  const proposal: PublicProposal | null = proposalRow
    ? {
        id: proposalRow.id,
        serviceKey: proposalRow.service_key,
        offerId: proposalRow.offer_id,
        partyTotalMinor: proposalRow.party_total_minor,
        priceDeltaMinor: proposalRow.price_delta_minor,
        status: proposalRow.status,
        expiresAt: new Date(proposalRow.expires_at).toISOString(),
        expired: Date.parse(proposalRow.expires_at) <= Date.now(),
      }
    : null;

  const reservationResult = await pool.query<{
    id: string;
    service_key: PublicReservation["serviceKey"];
    offer_id: string;
    status: PublicReservation["status"];
    demo_reference: string;
    party_total_minor: number;
    created_at: string;
  }>(
    `SELECT id, service_key, offer_id, status, demo_reference, party_total_minor, created_at::text AS created_at
       FROM odft_app.reservations
      WHERE trip_id = $1 AND status = 'confirmed'
      ORDER BY created_at DESC LIMIT 1`,
    [tripId],
  );
  const reservationRow = reservationResult.rows[0];
  const reservation: PublicReservation | null = reservationRow
    ? {
        id: reservationRow.id,
        serviceKey: reservationRow.service_key,
        offerId: reservationRow.offer_id,
        status: reservationRow.status,
        demoReference: reservationRow.demo_reference,
        partyTotalMinor: reservationRow.party_total_minor,
        createdAt: new Date(reservationRow.created_at).toISOString(),
      }
    : null;

  return {
    trip,
    operations,
    pendingDecision,
    flights: {
      routeStatus,
      routeReasons,
      alternatives,
      scheduleStatus,
      scheduleReasons,
      scheduleExplanation,
      offers,
      oneNightAvailable: scheduleStatus === "VALID" && trip.travelVariant === "one_night",
    },
    proposal,
    reservation,
    display,
  };
}
