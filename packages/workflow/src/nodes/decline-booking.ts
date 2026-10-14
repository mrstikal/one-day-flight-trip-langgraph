import { InvalidUpdateError } from "@langchain/langgraph";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * "I don't want to book" (Phase 12): decline the simulated reservation for the
 * staged flight or hotel offer while keeping that offer as a persisted
 * selection. No reservation is created; the plan treats the service exactly as
 * if it existed (costs, airport buffer, hotel anchor) and the overviews mark it
 * "Not booked" so it can still be booked later.
 */
export async function declineBookingNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const service = state.bookingService;
  if (service !== "flights" && service !== "hotel") {
    throw new InvalidUpdateError("only a flight or hotel booking can be declined");
  }
  const proposalId = state.lastProposalId ?? state.proposalId;
  if (!proposalId || !state.lastDecisionId) {
    throw new InvalidUpdateError("decline_booking requires the staged proposal and its decision");
  }
  const ports = travelPorts(runtime);
  // The domain service is keyed by `(operation, proposal)` and returns the stored
  // result on a replay, so a declined booking is recorded exactly once.
  const result = await ports.declineBooking({
    tripId: state.tripId,
    operationId: state.operationId,
    proposalId,
    decisionId: state.lastDecisionId,
  });
  if (result.serviceKey !== service) {
    throw new InvalidUpdateError("the declined proposal does not match the booked service");
  }
  const progress = await ports.loadProgress(state.tripId);
  const hotelSettled = progress.hotelConfirmed || progress.selectedServices.includes("hotel");
  // A declined booking during the initial flow continues to the next step; once
  // the program is applied the trip is already planned, so declining a late
  // booking simply keeps the selection and ends the run.
  const nextDecisionKind = progress.programApplied
    ? null
    : service === "flights"
      ? hotelSettled
        ? "program_choices"
        : "hotel_choice"
      : "program_choices";
  return {
    gate: "pending",
    bookingService: service,
    pendingReplacement: false,
    hasConfirmedFlight: progress.flightConfirmed,
    hasConfirmedHotel: progress.hotelConfirmed,
    confirmedServices: [...progress.confirmedServices],
    selectedServices: [...progress.selectedServices],
    nextDecisionKind,
  };
}
