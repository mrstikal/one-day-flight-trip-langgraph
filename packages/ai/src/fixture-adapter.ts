import type { AIRole, BookableKey, ModelFacingCommand, ModelFacingIntentResult } from "@odft/contracts";
import type { IntentContext } from "./context/compact-context.js";
import type {
  LLMAdapter,
  StructuredRequest,
  StructuredResponse,
} from "./adapter.js";
import { AdapterError } from "./adapter.js";
import type { PlannerContext, RecommendationContext } from "./context/role-contexts.js";

/**
 * Deterministic, credentials-free fixture adapter
 * (06-ai-agent-design.md section 10).
 *
 * Fixture invocations never touch the network. Their counters are tracked
 * separately from real tokens/cost: `billableCalls` is always zero, and no
 * fixture answer is ever presented as a genuine model response.
 */

export interface FixtureCounters {
  calls: number;
  byRole: Record<AIRole, number>;
}

const WORD_COUNTS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

function parseCount(text: string): number | undefined {
  const digit = text.match(/\b([1-7])\b/);
  if (digit?.[1]) {
    return Number.parseInt(digit[1], 10);
  }
  for (const [word, value] of Object.entries(WORD_COUNTS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      return value;
    }
  }
  return undefined;
}

function museumCount(context: IntentContext): number {
  return context.currentActivityCounts.museum ?? 0;
}

/**
 * Deterministic scripted intent interpretation. Unknown input returns an
 * explicitly scripted limitation with the graphical controls still available.
 */
