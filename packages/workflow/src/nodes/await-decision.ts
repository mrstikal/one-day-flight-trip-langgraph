import { interrupt, InvalidUpdateError } from "@langchain/langgraph";
import { graphResumeEnvelopeSchema, type DecisionKind } from "@odft/contracts";
import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * The single interrupt node (03-langgraph-design.md section 6). It pauses for the
 * current decision, validates the trusted resume envelope against the offered
 * options/offers, and forwards the new operation identity to downstream nodes.
 * It performs no side effects.
 */
export async function awaitDecisionNode(state: TravelState): Promise<TravelUpdate> {
  const kind: DecisionKind = state.decisionKind ?? "clarification";
  const resume = interrupt(
    {
      kind,
      allowedOptionIds: state.allowedOptionIds,
      allowedOfferIds: state.allowedOfferIds,
      proposalId: state.proposalId ?? undefined,
      sourceFingerprint: state.decisionFingerprint ?? undefined,
    },
    { responseSchema: graphResumeEnvelopeSchema },
  );
  const envelope = graphResumeEnvelopeSchema.parse(resume);
  const response = envelope.response;
  const base = {
    operationId: envelope.operationId,
    acceptedRevision: envelope.acceptedRevision,
    lastDecisionId: envelope.decisionId,
    decisionKind: null,
  } satisfies Partial<TravelUpdate>;

  if (kind === "flight_choice" || kind === "hotel_choice") {
    if (response.action !== "choose_offer" || !state.allowedOfferIds.includes(response.offerId)) {
      throw new InvalidUpdateError("the choice must select one of the offered ids");
    }
    return {
      ...base,
      lastAction: "choose_offer",
      lastOfferId: response.offerId,
      bookingService: kind === "hotel_choice" ? "hotel" : "flights",
    };
  }
  if (kind === "program_choices") {
    if (response.action !== "submit_program") {
      throw new InvalidUpdateError("program choices accept only submit_program");
    }
    const allowed = new Set(state.allowedOfferIds);
    const { breakfast, lunch, dinner } = response.mealOfferIds;
    if (!allowed.has(breakfast) || !allowed.has(lunch)) {
      throw new InvalidUpdateError("breakfast and lunch must be offered meal ids");
    }
    if (dinner !== null && !allowed.has(dinner)) {
      throw new InvalidUpdateError("the selected dinner is not an offered meal id");
    }
    const activityIds = new Set(state.allowedOptionIds);
    for (const activityId of response.preferredActivityIds) {
      if (!activityIds.has(activityId)) {
        throw new InvalidUpdateError("the selected activity is not an offered option");
      }
    }
    return {
      ...base,
      lastAction: "submit_program",
      submittedMealSelections: response.mealOfferIds,
      submittedActivityIds: response.preferredActivityIds,
    };
  }
  if (kind === "booking_confirmation") {
    if (response.action === "confirm_booking") {
      return {
        ...base,
        lastAction: "confirm_booking",
        lastProposalId: response.proposalId,
        selectedOfferId: state.selectedOfferId,
      };
    }
    if (response.action === "reject_proposal") {
      return { ...base, lastAction: "reject_proposal", lastProposalId: response.proposalId };
    }
    throw new InvalidUpdateError("booking confirmation accepts confirm_booking or reject_proposal");
  }
  return { ...base, lastAction: response.action };
}
