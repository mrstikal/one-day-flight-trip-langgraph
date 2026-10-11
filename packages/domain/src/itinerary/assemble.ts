import { Temporal } from "@js-temporal/polyfill";
import type {
  ActivityTag,
  ItineraryCostItem,
  ItineraryCosts,
  ItineraryEvent,
  ItineraryIssue,
  Meal,
  ServiceLevel,
} from "@odft/contracts";
import { fingerprint } from "../fingerprints.js";
import {
  AIRPORT_BUFFER_MINUTES,
  PACE_PROFILES,
  physicalDemandForTags,
  simulatedOpeningWindow,
} from "./taxonomy.js";

/**
 * Deterministic itinerary assembly (03-langgraph-design.md section 4, Phase 10).
 *
 * The planner proposes only candidate IDs plus an ordering/time allocation; this
 * module resolves UTC times, locked reservation windows, simulated route
 * estimates, airport events, and the party cost breakdown. It inserts transfers
 * only into sufficient gaps and records a conflict when they do not fit; it never
 * compresses an activity or moves a fixed booking.
 */

export interface ItineraryLatLon {
  readonly lat: number;
  readonly lon: number;
}

export type ItineraryRouteMode = "walking" | "public_transport" | "taxi" | "airport_transfer";

export interface ItineraryRouteLeg {
  readonly startRef: string;
  readonly endRef: string;
  readonly mode: ItineraryRouteMode;
  readonly adults: number;
  readonly start: ItineraryLatLon;
  readonly end: ItineraryLatLon;
  readonly ruleVersion: string;
}

export interface ItineraryRouteEstimate {
  readonly distanceKm: number;
  readonly estimatedMinutes: number;
  readonly partyTotalMinor: number;
  readonly simulated: true;
}

/** Structural subset of the Phase 04 `RoutingProvider` (no data-package dependency). */
export interface ItineraryRouting {
  estimate(input: ItineraryRouteLeg): ItineraryRouteEstimate;
}

/** One proposed stop after membership resolution. */
interface ProposedStop {
  readonly kind: "meal" | "activity" | "break" | "free_time";
  readonly refId?: string;
  readonly startMinute: number;
  readonly durationMinutes: number;
}

export interface AssemblyActivityCandidate {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly ActivityTag[];
  readonly durationMinutes: number;
  readonly ticketMinorPerAdult: number;
  readonly anchor: ItineraryLatLon;
  readonly reference: boolean;
  readonly provenance: readonly string[];
}

export interface AssemblyMealCandidate {
  readonly id: string;
  readonly name: string;
  readonly meal: Meal;
  readonly level: ServiceLevel;
  readonly durationMinutes: number;
  readonly partyTotalMinor: number;
  readonly windowStartMinute: number;
  readonly windowEndMinute: number;
  readonly anchor: ItineraryLatLon;
  readonly provenance: readonly string[];
}

export interface AssemblyFlight {
  readonly offerId: string;
  readonly partyTotalMinor: number;
  readonly label: string;
}

export interface AssemblyHotel {
  readonly offerId: string;
  readonly name: string;
  readonly partyTotalMinor: number;
  readonly anchor: ItineraryLatLon;
}

export interface AssemblyAirport {
  readonly id: string;
  readonly name: string;
  readonly anchor: ItineraryLatLon;
}

export interface AssembleItineraryInput {
  readonly proposal: { readonly stops: readonly ProposedStop[] };
  readonly seedScope: string;
  readonly sightseeingDate: string;
  readonly zone: string;
  readonly adults: number;
  readonly pace: keyof typeof PACE_PROFILES;
  readonly activities: readonly AssemblyActivityCandidate[];
  readonly meals: readonly AssemblyMealCandidate[];
  /** Confirmed meal offer ids: locked to their reservation window. */
  readonly confirmedMealIds: readonly string[];
  readonly flight: AssemblyFlight | null;
  readonly hotel: AssemblyHotel | null;
  readonly destinationAirport: AssemblyAirport | null;
  readonly dinnerExcludedReason: string | null;
  readonly returnDepartureInstant: string;
  readonly routing: ItineraryRouting;
  readonly routingRuleVersion: string;
  /** True while the labeled injected first-attempt overlay corrupted the proposal. */
  readonly simulatedFailure: boolean;
}

