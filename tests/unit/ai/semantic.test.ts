import { describe, expect, it } from "vitest";
import type { IntentResult } from "@odft/contracts";
import { validateIntentSemantics, type AuthorizedIntentContext } from "@odft/ai";

/**
 * Deterministic semantic validation: membership, duplicate writes, and preserve
 * conflicts convert a command result into a clarification before execution.
 */

const context: AuthorizedIntentContext = {
  knownCityIds: ["geonames:3169070"],
  knownAirportIds: ["ourairports:1", "ourairports:2"],
  knownOfferIds: ["offer-1", "offer-2"],
  currentActivityCounts: { museum: 1 },
};

function commands(result: IntentResult) {
  if (result.kind !== "commands") {
    throw new Error(`expected commands, got ${result.kind}`);
  }
  return result.commands;
}

describe("intent semantic validation", () => {
  it("passes through a supported preference command", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_activity_pace", pace: "relaxed" }],
        preserve: ["flights", "hotel"],
        interpretation: "Use a relaxed pace.",
      },
      context,
    );
    expect(result.kind).toBe("commands");
    expect(commands(result)).toHaveLength(1);
  });

  it("turns a preserve conflict into a clarification with two options", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_service_override", service: "dinner", level: "luxury" }],
        preserve: ["dinner"],
        interpretation: "Luxury dinner, keep dinner as-is.",
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options).toHaveLength(2);
      expect(result.options.map((option) => option.id)).toEqual(["keep_preserved", "apply_change"]);
      expect(result.requestedCommands).toHaveLength(1);
    }
  });

  it("turns duplicate writes to the same field into a clarification", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [
          { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
          { type: "set_activity_requirement", tag: "museum", minimumCount: 4 },
        ],
        preserve: [],
        interpretation: "Conflicting museum counts.",
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options[0]?.commands).toEqual([
        { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
      ]);
    }
  });

  it("rejects a foreign reference (unknown city) with a clarification", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "set_route", destinationCityId: "geonames:999999" }],
        preserve: [],
        interpretation: "Go to an invented city.",
      },
      context,
    );
    expect(result.kind).toBe("clarification");
  });

  it("rejects a foreign offer for propose_selection with a real alternative search", () => {
    const result = validateIntentSemantics(
      {
        kind: "commands",
        commands: [{ type: "propose_selection", service: "hotel", offerId: "offer-999" }],
        preserve: [],
        interpretation: "Book an invented offer.",
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options[1]?.label).toBe("Review supported alternatives");
      expect(result.options[1]?.commands).toContainEqual({
        type: "find_alternatives",
        target: "hotel",
        objective: "match_preferences",
      });
    }
  });

  it("regenerates opaque option ids and drops options with foreign refs", () => {
    const result = validateIntentSemantics(
      {
        kind: "clarification",
        question: "Which?",
        requestedCommands: [],
        preserve: [],
        options: [
          {
            id: "model-supplied",
            label: "Foreign",
            commands: [{ type: "propose_selection", service: "hotel", offerId: "offer-999" }],
          },
          { id: "b", label: "Pace", commands: [{ type: "set_activity_pace", pace: "relaxed" }] },
          { id: "c", label: "Intensive", commands: [{ type: "set_activity_pace", pace: "intensive" }] },
        ],
      },
      context,
    );
    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.options.map((option) => option.id)).toEqual(["opt_1", "opt_2"]);
      expect(result.options.every((option) => !option.id.includes("model-supplied"))).toBe(true);
    }
  });

  it("converts an empty command list into an unsupported result", () => {
    const result = validateIntentSemantics(
      { kind: "commands", commands: [], preserve: [], interpretation: "nothing" },
      context,
    );
    expect(result.kind).toBe("unsupported");
  });
});
