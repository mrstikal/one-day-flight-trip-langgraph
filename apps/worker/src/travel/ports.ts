import type { Pool } from "pg";
import {
  BookingService,
  assembleItinerary,
  buildItineraryConflictDecision,
  computeItinerarySourceFingerprint,
  fingerprint,
  localMinuteOfInstant,
  simulatedOpeningWindow,
  validateItinerary,
  type ItinerarySourceFingerprintInput,
} from "@odft/domain";
import { SyntheticRoutingProvider } from "@odft/data";
import {
  approveItineraryDraft,
  applyTripCommands,
  evaluateAndPersistRoute,
  getActiveReservation,
  getOperationPayload,
  getTrip,
  ItineraryPersistenceError,
  loadItineraryPlanningData,
  loadLatestItinerary,
  loadOverlay,
  loadTripProgress,
  loadTripResearchInputs,
  materializeFlightSnapshot,
  parseClock,
  persistItineraryDraft,
  planProgramSelections,
  PostgresBookingStore,
  rankTripRecommendations,
  recordFaultOutcome,
  recordPreferredActivities,
  researchTripDomain,
  saveItineraryReview,
  ScenarioService,
  upsertProgramSelections,
  validateAndPersistSchedules,
  validateTripLogistics,
  type ItineraryPlanningData,
  type OperationFencingContext,
} from "@odft/persistence";
import {
  chatCommandPayloadSchema,
  type ItineraryIssue,
  type ItineraryReview,
  type Meal,
} from "@odft/contracts";
import {
  plannerContextSchema,
  reviewerContextSchema,
  type PlannerContext,
  type PlannerOutput,
  type ReviewerContext,
} from "@odft/ai";
import type { TravelPorts } from "@odft/workflow";
import { createFencedEventWriter, createFencedRunEffect } from "../driver.js";
import type { AiService } from "../ai/service.js";

/**
 * Build the production travel-graph ports for one claimed operation. All access
 * to reference data, scenario generation, the two feasibility stages, the Phase
 * 09 per-domain research/ranking services, the Phase 08 intent runtime, and the
 * booking service is wired here so the graph nodes stay orchestration-only.
 */

const RESEARCH_MATERIALIZED_DOMAINS = [
  "hotels",
  "breakfast",
  "lunch",
  "dinner",
  "activities",
  "events",
] as const;

const ITINERARY_ROUTING_RULE_VERSION = "phase10";
const ITINERARY_ROUTING = new SyntheticRoutingProvider();

/* ---- Phase 10 itinerary helpers ---------------------------------------------- */

function mealWindowMinutes(offer: { windowStart: string; windowEnd: string }): {
  start: number;
  end: number;
} {
  const start = parseClock(offer.windowStart) ?? 8 * 60;
  const end = parseClock(offer.windowEnd) ?? 22 * 60;
  return { start, end: Math.max(start + 15, end) };
}

function selectedMealOffers(data: ItineraryPlanningData): AssemblyMealCandidate[] {
  const services: Meal[] = ["breakfast", "lunch", "dinner"];
  const candidates: AssemblyMealCandidate[] = [];
  for (const service of services) {
    const offerId = data.confirmedMeals[service] ?? data.selectedMeals[service];
    if (!offerId) {
      continue;
    }
    const offer = data.content.restaurants.find(
      (restaurant) => restaurant.id === offerId && restaurant.meal === service,
    );
    if (!offer) {
      continue;
    }
    const window = mealWindowMinutes(offer);
    candidates.push({
      id: offer.id,
      name: offer.name,
      meal: offer.meal,
      level: offer.level,
      durationMinutes: offer.durationMinutes,
      partyTotalMinor: offer.partyTotalMinor,
      windowStartMinute: window.start,
      windowEndMinute: window.end,
      anchor: offer.anchor,
      provenance: [`${offer.name} (${offer.level})`],
    });
  }
  return candidates;
}

