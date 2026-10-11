import { InvalidUpdateError } from "@langchain/langgraph";
import { domainCommandSchema } from "@odft/contracts";
import { fingerprint } from "@odft/domain";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 07: handle an admitted `propose_selection` command (used by the optional
 * per-meal RESERVE action and by assistant proposals). It stages the proposal and
 * opens the shared booking-confirmation decision. Confirmation remains an explicit
 * user decision; nothing here books.
 */
export async function stageCommandProposalNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const parsed = domainCommandSchema.safeParse(state.commandPayload);
  if (!parsed.success || parsed.data.type !== "propose_selection") {
    throw new InvalidUpdateError("stage_command_proposal requires a propose_selection command");
  }
  const { service, offerId } = parsed.data;
  const sourceFingerprint = fingerprint({
    kind: "booking_confirmation",
    tripId: state.tripId,
    operationId: state.operationId,
    service,
    offerId,
    snapshotId: state.snapshotId,
  });
  const ports = travelPorts(runtime);
  const proposal = await ports.propose({
    tripId: state.tripId,
    operationId: state.operationId,
    service,
    offerId,
    sourceFingerprint,
  });
  return {
    proposalId: proposal.proposalId,
    selectedOfferId: offerId,
    decisionFingerprint: sourceFingerprint,
    bookingService: service,
    nextDecisionKind: "booking_confirmation",
  };
}
