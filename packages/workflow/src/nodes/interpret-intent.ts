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
 * use. The whole batch is applied atomically: a command that cannot be honored
 * leaves none of the batch applied, and no command executes before a clarification
 * is answered. Assistant wording is persisted by the driver only AFTER the
 * operation result is committed. No model output can confirm, cancel, or book.
 */

/** Commands whose execution continues in a dedicated graph stage. */
const ROUTING_COMMANDS = ["set_program", "propose_selection"] as const;

function isRoutingCommand(command: DomainCommand): boolean {
  return (ROUTING_COMMANDS as readonly string[]).includes(command.type);
}

/**
 * Deterministic application order: the commands that can be refused (route change
 * after a confirmed reservation, program selection) run first, so a refusal never
 * leaves earlier preference writes behind. The batch itself is one transaction.
 */
export function orderCommandsForApplication(
  commands: readonly DomainCommand[],
): DomainCommand[] {
  const rank = (command: DomainCommand): number => {
    if (command.type === "set_route") return 0;
    if (command.type === "set_program") return 1;
    if (command.type === "propose_selection") return 2;
    if (command.type === "set_simulation") return 3;
    return 4;
  };
  return [...commands]
    .map((command, index) => ({ command, index }))
    .sort((a, b) => rank(a.command) - rank(b.command) || a.index - b.index)
    .map((entry) => entry.command);
}

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
): Promise<{ routing: ReturnType<typeof routingFor>; appliedCount: number }> {
  const ports = travelPorts(runtime);
  const ordered = orderCommandsForApplication(commands);
  const result = await ports.runEffect(effectNode, `batch:${ordered.length}`, () =>
    ports.applyCommands({
      tripId: state.tripId,
      operationId: state.operationId,
      commands: ordered,
    }),
  );
  return { routing: routingFor(commands), appliedCount: result.appliedCount };
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
    return {
      intentStatus: "unsupported",
      intentInterpretation: result.explanation,
      gate: "chat_done",
      pendingStage: "end",
    };
  }

  if (result.kind === "clarification") {
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

  // More than one command that continues in its own stage cannot all run in one
  // pass: ask which one to do first instead of silently dropping the others.
  const routingCommands = result.commands.filter(isRoutingCommand);
  if (routingCommands.length > 1) {
    const others = result.commands.filter((command) => !isRoutingCommand(command));
    const options = routingCommands.slice(0, 4).map((command, index) => ({
      id: `opt_${index + 1}`,
      label:
        command.type === "set_program"
          ? "Apply the selected meals and activities first"
          : `Start the ${command.type === "propose_selection" ? command.service : "service"} selection first`,
      commands: [...others, command],
    }));
    if (options.length >= 2) {
      return {
        intentStatus: "clarification",
        clarificationQuestion: "This request contains several steps. Which one should I start with?",
        clarificationOptions: options,
        clarificationRequestedCommands: result.commands,
        intentPreserve: result.preserve,
        nextDecisionKind: "clarification",
        decisionFingerprint: fingerprint({
          kind: "clarification",
          tripId: state.tripId,
          operationId: state.operationId,
          question: "multiple_steps",
          options: options.map((option) => option.id),
        }),
        gate: "clarification",
        pendingStage: null,
      };
    }
  }

  const { routing, appliedCount } = await applyCommands(
    state,
    runtime,
    result.commands,
    "interpret_intent",
  );
  // A search-only request (find_alternatives) changes nothing yet: report the
  // limitation instead of re-deriving decisions as if the search had run.
  if (appliedCount === 0 && result.commands.some((command) => command.type === "find_alternatives")) {
    return {
      intentStatus: "search_pending",
      intentInterpretation: result.interpretation,
      intentPreserve: result.preserve,
      gate: "chat_done",
      pendingStage: "end",
    };
  }
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
  const { routing, appliedCount } = await applyCommands(
    state,
    runtime,
    option.commands,
    "resolve_clarification",
  );
  return {
    ...routing,
    intentStatus: appliedCount === 0 && option.commands.some((c) => c.type === "find_alternatives")
      ? "search_pending"
      : "commands",
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