export interface ItineraryAssembly {
  readonly events: readonly ItineraryEvent[];
  /** Deterministic conflicts recorded during assembly (merged as validator errors). */
  readonly issues: readonly ItineraryIssue[];
  readonly costs: ItineraryCosts;
  readonly walkingKm: number;
  /** True when the dinner slot was excluded by the deterministic no-slot result. */
  readonly dinnerExcluded: boolean;
  readonly dinnerExcludedReason: string | null;
}

function uuidFrom(seed: string): string {
  const hex = fingerprint({ kind: "itinerary-event-id", seed });
  const raw = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
  return raw;
}

function minutesToLocal(minute: number): string {
  const bounded = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(bounded / 60);
  const minutes = bounded % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function zonedAt(date: string, minute: number, zone: string): Temporal.ZonedDateTime {
  const base = Temporal.PlainDate.from(date);
  const dayOffset = Math.floor(minute / 1440);
  const withinDay = minute - dayOffset * 1440;
  return Temporal.ZonedDateTime.from({
    timeZone: zone,
    year: base.year,
    month: base.month,
    day: base.day,
    hour: Math.floor(withinDay / 60),
    minute: withinDay % 60,
    second: 0,
  }).add({ days: dayOffset });
}

/** Local minutes-of-day of an instant in the destination zone, relative to date. */
export function localMinuteOfInstant(instant: string, date: string, zone: string): number {
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(zone);
  const dayDiff = zoned.toPlainDate().since(Temporal.PlainDate.from(date)).days;
  return dayDiff * 1440 + zoned.hour * 60 + zoned.minute;
}

interface ResolvedStop {
  readonly stop: ProposedStop;
  readonly startMinute: number;
  readonly endMinute: number;
}

function resolveMeal(
  stop: ProposedStop,
  input: AssembleItineraryInput,
  issues: ItineraryIssue[],
): ResolvedStop | null {
  const offer = input.meals.find((meal) => meal.id === stop.refId);
  if (!offer) {
    issues.push({
      severity: "error",
      code: "incompatible_reservation",
      message: `The proposed ${stop.refId ?? "meal"} is not a selected meal offer; nothing was substituted.`,
      eventIds: [],
      simulatedFailure: input.simulatedFailure,
    });
    return null;
  }
  const locked = input.confirmedMealIds.includes(offer.id);
  const duration = offer.durationMinutes;
  const latestStart = Math.max(offer.windowStartMinute, offer.windowEndMinute - duration);
  const start = locked
    ? offer.windowStartMinute
    : Math.min(Math.max(stop.startMinute, offer.windowStartMinute), latestStart);
  if (start + duration > offer.windowEndMinute) {
    issues.push({
      severity: "error",
      code: "opening_hours_mismatch",
      message: `The ${offer.meal} window (${offer.name}) closes before a ${duration}-minute meal fits; nothing was compressed.`,
      eventIds: [],
      simulatedFailure: input.simulatedFailure,
    });
  }
  return { stop, startMinute: start, endMinute: start + duration };
}

function resolveActivity(
  stop: ProposedStop,
  input: AssembleItineraryInput,
  issues: ItineraryIssue[],
): ResolvedStop | null {
  const activity = input.activities.find((candidate) => candidate.id === stop.refId);
  if (!activity) {
    issues.push({
      severity: "error",
      code: "invalid_proposal",
      message: `The proposal referenced an unknown activity ${stop.refId ?? "(missing id)"}; the stop was rejected.`,
      eventIds: [],
      simulatedFailure: input.simulatedFailure,
    });
    return null;
  }
  const duration = activity.durationMinutes;
  const window = simulatedOpeningWindow(activity.tags);
  const start = stop.startMinute;
  if (start < window.startMinute || start + duration > window.endMinute) {
    issues.push({
      severity: "error",
      code: "opening_hours_mismatch",
      message: `${activity.name} is placed ${minutesToLocal(start)}-${minutesToLocal(start + duration)} outside its simulated opening window ${minutesToLocal(window.startMinute)}-${minutesToLocal(window.endMinute)}.`,
      eventIds: [],
      simulatedFailure: input.simulatedFailure,
    });
  }
  return { stop, startMinute: start, endMinute: start + duration };
}

function resolveStops(
  input: AssembleItineraryInput,
  issues: ItineraryIssue[],
): ResolvedStop[] {
  const resolved: ResolvedStop[] = [];
  for (const stop of input.proposal.stops) {
    if (stop.kind === "meal") {
      const meal = resolveMeal(stop, input, issues);
      if (meal) {
        resolved.push(meal);
      }
      continue;
    }
    if (stop.kind === "activity") {
      const activity = resolveActivity(stop, input, issues);
      if (activity) {
        resolved.push(activity);
      }
      continue;
    }
    const duration = Math.min(180, Math.max(5, stop.durationMinutes));
    resolved.push({ stop, startMinute: stop.startMinute, endMinute: stop.startMinute + duration });
  }
  resolved.sort((a, b) => a.startMinute - b.startMinute);
  return resolved;
}

interface PlacedEvent {
  readonly event: ItineraryEvent;
  readonly anchor: ItineraryLatLon | null;
  readonly routeRef: string | null;
}

function buildEvent(
  input: AssembleItineraryInput,
  index: number,
  values: Omit<
    ItineraryEvent,
    "id" | "localDate" | "zone" | "startInstant" | "endInstant" | "startLocal" | "endLocal"
  > & {
    readonly startMinute: number;
    readonly endMinute: number;
    readonly durationMinutes?: number;
  },
): ItineraryEvent {
  const startMinute = Math.min(1439, Math.max(0, values.startMinute));
  const endMinute = Math.min(1440, Math.max(startMinute, values.endMinute));
  const start = zonedAt(input.sightseeingDate, startMinute, input.zone);
  const end = zonedAt(input.sightseeingDate, endMinute, input.zone);
  return {
    ...values,
    id: uuidFrom(`${input.seedScope}|${index}|${values.kind}|${values.refId ?? ""}`),
    localDate: input.sightseeingDate,
    zone: input.zone,
    startMinute,
    endMinute,
    durationMinutes: endMinute - startMinute,
    startLocal: minutesToLocal(startMinute),
    endLocal: minutesToLocal(endMinute),
    startInstant: start.toInstant().toString(),
    endInstant: end.toInstant().toString(),
  };
}

function chooseRouteMode(distanceKm: number, legCapKm: number): ItineraryRouteMode {
  if (distanceKm <= legCapKm) {
    return "walking";
  }
  return distanceKm <= 4 ? "public_transport" : "taxi";
}

const MODE_LABEL: Readonly<Record<ItineraryRouteMode, string>> = {
  walking: "Walking",
  public_transport: "Public transport",
  taxi: "Taxi",
  airport_transfer: "Airport transfer",
};

export function assembleItinerary(input: AssembleItineraryInput): ItineraryAssembly {
  const profile = PACE_PROFILES[input.pace];
  const issues: ItineraryIssue[] = [];
  const resolved = resolveStops(input, issues);
  const placed: PlacedEvent[] = [];
  let eventIndex = 0;
  let walkingKm = 0;

  for (const entry of resolved) {
    const stop = entry.stop;
    const previousWithRoute = [...placed].reverse().find((candidate) => candidate.routeRef !== null);
    if (previousWithRoute && previousWithRoute.anchor) {
      const gap = entry.startMinute - previousWithRoute.event.endMinute;
      const nextAnchor = anchorFor(stop, input);
      const nextRef = routeRefFor(stop);
      if (gap > 0 && nextAnchor && nextRef) {
        const distance = haversineKm(previousWithRoute.anchor, nextAnchor);
        const mode = chooseRouteMode(distance, profile.legWalkCapKm);
        const estimate = input.routing.estimate({
          startRef: previousWithRoute.routeRef ?? "previous",
          endRef: nextRef,
          mode,
          adults: input.adults,
          start: previousWithRoute.anchor,
          end: nextAnchor,
          ruleVersion: input.routingRuleVersion,
        });
        if (mode === "walking") {
          walkingKm += estimate.distanceKm;
        }
        // A transfer is inserted only into a gap that fits the simulated route
        // estimate plus the pace buffer; a smaller gap is a recorded conflict and
        // nothing is inserted, moved, or compressed.
        const required = estimate.estimatedMinutes + profile.bufferMinutes;
        if (gap < required) {
          issues.push({
            severity: "error",
            code: "transfer_gap",
            message: `The simulated ${MODE_LABEL[mode].toLowerCase()} transfer after ${previousWithRoute.event.title} needs about ${estimate.estimatedMinutes} minutes but only ${gap} are left before ${minutesToLocal(entry.startMinute)}.`,
            eventIds: [],
            simulatedFailure: input.simulatedFailure,
          });
        } else {
          const withRhythmBreak =
            previousWithRoute.event.kind === "activity" &&
            gap >= profile.rhythmBreakMinutes + estimate.estimatedMinutes;
          let transferStart = previousWithRoute.event.endMinute;
          if (withRhythmBreak) {
            placed.push({
              event: buildEvent(input, (eventIndex += 1), {
                kind: "break",
                title: "Rhythm break",
                startMinute: previousWithRoute.event.endMinute,
                endMinute: previousWithRoute.event.endMinute + profile.rhythmBreakMinutes,
                durationMinutes: profile.rhythmBreakMinutes,
                refId: null,
                activityTags: [],
                provenance: ["Pace rhythm break", "Simulated planning assumption"],
                physicalDemand: "low",
                costInclusionKey: null,
                costMinor: 0,
                location: null,
                locked: false,
                lockReason: null,
                simulated: true,
              }),
              anchor: null,
              routeRef: null,
            });
            transferStart += profile.rhythmBreakMinutes;
          }
          placed.push({
            event: buildEvent(input, (eventIndex += 1), {
              kind: "transfer",
              title: `Transfer to ${titleFor(stop, input)}`,
              startMinute: transferStart,
              endMinute: transferStart + estimate.estimatedMinutes,
              durationMinutes: estimate.estimatedMinutes,
              refId: null,
              activityTags: [],
              provenance: [`${MODE_LABEL[mode]} transfer`, "Simulated route estimate"],
              physicalDemand: "low",
              costInclusionKey: `transfer:${placed.length}:${previousWithRoute.routeRef}->${nextRef}`,
              costMinor: estimate.partyTotalMinor,
              location: null,
              locked: false,
              lockReason: null,
              simulated: true,
            }),
            anchor: null,
            routeRef: null,
          });
        }
      }
    }
    const event = eventFor(stop, input, entry, eventIndex += 1);
    placed.push({
      event,
      anchor: anchorFor(stop, input),
      routeRef: routeRefFor(stop),
    });
  }

  // Long break: one block per day when the plan leaves room after lunch.
  eventIndex = appendLongBreakIfRoom(input, placed, profile.longBreakMinutes, eventIndex);

  // Airport buffer: content must end before the return-flight buffer start. A
  // return on a later day (two-nights variant) has no same-day window, so the
  // sightseeing day carries no buffer at all.
  const departureMinuteRaw = localMinuteOfInstant(
    input.returnDepartureInstant,
    input.sightseeingDate,
    input.zone,
  );
  const sameDayReturn = departureMinuteRaw < 1440;
  const departureMinute = Math.min(1440, departureMinuteRaw);
  const bufferStart = departureMinute - AIRPORT_BUFFER_MINUTES;
  const contentEvents = placed.filter(
    (entry) => entry.event.kind === "meal" || entry.event.kind === "activity" || entry.event.kind === "free_time",
  );
  const lastContentEnd =
    contentEvents.length === 0
      ? 0
      : Math.max(...contentEvents.map((entry) => entry.event.endMinute));
  if (sameDayReturn && contentEvents.length > 0 && lastContentEnd <= bufferStart) {
    const title = "Airport buffer";
    placed.push({
      event: buildEvent(input, (eventIndex += 1), {
        kind: "airport_buffer",
        title,
        startMinute: lastContentEnd,
        endMinute: departureMinute,
        durationMinutes: departureMinute - lastContentEnd,
        refId: null,
        activityTags: [],
        provenance: ["Return-flight buffer", "Fixed flight window"],
        physicalDemand: "low",
        costInclusionKey: null,
        costMinor: 0,
        location: null,
        locked: true,
        lockReason: "Changing the return-flight window requires a route change.",
        simulated: false,
      }),
      anchor: null,
      routeRef: null,
    });
  } else if (sameDayReturn && contentEvents.length > 0) {
    issues.push({
      severity: "error",
      code: "airport_buffer",
      message: `The plan ends at ${minutesToLocal(lastContentEnd)}, inside the ${AIRPORT_BUFFER_MINUTES}-minute return-flight buffer (departure ${minutesToLocal(departureMinute)}); nothing was moved automatically.`,
      eventIds: [],
      simulatedFailure: input.simulatedFailure,
    });
  }

  const events = placed
    .map((entry) => entry.event)
    .sort((a, b) => a.startMinute - b.startMinute || a.kind.localeCompare(b.kind));

  // Overlap detection over the resolved content events (anchor ids available).
  const content = events.filter(
    (event) => event.kind === "meal" || event.kind === "activity" || event.kind === "free_time",
  );
  for (let index = 0; index + 1 < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];
    if (current && next && next.startMinute < current.endMinute) {
      issues.push({
        severity: "error",
        code: "overlap",
        message: `Two planned stops overlap between ${minutesToLocal(next.startMinute)} and ${minutesToLocal(current.endMinute)}; nothing was moved automatically.`,
        eventIds: [current.id, next.id],
        simulatedFailure: input.simulatedFailure,
      });
    }
  }

  const costs = buildCosts(input, events);
  const dinnerExcluded = input.dinnerExcludedReason !== null;

  return {
    events,
    issues,
    costs,
    walkingKm,
    dinnerExcluded,
    dinnerExcludedReason: input.dinnerExcludedReason,
  };
}

