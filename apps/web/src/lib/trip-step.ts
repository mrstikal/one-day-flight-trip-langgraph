/**
 * The trip's current step: the step that needs the user next, mirroring the
 * forward links of the individual steps. Shared by the summary CTA, the
 * itinerary empty state, the assistant rail, and the inspector's "Back to the
 * trip" link so the step order can never drift between them.
 *
 * A pending decision wins over progress: while the worker waits for a
 * `hotel_choice` (even for a replacement of a confirmed hotel) the current step
 * is the page that presents it, not the next unfinished milestone.
 */

export interface TripStep {
  readonly href: string;
  /** Call to action for a "continue" button on the current page. */
  readonly cta: string;
  /** Label for pointing at the step from elsewhere (the assistant rail). */
  readonly open: string;
}

export interface TripStepInput {
  readonly tripId: string;
  readonly reservations: readonly { readonly serviceKey: string; readonly status: string }[];
  readonly hasProgram: boolean;
  readonly hasItinerary: boolean;
  /** Kind of the pending decision, when one is waiting for the user. */
  readonly pendingDecisionKind?: string | null;
  /** Service of the staged proposal, for booking/replacement confirmations. */
  readonly proposalServiceKey?: string | null;
}

function step(
  kind: "flights" | "hotel" | "meals" | "activities" | "itinerary",
  input: TripStepInput,
  confirmed: ReadonlySet<string>,
): TripStep {
  switch (kind) {
    case "flights":
      return {
        href: `/trips/${input.tripId}/flights`,
        cta: confirmed.has("flights") ? "Choose a different flight" : "Go to flight selection",
        open: "Open flight selection",
      };
    case "hotel":
      return {
        href: `/trips/${input.tripId}/hotel`,
        cta: confirmed.has("hotel") ? "Choose a different hotel" : "Continue to hotel selection",
        open: "Open hotel selection",
      };
    case "meals":
      return { href: `/trips/${input.tripId}/meals`, cta: "Continue to meals", open: "Open meals" };
    case "activities":
      return {
        href: `/trips/${input.tripId}/activities`,
        cta: "Review activities",
        open: "Open activities",
      };
    case "itinerary":
      return {
        href: `/trips/${input.tripId}/itinerary`,
        cta: "Open the itinerary",
        open: "Open the itinerary",
      };
  }
}

/**
 * A saved program: the projection always contains a program block as soon as the
 * snapshot materializes meals and activities, so only the persisted meal
 * selections (trip_selections) prove the user applied the program step.
 */
export function hasSavedProgram(
  program: { readonly selectedMeals: { readonly breakfast: string | null } } | null,
): boolean {
  return program !== null && program.selectedMeals.breakfast !== null;
}

/** Returns null once the itinerary exists and no decision is pending. */
export function nextTripStep(input: TripStepInput): TripStep | null {
  const confirmed = new Set(
    input.reservations
      .filter((reservation) => reservation.status === "confirmed")
      .map((reservation) => reservation.serviceKey),
  );

  switch (input.pendingDecisionKind) {
    case "flight_choice":
      return step("flights", input, confirmed);
    case "hotel_choice":
      return step("hotel", input, confirmed);
    case "program_choices":
      return step("meals", input, confirmed);
    case "itinerary_approval":
      return step("itinerary", input, confirmed);
    case "route_change_confirmation":
      // The impact card lives in the assistant rail; confirming it restarts
      // feasibility and yields a fresh flight choice.
      return step("flights", input, confirmed);
    case "booking_confirmation":
    case "replacement_confirmation": {
      const service = input.proposalServiceKey;
      if (service === "flights" || service === "hotel") {
        return step(service, input, confirmed);
      }
      if (service === "breakfast" || service === "lunch" || service === "dinner") {
        return step("meals", input, confirmed);
      }
      break;
    }
    default:
      break;
  }

  if (!confirmed.has("flights")) {
    return step("flights", input, confirmed);
  }
  if (!confirmed.has("hotel")) {
    return step("hotel", input, confirmed);
  }
  if (!input.hasProgram) {
    return step("meals", input, confirmed);
  }
  if (!input.hasItinerary) {
    return step("activities", input, confirmed);
  }
  return null;
}