function activityCandidates(data: ItineraryPlanningData): AssemblyActivityCandidate[] {
  const preferred = new Set(data.preferredActivityIds);
  return [...data.content.activities]
    .sort((a, b) => {
      const preferredDelta = (preferred.has(b.id) ? 1 : 0) - (preferred.has(a.id) ? 1 : 0);
      if (preferredDelta !== 0) {
        return preferredDelta;
      }
      const referenceDelta = (b.reference ? 1 : 0) - (a.reference ? 1 : 0);
      return referenceDelta !== 0 ? referenceDelta : a.id.localeCompare(b.id);
    })
    .map((activity) => ({
      id: activity.id,
      name: activity.name,
      tags: activity.tags,
      durationMinutes: activity.durationMinutes,
      ticketMinorPerAdult: activity.ticketMinorPerAdult,
      anchor: activity.anchor,
      reference: activity.reference,
      provenance: [activity.reference ? "Reference landmark data" : "Demo activity template"],
    }));
}

function returnDepartureInstant(data: ItineraryPlanningData): string | null {
  const flight = data.confirmedFlightOfferId
    ? data.content.flights.find((combination) => combination.id === data.confirmedFlightOfferId)
    : undefined;
  return flight?.inbound.segments[0]?.departureInstant ?? null;
}

/** Bounded, deterministic planner context (03-langgraph-design.md section 3). */
function buildPlannerContext(
  data: ItineraryPlanningData,
  feedback: readonly string[],
  departureMinuteRaw: number,
): PlannerContext {
  const meals = selectedMealOffers(data);
  const activities = activityCandidates(data).slice(0, Math.max(0, 57 - meals.length));
  // The return window constrains the sightseeing day only when the return flies
  // on that same day; a two-nights return has no day-D window.
  const sameDayReturn = departureMinuteRaw < 1440;
  return plannerContextSchema.parse({
    role: "planner",
    sightseeingDate: data.trip.sightseeingDate,
    destinationCityId: data.trip.destinationCityId,
    pace: data.trip.preferences.activityPace,
    interests: data.trip.preferences.interests,
    minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
    budgetMinor: data.trip.preferences.maxBudgetMinor ?? null,
    fixedWindows: [
      ...meals.map((meal) => ({
        kind: "meal" as const,
        refId: meal.id,
        startMinute: meal.windowStartMinute,
        endMinute: meal.windowEndMinute,
      })),
      ...(sameDayReturn
        ? [
            {
              kind: "airport" as const,
              refId: "return_flight",
              startMinute: Math.min(1439, departureMinuteRaw),
              endMinute: Math.min(1439, departureMinuteRaw),
            },
          ]
        : []),
    ].slice(0, 24),
    candidates: [
      ...meals.map((meal) => ({
        id: meal.id,
        kind: "meal" as const,
        meal: meal.meal,
        tags: [],
        durationMinutes: Math.min(180, meal.durationMinutes),
        openingStartMinute: meal.windowStartMinute,
        openingEndMinute: Math.min(1439, meal.windowEndMinute),
      })),
      ...activities.map((activity) => {
        const window = simulatedOpeningWindow(activity.tags);
        return {
          id: activity.id,
          kind: "activity" as const,
          tags: [...activity.tags],
          durationMinutes: Math.min(180, Math.max(5, activity.durationMinutes)),
          openingStartMinute: window.startMinute,
          openingEndMinute: Math.min(1439, window.endMinute),
        };
      }),
    ].slice(0, 60),
    validationFeedback: feedback.slice(0, 10),
  });
}

function buildReviewerContext(
  data: ItineraryPlanningData,
  record: { events: readonly { id: string; kind: string; startMinute: number; durationMinutes: number }[]; validation: { metrics: { walkingMinutes: number; transferMinutes: number; activityCount: number; museumCount: number } } },
): ReviewerContext {
  const requirements = Object.entries(data.trip.preferences.minimumActivityCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([tag, minimumCount]) => ({ tag: tag as never, minimumCount }))
    .filter((requirement) => requirement.minimumCount >= 1 && requirement.minimumCount <= 7)
    .slice(0, 8);
  return reviewerContextSchema.parse({
    role: "reviewer",
    events: record.events.slice(0, 24).map((event) => ({
      id: event.id,
      kind: event.kind,
      startMinute: Math.min(1439, event.startMinute),
      durationMinutes: event.durationMinutes,
    })),
    metrics: {
      totalWalkingMinutes: record.validation.metrics.walkingMinutes,
      totalTransferMinutes: record.validation.metrics.transferMinutes,
      activityCount: record.validation.metrics.activityCount,
      museumCount: record.validation.metrics.museumCount,
    },
    preferences: data.trip.preferences,
    requirements,
  });
}

