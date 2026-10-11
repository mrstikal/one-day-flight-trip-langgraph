import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 07: read the confirmed flight/hotel progress so a preference change (or a
 * new command) resumes at the relevant step instead of restarting the flight
 * flow. With a confirmed flight but no hotel it re-derives hotel offers; with both
 * it re-derives program choices. With no confirmed flight it runs the normal
 * feasibility flow.
 */
export async function detectProgressNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const progress = await ports.loadProgress(state.tripId);
  const nextDecisionKind = progress.flightConfirmed
    ? progress.hotelConfirmed
      ? "program_choices"
      : "hotel_choice"
    : "flight_choice";
  return {
    hasConfirmedFlight: progress.flightConfirmed,
    hasConfirmedHotel: progress.hotelConfirmed,
    nextDecisionKind,
  };
}
