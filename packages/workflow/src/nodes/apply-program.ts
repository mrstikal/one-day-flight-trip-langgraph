import { InvalidUpdateError } from "@langchain/langgraph";
import { fingerprint } from "@odft/domain";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 07: apply a `submit_program` selection deterministically. Compatible
 * unbooked meal selections are stored; a differing confirmed meal is staged as a
 * replacement proposal (never moved, removed, or re-keyed). The null dinner is
 * accepted only when research produced the deterministic no-slot result.
 */
export async function applyProgramNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const selections = state.submittedMealSelections;
  if (!selections) {
    throw new InvalidUpdateError("apply_program requires submitted meal selections");
  }
  const ports = travelPorts(runtime);
  const effectScope = fingerprint({
    mealSelections: selections,
    preferredActivityIds: [...state.submittedActivityIds].sort(),
  });
  const result = await ports.runEffect("apply_program", effectScope, () =>
    ports.applyProgram({
      tripId: state.tripId,
      operationId: state.operationId,
      mealSelections: selections,
      preferredActivityIds: state.submittedActivityIds,
    }),
  );
  return {
    programApplied: true,
    replacementStaged: result.replacementStaged,
    nextDecisionKind: null,
    gate: "program_ready",
  };
}