export function fixtureIntent(message: string, context: IntentContext): ModelFacingIntentResult {
  const text = message.toLowerCase();
  const currentMuseums = museumCount(context);

  const wantsRelaxed = /(less exhausting|less tiring|relaxed|slow(er)? pace|calm(er)?)/.test(text);
  const wantsIntensive = /(more intensive|intensive|packed|busy day|pack more)/.test(text);
  const museumsRequest = /museum/.test(text);
  const requestedMuseums = museumsRequest ? parseCount(text) : undefined;

  // Contradictory pace + museum count: ask a bounded clarification (P10 owns the
  // deterministic pace/count feasibility; the intent role must not silently drop it).
  if (wantsRelaxed && museumsRequest && requestedMuseums !== undefined && requestedMuseums >= 5) {
    return {
      kind: "clarification",
      question: `A relaxed day cannot fit ${requestedMuseums} major museums. What should I do?`,
      requestedCommands: [
        { type: "set_activity_requirement", tag: "museum", minimumCount: requestedMuseums },
      ],
      preserve: [],
      options: [
        {
          id: "relaxed_two",
          label: "Keep the relaxed pace with 2 museums",
          commands: [
            { type: "set_activity_pace", pace: "relaxed" },
            { type: "set_activity_requirement", tag: "museum", minimumCount: 2 },
          ],
        },
        {
          id: "denser_museums",
          label: `Use a moderate pace for ${requestedMuseums} museums`,
          commands: [
            { type: "set_activity_pace", pace: "moderate" },
            { type: "set_activity_requirement", tag: "museum", minimumCount: requestedMuseums },
          ],
        },
      ],
    };
  }

  if (/(confirm|book it|book the|pay|purchase|reserve it)/.test(text)) {
    if (context.selectedServices.length === 1) {
      const selected = context.selectedServices[0];
      if (selected && selected.service !== "activities" && selected.service !== "events") {
        return {
          kind: "commands",
          commands: [{ type: "propose_selection", service: selected.service, offerId: selected.offerId }],
          preserve: [],
          interpretation: "Open the existing selection for review; nothing is confirmed yet.",
        };
      }
    }
    if (context.selectedServices.length > 1) {
      const bookable = context.selectedServices.filter(
        (
          service,
        ): service is (typeof context.selectedServices)[number] & { service: BookableKey } =>
          service.service !== "activities" && service.service !== "events",
      );
      if (bookable.length >= 2) {
        return {
          kind: "clarification",
          question: "Which demo service should I open for review?",
          requestedCommands: [],
          preserve: [],
          options: bookable.slice(0, 4).map((service, index) => ({
            id: `review_${index + 1}`,
            label: `Review the ${service.service}`,
            commands: [
              { type: "propose_selection" as const, service: service.service, offerId: service.offerId },
            ],
          })),
        };
      }
    }
    return {
      kind: "unsupported",
      explanation:
        "I can't confirm or book anything from chat. Choose a service, then use the review and confirmation controls.",
    };
  }

  if (/(cheaper|lower price|less expensive|save money)/.test(text) && /hotel/.test(text)) {
    return {
      kind: "commands",
      commands: [{ type: "find_alternatives", target: "hotel", objective: "cheaper" }],
      preserve: ["flights", "breakfast", "lunch", "dinner", "activities", "events"],
      interpretation:
        "Marked for a lower-priced hotel search in your selected category; nothing changes until you review an alternative.",
    };
  }

  if (/(luxury|luxurious)/.test(text) && /dinner/.test(text)) {
    return {
      kind: "commands",
      commands: [{ type: "set_service_override", service: "dinner", level: "luxury" }],
      preserve: ["flights", "hotel", "breakfast", "lunch", "activities"],
      interpretation: "Show luxury dinner alternatives without changing your existing reservation.",
    };
  }

  if (/budget/.test(text) && /breakfast/.test(text)) {
    return {
      kind: "commands",
      commands: [{ type: "set_service_override", service: "breakfast", level: "budget" }],
      preserve: ["flights", "hotel", "lunch", "dinner", "activities"],
      interpretation: "Set a Budget breakfast preference; other services keep their levels.",
    };
  }

  if (/better hotel|nicer hotel|improve the hotel|upgrade the hotel/.test(text)) {
    return {
      kind: "clarification",
      question: "What matters most for a better hotel: location, rating, or a luxury category?",
      requestedCommands: [],
      preserve: ["flights", "breakfast", "lunch", "dinner", "activities"],
      options: [
        {
          id: "better_location",
          label: "Better location",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "better_location" }],
        },
        {
          id: "higher_rating",
          label: "Higher rating",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "higher_rating" }],
        },
        {
          id: "luxury_level",
          label: "A luxury category hotel",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "match_preferences", level: "luxury" }],
        },
      ],
    };
  }

  if (wantsRelaxed) {
    // A numeric museum request must never be silently dropped by a pace change.
    const commands: ModelFacingCommand[] = [{ type: "set_activity_pace", pace: "relaxed" }];
    if (museumsRequest && requestedMuseums !== undefined) {
      commands.push({
        type: "set_activity_requirement",
        tag: "museum",
        minimumCount: Math.min(7, Math.max(1, requestedMuseums)),
      });
    }
    return {
      kind: "commands",
      commands,
      preserve: ["flights", "hotel", "breakfast", "lunch", "dinner"],
      interpretation:
        commands.length > 1
          ? `Use a relaxed pace with at least ${requestedMuseums} museums; keep every booking and confirmed meal time.`
          : "Use a relaxed pace and keep every booking and confirmed meal time.",
    };
  }

  if (wantsIntensive) {
    return {
      kind: "commands",
      commands: [{ type: "set_activity_pace", pace: "intensive" }],
      preserve: ["flights", "hotel", "breakfast", "lunch", "dinner"],
      interpretation: "Use an intensive pace while keeping existing bookings.",
    };
  }

  if (museumsRequest && requestedMuseums !== undefined) {
    const absolute = Math.min(7, Math.max(1, requestedMuseums));
    return {
      kind: "commands",
      commands: [{ type: "set_activity_requirement", tag: "museum", minimumCount: absolute }],
      preserve: ["flights", "breakfast", "lunch", "dinner"],
      interpretation: `Require at least ${absolute} museums in the plan.`,
    };
  }

  if (museumsRequest && /(more|another|additional|extra)/.test(text)) {
    const absolute = Math.min(7, Math.max(1, currentMuseums + 1));
    return {
      kind: "commands",
      commands: [{ type: "set_activity_requirement", tag: "museum", minimumCount: absolute }],
      preserve: ["flights", "breakfast", "lunch", "dinner"],
      interpretation: `Require at least ${absolute} museums in the plan.`,
    };
  }

  if (/(park)/.test(text) && /(instead|rather|prefer)/.test(text)) {
    return {
      kind: "commands",
      commands: [
        { type: "set_activity_requirement", tag: "museum", minimumCount: null },
        {
          type: "set_interests",
          interests: { culture: 2, relaxation: 4, entertainment: 1 },
          preferredTags: ["park", "garden"],
        },
      ],
      preserve: ["flights", "hotel", "breakfast", "lunch", "dinner"],
      interpretation: "Prefer parks and gardens over another museum, keeping the bookings.",
    };
  }

  if (/(cheaper|budget|save money)/.test(text)) {
    return {
      kind: "clarification",
      question: "Which part should I search for a cheaper option: hotel, meals, or activities?",
      requestedCommands: [],
      preserve: ["flights"],
      options: [
        {
          id: "cheaper_hotel",
          label: "Cheaper hotel",
          commands: [{ type: "find_alternatives", target: "hotel", objective: "cheaper" }],
        },
        {
          id: "cheaper_meals",
          label: "Cheaper meals",
          commands: [{ type: "find_alternatives", target: "dinner", objective: "cheaper" }],
        },
        {
          id: "cheaper_activities",
          label: "Cheaper activities",
          commands: [{ type: "find_alternatives", target: "activities", objective: "cheaper" }],
        },
      ],
    };
  }

  return {
    kind: "unsupported",
    explanation:
      "This is a scripted fixture response. Use the listed demo requests or the graphical controls.",
  };
}