/** The persisted inputs whose change invalidates an approval. */
function itinerarySource(data: ItineraryPlanningData): ItinerarySourceFingerprintInput {
  return {
    snapshotId: data.snapshotId,
    sightseeingDate: data.trip.sightseeingDate,
    travelVariant: data.trip.travelVariant,
    adults: data.trip.adults,
    destinationCityId: data.trip.destinationCityId,
    pace: data.trip.preferences.activityPace,
    minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
    budgetMinor: data.trip.preferences.maxBudgetMinor ?? null,
    mealSelectionIds: {
      breakfast: data.confirmedMeals.breakfast ?? data.selectedMeals.breakfast,
      lunch: data.confirmedMeals.lunch ?? data.selectedMeals.lunch,
      dinner: data.confirmedMeals.dinner ?? data.selectedMeals.dinner,
    },
    confirmedMealIds: data.confirmedMealIds,
    confirmedFlightOfferId: data.confirmedFlightOfferId,
    confirmedHotelOfferId: data.confirmedHotelOfferId,
  };
}

/** Scenario E: inject exactly one labeled overlap after schema parsing. */
function injectFirstAttemptOverlap(output: PlannerOutput): PlannerOutput {
  const content = output.stops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => stop.kind === "meal" || stop.kind === "activity" || stop.kind === "free_time");
  if (content.length < 2) {
    return output;
  }
  const first = content[0];
  const second = content[1];
  if (!first || !second) {
    return output;
  }
  return {
    ...output,
    stops: output.stops.map((stop, index) =>
      index === second.index ? { ...stop, startMinute: first.stop.startMinute } : stop,
    ),
  };
}

const INVALID_PROPOSAL_LABEL =
  "The planner proposal was rejected before feasibility validation; no draft was persisted.";

type AssemblyMealCandidate = Parameters<typeof assembleItinerary>[0]["meals"][number];
type AssemblyActivityCandidate = Parameters<typeof assembleItinerary>[0]["activities"][number];

/**
 * The fencing context for a domain write. It refuses a write that targets a
 * different operation/trip than the claimed one, so a stale or misrouted task
 * can never borrow the current worker's token.
 */
function fenceFor(
  ctx: OperationFencingContext,
  operationId: string,
  tripId: string,
): OperationFencingContext {
  if (operationId !== ctx.operationId || tripId !== ctx.tripId) {
    throw new Error("research write targets a different operation than the claimed one");
  }
  return { operationId: ctx.operationId, tripId: ctx.tripId, fencingToken: ctx.fencingToken };
}

