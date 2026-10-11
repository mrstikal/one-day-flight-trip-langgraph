import { RESEARCH_DOMAINS } from "@odft/contracts";
import { latestResultPerDomain } from "@odft/domain";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 09 ranking (03 section 4): a serial node after the join.
 *
 * It reads the newest usable result per domain, re-filters and re-orders the
 * candidates deterministically against the active snapshot through the ranking
 * port, persists the recommendation artifacts with their input fingerprints,
 * and reduces the result to safe ids in graph state. The deterministic order is
 * binding; an optional bounded recommendation-role reorder may only permute the
 * supplied ids (see `acceptRecommendationReorder`).
 */
export async function rankRecommendationsNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const latest = latestResultPerDomain(state.researchResults);
  const candidates = RESEARCH_DOMAINS.flatMap((domain) => {
    if (domain === "events") {
      return [];
    }
    const result = latest[domain];
    if (!result || result.status !== "ok" || result.artifactId === null) {
      return [];
    }
    return [
      {
        domain: result.domain,
        artifactId: result.artifactId,
        inputFingerprint: result.fingerprint,
        offerIds: result.offerIds,
      },
    ];
  });

  const ranked = await ports.rankRecommendations({
    tripId: state.tripId,
    operationId: state.operationId,
    domains: candidates,
  });

  const statuses = RESEARCH_DOMAINS.map((domain) => latest[domain]?.status).filter(
    (status) => status !== undefined,
  );
  return {
    hotelOfferIds: ranked.hotelOfferIds,
    mealOfferIds: {
      breakfast: ranked.mealOfferIds.breakfast,
      lunch: ranked.mealOfferIds.lunch,
      dinner: ranked.mealOfferIds.dinner,
    },
    activityIds: ranked.activityIds,
    programDefaults: ranked.mealDefaults,
    dinnerNotIncludedReason: ranked.dinnerNotIncludedReason,
    researchStatus:
      statuses.length === RESEARCH_DOMAINS.length && statuses.every((status) => status === "ok")
        ? "ok"
        : "partial",
  };
}

/** Router after ranking: the pending decision kind decides whether to prepare. */
export function routeAfterRank(state: TravelState): string {
  if (
    state.nextDecisionKind === "hotel_choice" ||
    state.nextDecisionKind === "program_choices" ||
    state.nextDecisionKind === "recovery"
  ) {
    return "prepare_decision";
  }
  return "publish_summary";
}