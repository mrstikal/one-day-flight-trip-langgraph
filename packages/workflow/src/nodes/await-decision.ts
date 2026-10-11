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
      // Clarification option labels are persisted server-side for the projection.
      ...(kind === "clarification"
        ? {
            optionPayload: {
              question: state.clarificationQuestion,
              options: state.clarificationOptions.map((option) => ({
                id: option.id,
                label: option.label,
              })),
              // Server-side only (never rendered): the typed request the model
              // asked about, so a follow-up has the full authoritative context.
              requestedCommands: state.clarificationRequestedCommands,
              preserve: state.intentPreserve,
            },
          }
        : {}),
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
  if (kind === "booking_confirmation" || kind === "replacement_confirmation") {
    if (response.action === "confirm_booking") {
      return {
        ...base,
        lastAction: "confirm_booking",
        lastProposalId: response.proposalId,
        selectedOfferId: state.selectedOfferId,
        pendingReplacement: kind === "replacement_confirmation",
      };
    }
    if (response.action === "reject_proposal") {
      return { ...base, lastAction: "reject_proposal", lastProposalId: response.proposalId };
    }
    throw new InvalidUpdateError("booking confirmation accepts confirm_booking or reject_proposal");
  }
  if (kind === "recovery") {
    if (
      response.action !== "choose_option" ||
      !state.allowedOptionIds.includes(response.optionId)
    ) {
      throw new InvalidUpdateError("recovery accepts one of the offered options");
    }
    return { ...base, lastAction: "choose_option", lastOptionId: response.optionId };
  }
  if (kind === "clarification") {
    if (response.action === "choose_option") {
      if (!state.allowedOptionIds.includes(response.optionId)) {
        throw new InvalidUpdateError("the chosen clarification option is not offered");
      }
      return { ...base, lastAction: "choose_clarification", lastOptionId: response.optionId };
    }
    if (response.action === "modify") {
      // Worker-constructed only: a browser cannot supply an operation identity.
      return {
        ...base,
        lastAction: "modify",
        modificationOperationId: response.commandOperationId,
      };
    }
    throw new InvalidUpdateError("clarification accepts choose_option or a modify follow-up");
  }
  return { ...base, lastAction: response.action };
}