/** Deterministic fixture ranking: cheaper first, then by id (stable ordering). */
export function fixtureRecommendation(
  context: RecommendationContext,
): { rankedOfferIds: string[]; reasons: { offerId: string; explanation: string }[]; tradeoffs: string[] } {
  const ranked = [...context.candidates].sort(
    (a, b) => a.partyTotalMinor - b.partyTotalMinor || a.offerId.localeCompare(b.offerId),
  );
  return {
    rankedOfferIds: ranked.map((candidate) => candidate.offerId),
    reasons: ranked.slice(0, 5).map((candidate) => ({
      offerId: candidate.offerId,
      explanation: `Deterministic fixture ranking: party total ${candidate.partyTotalMinor} EUR minor units.`,
    })),
    tradeoffs: ranked.length > 1 ? ["Fixture ranking ignores qualitative preferences."] : [],
  };
}

/** Invalid first itinerary fixture for the Phase 10 repair test. */
export const FIXTURE_INVALID_FIRST_ITINERARY = {
  stops: [{ kind: "activity", refId: "invented-activity", startMinute: 100, durationMinutes: 30 }],
  explanation: "fixture: invented candidate id (must be rejected)",
  compromises: [],
} as const;

export function fixturePlanner(context: PlannerContext) {
  const stops = context.candidates.slice(0, 3).map((candidate, index) => ({
    kind: candidate.kind,
    refId: candidate.id,
    startMinute: 9 * 60 + index * 90,
    durationMinutes: candidate.durationMinutes,
  }));
  return { stops, explanation: "Deterministic fixture itinerary.", compromises: [] };
}

export function fixtureReviewer() {
  return { verdict: "acceptable" as const, issues: [], suggestedOrder: [], explanation: "Fixture review." };
}

export class FixtureAdapter implements LLMAdapter {
  private readonly counters: FixtureCounters = {
    calls: 0,
    byRole: { intent: 0, recommendation: 0, planner: 0, reviewer: 0 },
  };
  private readonly scriptedIntents: Record<string, ModelFacingIntentResult>;

  constructor(options: { readonly scriptedIntents?: Record<string, ModelFacingIntentResult> } = {}) {
    this.scriptedIntents = options.scriptedIntents ?? {};
  }

  get fixtureCounters(): FixtureCounters {
    return { calls: this.counters.calls, byRole: { ...this.counters.byRole } };
  }

  /** Fixture invocations are never billed as real tokens/cost. */
  get billableCalls(): number {
    return 0;
  }

  async generateObject<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.counters.calls += 1;
    this.counters.byRole[request.role] += 1;
    let value: unknown;
    switch (request.role) {
      case "intent": {
        const context = request.context as IntentContext;
        value = this.scriptedIntents[context.message] ?? fixtureIntent(context.message, context);
        break;
      }
      case "recommendation":
        value = fixtureRecommendation(request.context as RecommendationContext);
        break;
      case "planner":
        value = fixturePlanner(request.context as PlannerContext);
        break;
      case "reviewer":
        value = fixtureReviewer();
        break;
      default:
        throw new AdapterError("AI_UNSUPPORTED", `unknown role ${String(request.role)}`);
    }
    const parsed = request.outputSchema.safeParse(value);
    if (!parsed.success) {
      throw new AdapterError("AI_SCHEMA_INVALID", "fixture value does not match the role schema");
    }
    return {
      value: parsed.data,
      callId: `fixture-${this.counters.calls}`,
      model: "fixture",
      latencyMs: 0,
      attempts: 1,
      mode: "fixture",
    };
  }
}
