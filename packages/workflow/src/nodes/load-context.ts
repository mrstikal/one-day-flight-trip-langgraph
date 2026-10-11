import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/** First serial node: confirm the trip exists and load its live context. */
export async function loadContextNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  const context = await ports.loadTrip(state.tripId);
  if (!context) {
    throw new Error(`trip ${state.tripId} was not found while loading graph context`);
  }
  return { tripLoaded: true };
}
