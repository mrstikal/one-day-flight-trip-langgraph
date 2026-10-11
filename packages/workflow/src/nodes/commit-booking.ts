import { InvalidUpdateError } from "@langchain/langgraph";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Commit the booked flight reservation exactly once. The domain service is
 * keyed by `(operation, proposal)` and returns the existing reservation on a
 * replay, so no duplicate `DEMO-FLT-` reference can be created.
 */
export async function commitBookingNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const proposalId = state.lastProposalId ?? state.proposalId;
  if (!proposalId || !state.lastDecisionId) {
    throw new InvalidUpdateError("commit_booking requires a proposal and a decision");
  }
  const ports = travelPorts(runtime);
  const result = await ports.confirm({
    tripId: state.tripId,
    operationId: state.operationId,
    proposalId,
    decisionId: state.lastDecisionId,
    acceptedRevision: state.acceptedRevision,
    confirmationKey: `confirm:${state.operationId}:${proposalId}`,
  });
  return {
    reservationId: result.reservationId,
    demoReference: result.demoReference,
    gate: "booked",
  };
}
