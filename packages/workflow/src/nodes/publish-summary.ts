import type { TravelState, TravelUpdate } from "../travel/state.js";

/** Terminal node: mark the run successful; the driver reconciles the projection. */
export function publishSummaryNode(_state: TravelState): TravelUpdate {
  return { lastOutcome: "success" };
}
