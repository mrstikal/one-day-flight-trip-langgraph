import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 07: deterministic serial provider research over the active snapshot. The
 * ranked result is persisted (recommendation artifacts) and reduced to safe ids
 * in graph state. Phase 09 replaces this serial call with `Send` fan-out.
 */
export async function researchServicesNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const result = await ports.runEffect("research_services", "all", () =>
    ports.researchServices(state.tripId),
  );
  return {
    researchStatus: result.status,
    hotelOfferIds: result.hotelOfferIds,
    mealOfferIds: {
      breakfast: result.mealOfferIds.breakfast,
      lunch: result.mealOfferIds.lunch,
      dinner: result.mealOfferIds.dinner,
    },
    activityIds: result.activityIds,
    programDefaults: result.mealDefaults,
    dinnerNotIncludedReason: result.dinnerNotIncludedReason,
  };
}
