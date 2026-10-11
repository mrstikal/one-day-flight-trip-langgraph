import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * First serial node: confirm the trip exists and reset any state left over from a
 * previous completed run on the same thread. LangGraph keeps the checkpoint's
 * channel values when a new input starts at START, so without this reset a new
 * command would inherit the previous decision/proposal/reservation and could open
 * a stale `booking_confirmation` instead of a fresh `flight_choice`.
 */
export async function loadContextNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const context = await ports.loadTrip(state.tripId);
  if (!context) {
    throw new Error(`trip ${state.tripId} was not found while loading graph context`);
  }
  return {
    tripLoaded: true,
    // Stage A / generation / Stage B
    routeStatus: "PENDING",
    routeValidationId: null,
    routeFingerprint: null,
    routeReasons: [],
    routeAlternatives: [],
    scenarioKey: null,
    snapshotId: null,
    scheduleValidationId: null,
    scheduleStatus: "PENDING",
    validCombinationIds: [],
    // Pending decision
    decisionKind: null,
    nextDecisionKind: "flight_choice",
    decisionFingerprint: null,
    proposalId: null,
    allowedOfferIds: [],
    // Decision results
    selectedOfferId: null,
    lastAction: null,
    lastOfferId: null,
    lastProposalId: null,
    lastDecisionId: null,
    // Booking
    reservationId: null,
    demoReference: null,
    pendingStage: null,
    gate: "pending",
    lastOutcome: null,
  };
}
