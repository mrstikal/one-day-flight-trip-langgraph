import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * Terminal node: report the structured outcome; the driver reconciles the
 * projection. A rejected route or an empty schedule is a *blocked* outcome (a
 * decision card explains it), never a plain success/ready.
 */
export function publishSummaryNode(state: TravelState): TravelUpdate {
  if (state.gate === "route_rejected") {
    return { lastOutcome: "no_feasible_route" };
  }
  if (state.gate === "no_schedule") {
    return { lastOutcome: "no_feasible_schedule" };
  }
  if (state.gate === "withdrawn") {
    return { lastOutcome: "withdrawn" };
  }
  return { lastOutcome: "success" };
}