function anchorFor(stop: ProposedStop, input: AssembleItineraryInput): ItineraryLatLon | null {
  if (stop.kind === "meal") {
    return input.meals.find((meal) => meal.id === stop.refId)?.anchor ?? null;
  }
  if (stop.kind === "activity") {
    return input.activities.find((activity) => activity.id === stop.refId)?.anchor ?? null;
  }
  return null;
}

function routeRefFor(stop: ProposedStop): string | null {
  return stop.kind === "meal" || stop.kind === "activity" ? stop.refId ?? null : null;
}

function titleFor(stop: ProposedStop, input: AssembleItineraryInput): string {
  if (stop.kind === "meal") {
    return input.meals.find((meal) => meal.id === stop.refId)?.name ?? "meal";
  }
  if (stop.kind === "activity") {
    return input.activities.find((activity) => activity.id === stop.refId)?.name ?? "activity";
  }
  return stop.kind === "break" ? "break" : "free time";
}

function eventFor(
  stop: ProposedStop,
  input: AssembleItineraryInput,
  entry: ResolvedStop,
  index: number,
): ItineraryEvent {
  const duration = entry.endMinute - entry.startMinute;
  if (stop.kind === "meal") {
    const offer = input.meals.find((meal) => meal.id === stop.refId);
    const locked = offer !== undefined && input.confirmedMealIds.includes(offer.id);
    return buildEvent(input, index, {
      kind: "meal",
      title: offer?.name ?? "Meal",
      startMinute: entry.startMinute,
      endMinute: entry.endMinute,
      durationMinutes: duration,
      refId: offer?.id ?? null,
      activityTags: [],
      provenance: [
        locked ? `Confirmed ${offer?.meal ?? "meal"}` : `Selected ${offer?.meal ?? "meal"} (${offer?.level ?? "standard"})`,
        ...(offer?.provenance ?? []),
      ].slice(0, 6),
      physicalDemand: "low",
      costInclusionKey: offer ? `meal:${offer.id}` : null,
      costMinor: offer?.partyTotalMinor ?? 0,
      location: offer?.anchor ?? null,
      locked,
      lockReason: locked ? "Confirmed reservation time is fixed." : null,
      simulated: false,
    });
  }
  if (stop.kind === "activity") {
    const activity = input.activities.find((candidate) => candidate.id === stop.refId);
    return buildEvent(input, index, {
      kind: "activity",
      title: activity?.name ?? "Activity",
      startMinute: entry.startMinute,
      endMinute: entry.endMinute,
      durationMinutes: duration,
      refId: activity?.id ?? null,
      activityTags: activity ? [...activity.tags] : [],
      provenance: activity
        ? [
            `${activity.name} visit`,
            activity.reference ? "Reference landmark" : "Demo activity template",
            ...activity.provenance,
          ].slice(0, 6)
        : ["Demo activity template"],
      physicalDemand: activity ? physicalDemandForTags(activity.tags) : "low",
      costInclusionKey: activity ? `activity:${activity.id}` : null,
      costMinor: activity ? activity.ticketMinorPerAdult * input.adults : 0,
      location: activity?.anchor ?? null,
      locked: false,
      lockReason: null,
      simulated: activity ? !activity.reference : true,
    });
  }
  if (stop.kind === "break") {
    return buildEvent(input, index, {
      kind: "break",
      title: "Break",
      startMinute: entry.startMinute,
      endMinute: entry.endMinute,
      durationMinutes: duration,
      refId: null,
      activityTags: [],
      provenance: ["Pace break", "Simulated planning assumption"],
      physicalDemand: "low",
      costInclusionKey: null,
      costMinor: 0,
      location: null,
      locked: false,
      lockReason: null,
      simulated: false,
    });
  }
  return buildEvent(input, index, {
    kind: "free_time",
    title: "Free time",
    startMinute: entry.startMinute,
    endMinute: entry.endMinute,
    durationMinutes: duration,
    refId: null,
    activityTags: [],
    provenance: ["Free time"],
    physicalDemand: "low",
    costInclusionKey: null,
    costMinor: 0,
    location: null,
    locked: false,
    lockReason: null,
    simulated: false,
  });
}

