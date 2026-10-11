import {
  intentResultSchema,
  type ActivityTag,
  type ClarificationOption,
  type DomainCommand,
  type IntentResult,
  type ModelFacingIntentResult,
  type PreservableKey,
} from "@odft/contracts";

/**
 * Deterministic semantic validation of model intent output
 * (04-domain-model.md section 6 / 10-security section 6).
 *
 * A model result is a proposal: membership, duplicate/conflicting writes, and
 * `preserve` conflicts are checked here before any command executes. A conflict
 * converts the whole request into the clarification form before partial execution.
 */

export interface AuthorizedIntentContext {
  readonly knownCityIds: readonly string[];
  readonly knownAirportIds: readonly string[];
  readonly knownOfferIds: readonly string[];
  readonly currentActivityCounts: Partial<Record<ActivityTag, number>>;
}

/** Re-parse model output into the canonical persisted union (structural subset). */
export function toCanonicalIntentResult(result: ModelFacingIntentResult): IntentResult {
  return intentResultSchema.parse(result);
}

function writesKeys(command: DomainCommand): PreservableKey[] {
  switch (command.type) {
    case "set_route":
      return ["flights"];
    case "set_default_service_level":
      return ["hotel", "breakfast", "lunch", "dinner"];
    case "set_service_override":
      return [command.service];
    case "propose_selection":
      return [command.service];
    default:
      return [];
  }
}

function fieldKey(command: DomainCommand): string {
  switch (command.type) {
    case "set_route":
      return "set_route";
    case "set_default_service_level":
      return "set_default_service_level";
    case "set_service_override":
      return `set_service_override:${command.service}`;
    case "set_activity_pace":
      return "set_activity_pace";
    case "set_interests":
      return "set_interests";
    case "set_activity_requirement":
      return `set_activity_requirement:${command.tag}`;
    case "set_budget":
      return "set_budget";
    case "find_alternatives":
      return `find_alternatives:${command.target}`;
    case "propose_selection":
      return `propose_selection:${command.service}`;
    case "set_program":
      return "set_program";
    default:
      return command.type;
  }
}

function membershipIssue(
  command: DomainCommand,
  context: AuthorizedIntentContext,
): string | undefined {
  if (command.type === "set_route") {
    if (command.originAirportId && !context.knownAirportIds.includes(command.originAirportId)) {
      return `origin airport ${command.originAirportId} is not an admitted reference`;
    }
    if (command.destinationCityId && !context.knownCityIds.includes(command.destinationCityId)) {
      return `destination city ${command.destinationCityId} is not an admitted reference`;
    }
  }
  if (command.type === "propose_selection" && !context.knownOfferIds.includes(command.offerId)) {
    return `offer ${command.offerId} is not an authorized offer for this trip`;
  }
  return undefined;
}

function conflictToClarification(
  commands: DomainCommand[],
  preserve: PreservableKey[],
  question: string,
  options: ClarificationOption[],
): IntentResult {
  return intentResultSchema.parse({
    kind: "clarification",
    question,
    requestedCommands: commands,
    preserve,
    options: options.slice(0, 4),
  });
}

function optionLabelList(options: readonly string[]): string {
  return options.join(" and ");
}

/**
 * Validate a model-facing result against the authorized trip context.
 *
 * Returns the accepted canonical result, or a deterministic clarification when a
 * conflict is found. No command is executed here.
 */
export function validateIntentSemantics(
  raw: ModelFacingIntentResult,
  context: AuthorizedIntentContext,
): IntentResult {
  const result = toCanonicalIntentResult(raw);
  if (result.kind === "unsupported") {
    return result;
  }
  if (result.kind === "clarification") {
    return validateClarification(result, context);
  }

  const commands = result.commands;
  if (commands.length === 0) {
    return intentResultSchema.parse({
      kind: "unsupported",
      explanation: "No supported change was recognized; use the graphical controls.",
    });
  }

  // Membership: foreign references are rejected before domain execution.
  for (const command of commands) {
    const issue = membershipIssue(command, context);
    if (issue) {
      const kept = commands.filter((candidate) => candidate !== command);
      // Offer a real search when the offending command names a service; a route
      // conflict can only be resolved through the graphical controls.
      const alternatives: DomainCommand[] =
        command.type === "propose_selection" && command.service !== "flights"
          ? [
              ...kept,
              {
                type: "find_alternatives",
                target: command.service,
                objective: "match_preferences",
              },
            ]
          : kept;
      return conflictToClarification(
        commands,
        result.preserve,
        `${issue}. Keep the current choice, or review supported alternatives?`,
        [
          {
            id: "keep_current",
            label: "Keep the current choice",
            commands: kept,
          },
          {
            id: "search_alternatives",
            label:
              command.type === "propose_selection" && command.service !== "flights"
                ? "Review supported alternatives"
                : "Use the graphical controls instead",
            commands: alternatives,
          },
        ],
      );
    }
  }

  // Duplicate/conflicting writes to the same field.
  const byField = new Map<string, DomainCommand[]>();
  for (const command of commands) {
    const key = fieldKey(command);
    byField.set(key, [...(byField.get(key) ?? []), command]);
  }
  for (const [, group] of byField) {
    if (group.length > 1) {
      const first = group[0];
      const last = group[group.length - 1];
      if (!first || !last) {
        continue;
      }
      return conflictToClarification(
        commands,
        result.preserve,
        "The request sets the same preference twice. Which value should be kept?",
        [
          {
            id: "keep_first",
            label: "Keep the first value",
            commands: [first],
          },
          {
            id: "keep_last",
            label: "Keep the last value",
            commands: [last],
          },
        ],
      );
    }
  }

  // `preserve` conflicts: a command must not silently change a preserved service.
  for (const command of commands) {
    const written = writesKeys(command);
    const offending = written.filter((key) => result.preserve.includes(key));
    if (offending.length > 0) {
      const kept = commands.filter((candidate) => candidate !== command);
      return conflictToClarification(
        commands,
        result.preserve,
        `This request changes ${optionLabelList(offending)}, which you asked to keep. What should happen?`,
        [
          {
            id: "keep_preserved",
            label: `Keep ${optionLabelList(offending)} unchanged`,
            commands: kept,
          },
          {
            id: "apply_change",
            label: `Change ${optionLabelList(offending)} as requested`,
            commands: commands,
          },
        ],
      );
    }
  }

  return result;
}

function validateClarification(
  result: Extract<IntentResult, { kind: "clarification" }>,
  context: AuthorizedIntentContext,
): IntentResult {
  const sanitized: ClarificationOption[] = [];
  for (const option of result.options) {
    const valid = option.commands.every(
      (command) => membershipIssue(command, context) === undefined,
    );
    if (!valid) {
      continue;
    }
    sanitized.push({
      // Opaque server-side ids; model-provided ids are never authoritative.
      id: `opt_${sanitized.length + 1}`,
      label: option.label,
      commands: option.commands,
    });
  }
  if (sanitized.length < 2 || sanitized.length > 4) {
    return intentResultSchema.parse({
      kind: "unsupported",
      explanation:
        "The request could not be turned into two or more supported choices; use the graphical controls.",
    });
  }
  return intentResultSchema.parse({
    kind: "clarification",
    question: result.question,
    requestedCommands: result.requestedCommands,
    preserve: result.preserve,
    options: sanitized,
  });
}