export function createTravelPortsFactory(
  pool: Pool,
  ai: AiService,
): (ctx: OperationFencingContext, signal?: AbortSignal) => TravelPorts {
  const booking = new BookingService(new PostgresBookingStore(pool));
  const scenarios = new ScenarioService(pool);
  const insertFencedEvent = createFencedEventWriter(pool);
  return (ctx: OperationFencingContext, signal?: AbortSignal): TravelPorts => ({
    now: () => new Date(),
    runEffect: createFencedRunEffect(pool, ctx),

    async loadTrip(tripId: string) {
      const trip = await getTrip(pool, tripId);
      return trip ? { trip } : undefined;
    },

    async applyCommands(input) {
      return applyTripCommands(pool, { tripId: input.tripId, commands: input.commands });
    },

    async evaluateRoute(tripId) {
      const evaluated = await evaluateAndPersistRoute(pool, tripId);
      if (!evaluated) {
        throw new Error(`cannot evaluate route for trip ${tripId}: missing reference inputs`);
      }
      return evaluated.result;
    },

    async materializeFlights(tripId) {
      const materialized = await materializeFlightSnapshot(pool, tripId);
      return materialized
        ? { scenarioKey: materialized.scenarioKey, snapshotId: materialized.snapshotId }
        : undefined;
    },

    async validateSchedules(input) {
      const result = await validateAndPersistSchedules(pool, input.tripId, input.snapshotId);
      if (!result) {
        throw new Error(
          `cannot validate schedules for trip ${input.tripId}: snapshot or approval missing`,
        );
      }
      return result;
    },

    async propose(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while staging a proposal`);
      }
      return booking.propose({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        service: input.service,
        offerId: input.offerId,
        operationId: input.operationId,
        sourceFingerprint: input.sourceFingerprint,
        fencingToken: ctx.fencingToken,
      });
    },

    async confirm(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while confirming a booking`);
      }
      return booking.confirm({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        acceptedRevision: input.acceptedRevision,
        confirmationKey: input.confirmationKey,
        acceptedDemoDisclaimer: true,
        fencingToken: ctx.fencingToken,
      });
    },

    async replace(input) {
      const trip = await getTrip(pool, input.tripId);
      if (!trip) {
        throw new Error(`trip ${input.tripId} not found while confirming a replacement`);
      }
      const active = await getActiveReservation(pool, input.tripId, input.service);
      if (!active) {
        throw new Error(`no active ${input.service} reservation to replace`);
      }
      return booking.replaceConfirmed({
        tripId: input.tripId,
        sessionId: trip.sessionId,
        proposalId: input.proposalId,
        decisionId: input.decisionId,
        operationId: input.operationId,
        acceptedRevision: input.acceptedRevision,
        confirmationKey: input.confirmationKey,
        acceptedDemoDisclaimer: true,
        affectedReservationId: active.id,
        fencingToken: ctx.fencingToken,
      });
    },

    async ensureDomains(tripId) {
      const manifest = await scenarios.ensureDomains(tripId, [...RESEARCH_MATERIALIZED_DOMAINS]);
      return { materializedDomains: manifest.materializedDomains, snapshotId: manifest.snapshotId };
    },

    async loadResearchInputs(tripId, operationId) {
      return loadTripResearchInputs(pool, tripId, operationId);
    },

    async researchDomain(input) {
      // Domain writes (artifact upsert, fault counters) verify the operation's
      // fencing token inside their own short transactions, so a worker that lost
      // its lease writes nothing.
      return researchTripDomain(pool, input, fenceFor(ctx, input.operationId, input.tripId));
    },

    async rankRecommendations(input) {
      return rankTripRecommendations(
        pool,
        input,
        fenceFor(ctx, input.operationId, input.tripId),
      );
    },

    async recordResearchEvent(event) {
      await insertFencedEvent(ctx, {
        type: `research.domain_${event.phase}`,
        payload: {
          domain: event.domain,
          attempt: event.attempt,
          durationMs: event.durationMs,
          status: event.status,
          simulatedFailure: event.simulatedFailure,
          reason: event.reason,
          fingerprint: event.fingerprint,
        },
      });
    },

    async applyProgram(input) {
      const plan = await planProgramSelections(pool, {
        tripId: input.tripId,
        mealSelections: input.mealSelections,
      });
      let firstReplacement: {
        proposalId: string;
        service: (typeof plan.replacements)[number]["serviceKey"];
        sourceFingerprint: string;
      } | null = null;
      for (const replacement of plan.replacements) {
        const trip = await getTrip(pool, input.tripId);
        if (!trip) {
          throw new Error(`trip ${input.tripId} not found while staging a meal replacement`);
        }
        const sourceFingerprint = fingerprint({
          kind: "replacement_confirmation",
          tripId: input.tripId,
          operationId: input.operationId,
          service: replacement.serviceKey,
          offerId: replacement.offerId,
        });
        const proposal = await booking.propose({
          tripId: input.tripId,
          sessionId: trip.sessionId,
          service: replacement.serviceKey,
          offerId: replacement.offerId,
          operationId: input.operationId,
          sourceFingerprint,
          fencingToken: ctx.fencingToken,
        });
        firstReplacement ??= {
          proposalId: proposal.proposalId,
          service: replacement.serviceKey,
          sourceFingerprint,
        };
      }
      await upsertProgramSelections(pool, input.tripId, plan.selections);
      await recordPreferredActivities(pool, {
        tripId: input.tripId,
        preferredActivityIds: input.preferredActivityIds,
      });
      return {
        applied: true,
        replacementStaged: firstReplacement !== null,
        replacementProposalId: firstReplacement?.proposalId ?? null,
        replacementService: firstReplacement?.service ?? null,
        replacementSourceFingerprint: firstReplacement?.sourceFingerprint ?? null,
      };
    },

    async validateSelectedLogistics(input) {
      return validateTripLogistics(pool, input.tripId);
    },

    async loadProgress(tripId) {
      return loadTripProgress(pool, tripId);
    },

    async interpretIntent(input) {
      return ai.interpret({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: ctx.fencingToken,
        message: input.message,
        ...(signal ? { signal } : {}),
      });
    },

    async loadChatMessage(operationId) {
      const payload = await getOperationPayload(pool, operationId);
      const parsed = chatCommandPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data.message : undefined;
    },

    async planItinerary(input) {
      const data = await loadItineraryPlanningData(pool, input.tripId);
      const departureInstant = returnDepartureInstant(data);
      if (!data.confirmedFlightOfferId || !departureInstant) {
        throw new ItineraryPersistenceError(
          "CONFLICT",
          "the itinerary needs a confirmed flight before planning can start",
        );
      }
      const departureMinuteRaw = localMinuteOfInstant(
        departureInstant,
        data.trip.sightseeingDate,
        data.zone,
      );
      const context = buildPlannerContext(data, input.feedback, departureMinuteRaw);
      const planned = await ai.plan({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: ctx.fencingToken,
        attempt: input.attempt,
        context,
        ...(signal ? { signal } : {}),
      });

      await insertFencedEvent(ctx, {
        type: "itinerary.attempt_started",
        payload: { attempt: input.attempt, mode: planned.mode, candidateCount: context.candidates.length },
      });

      // Scenario E: the persisted first-attempt overlay injects one labeled
      // overlap after parsing and records its outcome (idempotent per operation).
      const overlay = await loadOverlay(pool, input.tripId, "itinerary", input.operationId);
      const overlayArmed = overlay !== null && overlay.mode === "invalid_itinerary";
      const injectedBefore = overlayArmed && (overlay?.counters["attempts"] ?? 0) >= 1;
      let output = planned.kind === "planned" ? planned.output : null;
      let simulatedFailure = false;
      let simulatedFailureNote: string | null = null;
      let injectedThisAttempt = false;
      if (output && overlayArmed && !injectedBefore) {
        const injected = injectFirstAttemptOverlap(output);
        injectedThisAttempt = injected !== output;
        output = injected;
        simulatedFailure = injectedThisAttempt;
        if (injectedThisAttempt) {
          simulatedFailureNote =
            "Simulated failure: this draft contains an injected first-attempt overlap; the bounded loop re-plans it.";
        }
      } else if (injectedBefore && input.attempt > 1) {
        // The repaired draft still carries the labeled fault so the timeline can
        // show that the injected corruption was detected and repaired.
        simulatedFailure = true;
        simulatedFailureNote =
          "Simulated failure: the first planning attempt included an injected overlap; it was repaired within the bounded loop.";
      }

      const meals = selectedMealOffers(data);
      const activities = activityCandidates(data);
      const hotel = data.confirmedHotelOfferId
        ? data.content.hotels.find((offer) => offer.id === data.confirmedHotelOfferId)
        : undefined;
      const flight = data.confirmedFlightOfferId
        ? data.content.flights.find((combination) => combination.id === data.confirmedFlightOfferId)
        : undefined;
      const source = itinerarySource(data);
      const assembly = assembleItinerary({
        proposal: output ?? { stops: [] },
        seedScope: `${input.operationId}:${input.attempt}`,
        sightseeingDate: data.trip.sightseeingDate,
        zone: data.zone,
        adults: data.trip.adults,
        pace: data.trip.preferences.activityPace,
        activities,
        meals,
        confirmedMealIds: data.confirmedMealIds,
        flight: flight
          ? {
              offerId: flight.id,
              partyTotalMinor: flight.partyTotalMinor,
              label: `Flights ${flight.id}`,
            }
          : null,
        hotel: hotel
          ? {
              offerId: hotel.id,
              name: hotel.name,
              partyTotalMinor: hotel.partyTotalMinor,
              anchor: hotel.anchor,
            }
          : null,
        destinationAirport:
          data.destinationAirportId && data.destinationAirportAnchor
            ? {
                id: data.destinationAirportId,
                name: "destination airport",
                anchor: data.destinationAirportAnchor,
              }
            : null,
        dinnerExcludedReason: data.dinnerExcludedReason,
        returnDepartureInstant: departureInstant,
        routing: ITINERARY_ROUTING,
        routingRuleVersion: ITINERARY_ROUTING_RULE_VERSION,
        simulatedFailure,
      });

      const rejectionIssue: ItineraryIssue | null =
        output === null
          ? {
              severity: "error",
              code: "invalid_proposal",
              message:
                planned.kind === "rejected"
                  ? `${INVALID_PROPOSAL_LABEL} ${planned.reason}`.slice(0, 400)
                  : INVALID_PROPOSAL_LABEL,
              eventIds: [],
              simulatedFailure: false,
            }
          : null;

      const validation = validateItinerary({
        events: rejectionIssue ? [] : assembly.events,
        assemblyIssues: rejectionIssue ? [...assembly.issues, rejectionIssue] : assembly.issues,
        costs: assembly.costs,
        walkingKm: assembly.walkingKm,
        pace: data.trip.preferences.activityPace,
        minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
        budgetMinor: data.trip.preferences.maxBudgetMinor ?? null,
        dinnerExcludedReason: data.dinnerExcludedReason,
        dinnerSelected:
          (data.confirmedMeals.dinner ?? data.selectedMeals.dinner) !== null,
        simulatedFailure,
        source,
      });

      const budgetConflict = validation.errors.some((error) => error.code === "budget_exceeded");
      const conflictDecision =
        validation.status === "invalid"
          ? buildItineraryConflictDecision({
              errors: validation.errors,
              metrics: validation.metrics,
              pace: data.trip.preferences.activityPace,
              minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
              review: null,
            })
          : null;

      let persisted: { id: string; version: number } | null = null;
      if (!rejectionIssue) {
        persisted = await persistItineraryDraft(
          pool,
          {
            tripId: input.tripId,
            operationId: input.operationId,
            attempt: input.attempt,
            sightseeingDate: data.trip.sightseeingDate,
            zone: data.zone,
            adults: data.trip.adults,
            pace: data.trip.preferences.activityPace,
            travelVariant: data.trip.travelVariant,
            events: [...assembly.events],
            validation,
            costs: assembly.costs,
            review: null,
            simulatedFailure,
            simulatedFailureNote,
          },
          fenceFor(ctx, input.operationId, input.tripId),
        );
      }

      // The fault outcome is recorded only after the corrupted draft committed:
      // a crash before persistence leaves the injection unrecorded, so the next
      // attempt injects once more instead of claiming a corruption that never
      // reached the timeline (still exactly one injection per operation bound).
      if (injectedThisAttempt) {
        await recordFaultOutcome(
          pool,
          {
            tripId: input.tripId,
            operationId: input.operationId,
            domain: "itinerary",
            fault: "invalid_itinerary",
            outcome: "unavailable",
            attempt: 1,
            reason: "injected first-attempt overlap",
          },
          fenceFor(ctx, input.operationId, input.tripId),
        );
      }

      await insertFencedEvent(ctx, {
        type: "itinerary.attempt_finished",
        payload: {
          attempt: input.attempt,
          status: validation.status,
          errorCodes: validation.errors.map((error) => error.code),
          warningCodes: validation.warnings.map((warning) => warning.code),
          simulatedFailure,
          mode: planned.mode,
        },
      });

      return {
        itineraryId: persisted?.id ?? null,
        version: persisted?.version ?? null,
        status: validation.status,
        errors: validation.errors,
        warnings: validation.warnings,
        metrics: validation.metrics,
        budgetConflict,
        conflictDecision,
        simulatedFailure,
        simulatedFailureNote,
        mode: planned.mode,
      };
    },

    async reviewItinerary(input) {
      const data = await loadItineraryPlanningData(pool, input.tripId);
      const record = await loadLatestItinerary(pool, input.tripId);
      if (!record) {
        throw new ItineraryPersistenceError("CONFLICT", "no itinerary draft is available to review");
      }
      const context = buildReviewerContext(data, record);
      const reviewed = await ai.review({
        tripId: input.tripId,
        operationId: input.operationId,
        fencingToken: ctx.fencingToken,
        attempt: input.attempt,
        context,
        ...(signal ? { signal } : {}),
      });
      const suggestions = reviewed.output.issues
        .map((issue) => `${issue.code}: ${issue.explanation}`.slice(0, 300))
        .slice(0, 8);
      const demoteToWarnings = reviewed.output.verdict === "revise" && input.atBound;
      const reviewWarnings: ItineraryIssue[] = demoteToWarnings
        ? reviewed.output.issues.slice(0, 8).map((issue) => ({
            severity: "warning" as const,
            code: "review_suggestion" as const,
            message: `Review suggestion (${issue.code}): ${issue.explanation}`.slice(0, 400),
            eventIds: issue.eventIds.slice(0, 8),
            simulatedFailure: false,
          }))
        : [];
      const validation = {
        ...record.validation,
        warnings: [
          ...record.validation.warnings.filter((warning) => warning.code !== "review_suggestion"),
          ...reviewWarnings,
        ],
      };
      const review: ItineraryReview = {
        verdict: reviewed.output.verdict,
        issues: reviewed.output.issues,
        suggestedOrder: reviewed.output.suggestedOrder,
        explanation: reviewed.output.explanation,
        suggestionsAsWarnings: demoteToWarnings,
      };
      await saveItineraryReview(
        pool,
        {
          tripId: input.tripId,
          itineraryId: record.id,
          operationId: input.operationId,
          review,
          validation,
          simulatedFailure: record.simulatedFailure,
          simulatedFailureNote: record.simulatedFailureNote,
        },
        fenceFor(ctx, input.operationId, input.tripId),
      );
      const conflictDecision =
        reviewed.output.verdict === "conflict"
          ? buildItineraryConflictDecision({
              errors: record.validation.errors,
              metrics: record.validation.metrics,
              pace: data.trip.preferences.activityPace,
              minimumActivityCounts: data.trip.preferences.minimumActivityCounts,
              review,
            })
          : null;
      await insertFencedEvent(ctx, {
        type: "itinerary.reviewed",
        payload: {
          verdict: reviewed.output.verdict,
          issueCount: reviewed.output.issues.length,
          attempt: input.attempt,
          mode: reviewed.mode,
        },
      });
      return {
        verdict: reviewed.output.verdict,
        suggestions,
        issueCount: reviewed.output.issues.length,
        suggestedOrder: reviewed.output.suggestedOrder,
        warnings: reviewWarnings,
        conflictDecision,
        mode: reviewed.mode,
      };
    },

    async approveItinerary(input) {
      const data = await loadItineraryPlanningData(pool, input.tripId);
      const currentSourceFingerprint = computeItinerarySourceFingerprint(itinerarySource(data));
      const ref = await approveItineraryDraft(
        pool,
        {
          tripId: input.tripId,
          itineraryId: input.itineraryId,
          currentSourceFingerprint,
        },
        fenceFor(ctx, input.operationId, input.tripId),
      );
      await insertFencedEvent(ctx, {
        type: "itinerary.approved",
        payload: { itineraryId: ref.id, version: ref.version, decisionId: input.decisionId },
      });
      return { itineraryId: ref.id, version: ref.version };
    },
  });
}