function appendLongBreakIfRoom(
  input: AssembleItineraryInput,
  placed: PlacedEvent[],
  longBreakMinutes: number,
  eventIndex: number,
): number {
  if (longBreakMinutes <= 0) {
    return eventIndex;
  }
  const events = placed.map((entry) => entry.event).sort((a, b) => a.startMinute - b.startMinute);
  for (let index = 0; index + 1 < events.length; index += 1) {
    const current = events[index];
    const next = events[index + 1];
    if (!current || !next || current.kind !== "meal" || current.refId === null) {
      continue;
    }
    const meal = input.meals.find((candidate) => candidate.id === current.refId);
    if (meal?.meal !== "lunch") {
      continue;
    }
    const gap = next.startMinute - current.endMinute;
    if (gap >= longBreakMinutes + 5) {
      placed.push({
        event: buildEvent(input, eventIndex + 1, {
          kind: "break",
          title: "Long break",
          startMinute: current.endMinute + 5,
          endMinute: current.endMinute + 5 + longBreakMinutes,
          durationMinutes: longBreakMinutes,
          refId: null,
          activityTags: [],
          provenance: ["Long break", "Simulated planning assumption"],
          physicalDemand: "low",
          costInclusionKey: null,
          costMinor: 0,
          location: null,
          locked: false,
          lockReason: null,
          simulated: false,
        }),
        anchor: null,
        routeRef: null,
      });
      return eventIndex + 1;
    }
  }
  return eventIndex;
}

