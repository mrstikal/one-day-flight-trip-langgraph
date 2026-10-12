import type { TravelState } from "../travel/state.js";

/**
 * Phase 11: the single mapping from the invalidation matrix's work item to the
 * graph node that executes it. Used by every router that dispatches a work item
 * so the mapping can never drift between entry paths.
 */
export function routeByNextWork(state: TravelState): string | null {
  switch (state.nextWork) {
    case "research":
      return state.hasConfirmedFlight ? "ensure_domains" : "validate_route";
    case "progress":
      return "detect_progress";
    case "plan":
      return "plan_itinerary";
    case "validate":
      return "validate_selected_logistics";
    case "summary":
      return "publish_summary";
    case "route":
      return "validate_route";
    default:
      return null;
  }
}
