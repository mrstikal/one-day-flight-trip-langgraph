import { InvalidUpdateError } from "@langchain/langgraph";
import { fingerprint } from "@odft/domain";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Stage the flight selection as a review-only proposal and bind the upcoming
 * booking confirmation to it. The proposal's source fingerprint is derived
 * deterministically so the pending decision row and the proposal agree.
 */
export async function stageSelectionNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const offerId = state.lastOfferId ?? state.selectedOfferId;
  if (!offerId) {
    throw new InvalidUpdateError("stage_selection requires a chosen offer");
  }
  if (!state.validCombinationIds.includes(offerId)) {
    throw new InvalidUpdateError("chosen offer is not among the validated combinations");
  }
  const sourceFingerprint = fingerprint({
    kind: "booking_confirmation",
    tripId: state.tripId,
    operationId: state.operationId,
    offerId,
    snapshotId: state.snapshotId,
  });
  const ports = travelPorts(runtime);
  // `propose` is idempotent through its own effect ledger inside the booking
  // transaction, so it is called directly (never wrapped in a second effect).
  const proposal = await ports.propose({
    tripId: state.tripId,
    operationId: state.operationId,
    service: "flights",
    offerId,
    sourceFingerprint,
  });
  return {
    proposalId: proposal.proposalId,
    selectedOfferId: offerId,
    decisionFingerprint: sourceFingerprint,
    nextDecisionKind: "booking_confirmation",
  };
}