function buildCosts(
  input: AssembleItineraryInput,
  events: readonly ItineraryEvent[],
): ItineraryCosts {
  const items: ItineraryCostItem[] = [];
  const seen = new Set<string>();
  const add = (item: ItineraryCostItem): void => {
    if (seen.has(item.key)) {
      return;
    }
    seen.add(item.key);
    items.push(item);
  };

  if (input.flight) {
    add({
      key: `flight:${input.flight.offerId}`,
      label: input.flight.label,
      category: "flights",
      amountMinor: input.flight.partyTotalMinor,
      provenance: ["Confirmed flight reservation", "Both directions, party total"],
    });
  }
  if (input.hotel) {
    add({
      key: `hotel:${input.hotel.offerId}`,
      label: `${input.hotel.name} (room-only)`,
      category: "hotel",
      amountMinor: input.hotel.partyTotalMinor,
      provenance: ["Confirmed hotel reservation", "All room-nights, party total"],
    });
  }
  for (const event of events) {
    if (event.kind === "meal" && event.costInclusionKey && event.costMinor > 0) {
      add({
        key: event.costInclusionKey,
        label: `${event.title} (party total)`,
        category: "meals",
        amountMinor: event.costMinor,
        provenance: event.provenance.slice(0, 2),
      });
    }
    if (event.kind === "activity" && event.costInclusionKey) {
      add({
        key: event.costInclusionKey,
        label: event.costMinor > 0 ? `${event.title} tickets` : `${event.title} (no ticket)`,
        category: "activities",
        amountMinor: event.costMinor,
        provenance: event.provenance.slice(0, 2),
      });
    }
    if (event.kind === "transfer" && event.costInclusionKey) {
      add({
        key: event.costInclusionKey,
        label: `Transfer before ${event.title.replace(/^Transfer to /, "")}`,
        category: "transfers",
        amountMinor: event.costMinor,
        provenance: event.provenance.slice(0, 2),
      });
    }
  }

  if (input.destinationAirport && input.hotel) {
    for (const direction of ["arrival", "departure"] as const) {
      const estimate = input.routing.estimate({
        startRef: direction === "arrival" ? input.destinationAirport.id : input.hotel.offerId,
        endRef: direction === "arrival" ? input.hotel.offerId : input.destinationAirport.id,
        mode: "airport_transfer",
        adults: input.adults,
        start: direction === "arrival" ? input.destinationAirport.anchor : input.hotel.anchor,
        end: direction === "arrival" ? input.hotel.anchor : input.destinationAirport.anchor,
        ruleVersion: input.routingRuleVersion,
      });
      add({
        key: `airport_transfer:${direction}`,
        label: `${MODE_LABEL.airport_transfer} to/from ${input.destinationAirport.name} (${direction})`,
        category: "transfers",
        amountMinor: estimate.partyTotalMinor,
        provenance: ["Simulated airport transfer", "Party total"],
      });
    }
  }

  const excludedNotes = [
    "Meals outside the sightseeing day are not included.",
    "Home-to-origin-airport travel is not included.",
    "Souvenirs, insurance, and unselected services are not included.",
    "No payment is processed; all prices are simulated demo assumptions.",
  ];

  const totalMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);
  return {
    items,
    totalMinor,
    dinnerExcluded: input.dinnerExcludedReason !== null,
    dinnerExcludedReason: input.dinnerExcludedReason,
    excludedNotes,
  };
}

export function haversineKm(a: ItineraryLatLon, b: ItineraryLatLon): number {
  const radiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(h));
}