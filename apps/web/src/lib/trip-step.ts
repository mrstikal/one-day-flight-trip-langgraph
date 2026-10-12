/**
 * The trip's current step: the first step that is not finished yet, mirroring
 * the forward links of the individual steps. Shared by the summary CTA, the
 * itinerary empty state, and the inspector's "Back to the trip" link so the
 * step order can never drift between them.
 */

export interface TripStep {
  readonly href: string;
  readonly cta: string;
}

export interface TripStepInput {
  readonly tripId: string;
  readonly reservations: readonly { readonly serviceKey: string; readonly status: string }[];
  readonly hasProgram: boolean;
  readonly hasItinerary: boolean;
}

/** Returns null once the itinerary exists (nothing left to continue to). */
export function nextTripStep(input: TripStepInput): TripStep | null {
  const confirmed = new Set(
    input.reservations
      .filter((reservation) => reservation.status === "confirmed")
      .map((reservation) => reservation.serviceKey),
  );
  if (!confirmed.has("flights")) {
    return { href: `/trips/${input.tripId}/flights`, cta: "Go to flight selection" };
  }
  if (!confirmed.has("hotel")) {
    return { href: `/trips/${input.tripId}/hotel`, cta: "Continue to hotel selection" };
  }
  if (!input.hasProgram) {
    return { href: `/trips/${input.tripId}/meals`, cta: "Continue to meals" };
  }
  if (!input.hasItinerary) {
    return { href: `/trips/${input.tripId}/activities`, cta: "Review activities" };
  }
  return null;
}