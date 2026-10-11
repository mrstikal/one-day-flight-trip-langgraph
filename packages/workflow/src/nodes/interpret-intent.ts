import { InvalidUpdateError } from "@langchain/langgraph";
import { fingerprint } from "@odft/domain";
import type { DomainCommand } from "@odft/contracts";
import type { TravelState, TravelUpdate } from "../travel/state.js";
import { travelPorts } from "../travel/runtime.js";

/**
 * Phase 08 intent pipeline (07-conversation-and-intents.md sections 1-5).
 *
 * `interpret_intent` runs the configured intent role, then feeds the validated
 * result into the SAME deterministic command dispatcher the graphical controls
 * use. A clarification opens the shared interrupt; a chosen option applies its
 * stored command list; a free-text follow-up re-enters through the worker-built
 * internal `modify` branch. No model output can confirm, cancel, or book.
 */

function routingFor(commands: readonly DomainCommand[]): {
  commandType: string;
  commandPayload: unknown;
  submittedMealSelections?: TravelUpdate["submittedMealSelections"];
  submittedActivityIds?: string[];
} {
  const program = commands.find((command) => command.type === "set_program");
  if (program && program.type === "set_program") {
    return {
      commandType: "set_program",
      commandPayload: program,
      submittedMealSelections: program.mealOfferIds,
      submittedActivityIds: program.preferredActivityIds,
    };
  }
  const proposal = commands.find((command) => command.type === "propose_selection");
  if (proposal) {
    return { commandType: "propose_selection", commandPayload: proposal };
  }
  return { commandType: "chat_applied", commandPayload: null };
}

async function applyCommands(
  state: TravelState,
  runtime: unknown,
  commands: readonly DomainCommand[],
  effectNode: string,
): Promise<TravelUpdate> {
  const ports = travelPorts(runtime);
  for (const [index, command] of commands.entries()) {
    await ports.runEffect(effectNode, `${index}:${command.type}`, () =>
      ports.applyCommand({ tripId: state.tripId, operationId: state.operationId, command }),
    );
  }
  return routingFor(commands);
}

export async function interpretIntentNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  if (!state.chatMessage) {
    return {};
  }
  const ports = travelPorts(runtime);
  const { result } = await ports.interpretIntent({
    tripId: state.tripId,
    operationId: state.operationId,
    message: state.chatMessage,
  });

  if (result.kind === "unsupported") {
    await ports.appendAssistantMessage({
      tripId: state.tripId,
      operationId: state.operationId,
      content: result.explanation,
      interpretation: { kind: "unsupported", interpretation: result.explanation },
    });
    return {
      intentStatus: "unsupported",
      intentInterpretation: result.explanation,
      gate: "chat_done",
      pendingStage: "end",
    };
  }

  if (result.kind === "clarification") {
    await ports.appendAssistantMessage({
      tripId: state.tripId,
      operationId: state.operationId,
      content: result.question,
      interpretation: {
        kind: "clarification",
        question: result.question,
        preserve: result.preserve,
        options: result.options.map((option) => ({ id: option.id, label: option.label })),
      },
    });
    return {
      intentStatus: "clarification",
      clarificationQuestion: result.question,
      clarificationOptions: result.options,
      clarificationRequestedCommands: result.requestedCommands,
      intentPreserve: result.preserve,
      nextDecisionKind: "clarification",
      decisionFingerprint: fingerprint({
        kind: "clarification",
        tripId: state.tripId,
        operationId: state.operationId,
        question: result.question,
        options: result.options.map((option) => option.id),
      }),
      gate: "clarification",
      pendingStage: null,
    };
  }

  const routing = await applyCommands(state, runtime, result.commands, "interpret_intent");
  await ports.appendAssistantMessage({
    tripId: state.tripId,
    operationId: state.operationId,
    content: `${result.interpretation} No confirmed reservation was changed.`,
    interpretation: {
      kind: "commands",
      interpretation: result.interpretation,
      preserve: result.preserve,
    },
  });
  return {
    ...routing,
    intentStatus: "commands",
    intentInterpretation: result.interpretation,
    intentPreserve: result.preserve,
  };
}

/** Apply the command list bound to the chosen clarification option. */
export async function resolveClarificationNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  const option = state.clarificationOptions.find((candidate) => candidate.id === state.lastOptionId);
  if (!option) {
    throw new InvalidUpdateError("the chosen clarification option is no longer offered");
  }
  const ports = travelPorts(runtime);
  const routing = await applyCommands(state, runtime, option.commands, "resolve_clarification");
  await ports.appendAssistantMessage({
    tripId: state.tripId,
    operationId: state.operationId,
    content: `Applied: ${option.label}. No confirmed reservation was changed.`,
    interpretation: { kind: "commands", interpretation: option.label },
  });
  return {
    ...routing,
    intentStatus: "commands",
    intentInterpretation: option.label,
    clarificationQuestion: null,
    clarificationOptions: [],
    clarificationRequestedCommands: [],
  };
}

/** Load the free-text follow-up admitted while a clarification was pending. */
export async function interpretModificationNode(
  state: TravelState,
  runtime: unknown,
): Promise<TravelUpdate> {
  if (!state.modificationOperationId) {
    throw new InvalidUpdateError("a modification requires an admitted command operation");
  }
  const ports = travelPorts(runtime);
  const message = await ports.loadChatMessage(state.modificationOperationId);
  if (!message) {
    throw new InvalidUpdateError("the modification operation carries no chat message");
  }
  return {
    chatMessage: message,
    // Effects belong to the new admitted operation, not the old checkpoint id.
    operationId: state.modificationOperationId,
    intentStatus: "pending",
    clarificationQuestion: null,
    clarificationOptions: [],
  };
}
