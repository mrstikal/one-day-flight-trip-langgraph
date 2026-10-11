import { chatCommandPayloadSchema, domainCommandSchema } from "@odft/contracts";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Apply the admitted command to the trip's route/preferences. A creation run
 * already persisted its route inputs, so it has nothing to apply here. The
 * effect ledger makes a crash-replay re-apply nothing (idempotent values).
 *
 * A chat request carries no direct command: it is forwarded to `interpret_intent`,
 * which runs the intent role and then feeds the same deterministic dispatcher.
 */
export async function applyCommandsNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  if (state.operationKind === "start") {
    return {};
  }
  const parsed = domainCommandSchema.safeParse(state.commandPayload);
  if (!parsed.success) {
    const chat = chatCommandPayloadSchema.safeParse(state.commandPayload);
    if (chat.success) {
      return { chatMessage: chat.data.message };
    }
    // Non-domain payloads (e.g. an unexpected shape) cannot mutate the trip.
    return {};
  }
  const ports = travelPorts(runtime);
  await ports.runEffect("apply_commands", parsed.data.type, () =>
    ports.applyCommands({
      tripId: state.tripId,
      operationId: state.operationId,
      commands: [parsed.data],
    }),
  );
  if (parsed.data.type === "set_program") {
    // Carry the admitted program payload into apply_program (a command is a
    // request, so it applies deterministically just like submit_program).
    return {
      submittedMealSelections: parsed.data.mealOfferIds,
      submittedActivityIds: parsed.data.preferredActivityIds,
    };
  }
  return {};
}
