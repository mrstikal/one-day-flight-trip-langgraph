import type { TravelState, TravelUpdate } from "../travel/state.js";

/** Interpret the resume action and select the next stage of the graph. */
export function applyDecisionNode(state: TravelState): TravelUpdate {
  switch (state.lastAction) {
    case "choose_offer":
      return { pendingStage: "stage" };
    case "confirm_booking":
      return { pendingStage: "commit" };
    default:
      return { pendingStage: "end" };
  }
}
