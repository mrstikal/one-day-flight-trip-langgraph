import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * Build the next pending-decision descriptor from accumulated state. The first
 * call offers the validated flight combinations; the second (after a choice is
 * staged) offers the booking confirmation for the staged proposal.
 */
export function prepareDecisionNode(state: TravelState): TravelUpdate {
  if (state.nextDecisionKind === "booking_confirmation") {
    return {
      decisionKind: "booking_confirmation",
      proposalId: state.proposalId,
      allowedOfferIds: state.selectedOfferId ? [state.selectedOfferId] : [],
      gate: "awaiting_booking",
    };
  }
  return {
    decisionKind: "flight_choice",
    proposalId: null,
    allowedOfferIds: state.validCombinationIds,
    gate: "flights_ready",
  };
}
