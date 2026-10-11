import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * Build the next pending-decision descriptor from accumulated state (Phase 06-07).
 *
 * - `flight_choice` offers the validated combinations;
 * - `hotel_choice` offers the materialized hotel offers;
 * - `program_choices` offers the meal offers (as selectable ids) and the activity
 *   choices (as option ids);
 * - `booking_confirmation` offers the single staged proposal.
 *
 * Only ids are stored, never offer content; the projection renders the content.
 */
export function prepareDecisionNode(state: TravelState): TravelUpdate {
  if (state.nextDecisionKind === "booking_confirmation") {
    return {
      decisionKind: "booking_confirmation",
      proposalId: state.proposalId,
      allowedOfferIds: state.selectedOfferId ? [state.selectedOfferId] : [],
      allowedOptionIds: [],
      gate: "awaiting_booking",
    };
  }
  if (state.nextDecisionKind === "hotel_choice") {
    return {
      decisionKind: "hotel_choice",
      proposalId: null,
      allowedOfferIds: state.hotelOfferIds,
      allowedOptionIds: [],
      gate: "hotels_ready",
    };
  }
  if (state.nextDecisionKind === "program_choices") {
    return {
      decisionKind: "program_choices",
      proposalId: null,
      allowedOfferIds: [
        ...state.mealOfferIds.breakfast,
        ...state.mealOfferIds.lunch,
        ...state.mealOfferIds.dinner,
      ],
      allowedOptionIds: state.activityIds,
      gate: "program_ready",
    };
  }
  return {
    decisionKind: "flight_choice",
    proposalId: null,
    allowedOfferIds: state.validCombinationIds,
    allowedOptionIds: [],
    gate: "flights_ready",
  };
}
