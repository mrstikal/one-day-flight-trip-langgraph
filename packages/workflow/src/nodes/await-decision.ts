import { interrupt, InvalidUpdateError } from "@langchain/langgraph";
import { graphResumeEnvelopeSchema, type DecisionKind } from "@odft/contracts";
import type { TravelState, TravelUpdate } from "../travel/state.js";

/**
 * The single interrupt node. It pauses for the current decision, then validates
 * the trusted resume envelope against the offered options/offers and forwards
 * the new operation identity to the downstream nodes.
 */
export async function awaitDecisionNode(state: TravelState): Promise<TravelUpdate> {
  const kind: DecisionKind = state.decisionKind ?? "clarification";
  const resume = interrupt(
    {
      kind,
      allowedOptionIds: [] as string[],
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

  if (kind === "flight_choice") {
    if (response.action !== "choose_offer" || !state.allowedOfferIds.includes(response.offerId)) {
      throw new InvalidUpdateError("flight choice must select one of the offered combinations");
    }
    return { ...base, lastAction: "choose_offer", lastOfferId: response.offerId };
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
      return { ...base, lastAction: "reject_proposal", gate: "withdrawn" };
    }
    throw new InvalidUpdateError("booking confirmation accepts confirm_booking or reject_proposal");
  }
  return { ...base, lastAction: response.action };
}
