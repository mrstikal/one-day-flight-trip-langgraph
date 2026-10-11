import type { TravelState, TravelUpdate } from "../travel/state.js";

/** Interpret the resume action and select the next stage of the graph. */
export function applyDecisionNode(state: TravelState): TravelUpdate {
  switch (state.lastAction) {
    case "choose_offer":
      return { pendingStage: "stage" };
    case "confirm_booking":
      return { pendingStage: "commit" };
    case "reject_proposal":
      // Return to flight selection with the same validated combinations.
      return {
        pendingStage: "reselection",
        nextDecisionKind: "flight_choice",
        proposalId: null,
        selectedOfferId: null,
        decisionFingerprint: null,
      };
    default:
      return { pendingStage: "end" };
  }
}
