import type {
  ActivityPace,
  ActivityTag,
  DomainCommand,
  ItineraryIssue,
  ItineraryMetrics,
  ItineraryReview,
} from "@odft/contracts";
import { DENSER_PACE, PACE_PROFILES } from "./taxonomy.js";
import { formatEur } from "./validate.js";

/**
 * Deterministic conflict decision builder (03-langgraph-design.md section 6,
 * Phase 10 section 5 steps 4-5).
 *
 * Budget conflicts stop the loop with lower-cost alternatives or a raise-budget
 * clarification and never downgrade automatically. Pace/time conflicts offer only
 * supported feasible options (reduce a minimum, change pace) and preserve the
 * typed numeric requirement inside an unexecuted clarification. A generic
 * exhaustion falls back to a recovery decision that re-opens the program.
 */

export interface ItineraryConflictOption {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly DomainCommand[];
}

export interface ItineraryConflictDecision {
  readonly kind: "clarification" | "recovery";
  readonly question: string | null;
  readonly options: readonly ItineraryConflictOption[];
  readonly recoveryOptionIds: readonly string[];
  /** Typed unexecuted commands preserving the original request. */
  readonly requestedCommands: readonly DomainCommand[];
}

export interface ItineraryConflictInput {
  readonly errors: readonly ItineraryIssue[];
  readonly metrics: ItineraryMetrics;
  readonly pace: ActivityPace;
  readonly minimumActivityCounts: Readonly<Partial<Record<ActivityTag, number>>>;
  readonly review: ItineraryReview | null;
}

export function buildItineraryConflictDecision(
  input: ItineraryConflictInput,
): ItineraryConflictDecision {
  const errorCodes = new Set(input.errors.map((error) => error.code));
  const totalCost = input.metrics.totalCostMinor;
  const budget = input.metrics.budgetMinor;

  if (errorCodes.has("budget_exceeded") && budget !== null) {
    return {
      kind: "clarification",
      question: `The plan totals EUR ${formatEur(totalCost)} for the party, above your EUR ${formatEur(budget)} budget. No price was changed and nothing was downgraded automatically. How should I proceed?`,
      options: [
        {
          id: "raise_budget",
          label: `Raise the budget to EUR ${formatEur(totalCost)}`,
          commands: [
            { type: "set_budget", maxBudgetMinor: totalCost },
            { type: "build_itinerary" },
          ],
        },
        {
          id: "keep_budget",
          label: "Keep the budget and review cheaper meals and activities",
          commands: [],
        },
      ],
      recoveryOptionIds: [],
      requestedCommands: [],
    };
  }

  const minimumEntries = Object.entries(input.minimumActivityCounts) as [
    ActivityTag,
    number | undefined,
  ][];
  const unmetTags = minimumEntries.filter(
    ([tag, minimum]) => (minimum ?? 0) > (input.metrics.activityTagCounts[tag] ?? 0),
  ) as [ActivityTag, number][];
  const visitExceeded = errorCodes.has("preference_conflict");
  const reviewConflict = input.review?.verdict === "conflict";
  const averageVisitMinutes =
    input.metrics.activityCount === 0
      ? 0
      : Math.ceil(input.metrics.visitMinutes / input.metrics.activityCount);

  if (unmetTags.length > 0 || visitExceeded || reviewConflict) {
    const profile = PACE_PROFILES[input.pace];
    const denser = DENSER_PACE[input.pace];
    const denserProfile = denser ? PACE_PROFILES[denser] : null;
    const options: ItineraryConflictOption[] = [];
    const requested: DomainCommand[] = [];

    const [limitingTag, requestedCount] = unmetTags[0] ?? [undefined, input.metrics.activityCount];
    if (limitingTag !== undefined && requestedCount !== undefined) {
      const placed = input.metrics.activityTagCounts[limitingTag] ?? 0;
      if (placed === 0) {
        // None of the requested tag was placed, so no reduction can be satisfied:
        // the only supported change is removing the impossible requirement.
        options.push({
          id: `clear_${limitingTag}`,
          label: `Remove the minimum ${limitingTag} requirement (no ${limitingTag} visits are available)`,
          commands: [
            { type: "set_activity_requirement", tag: limitingTag, minimumCount: null },
            { type: "build_itinerary" },
          ],
        });
      } else {
        // The reduction is bounded by what this very plan already placed, so the
        // offered count is always achievable.
        const denominator = Math.max(5, averageVisitMinutes || 5);
        const feasible = Math.min(
          placed,
          Math.max(1, Math.floor(profile.visitCapMinutes / denominator)),
        );
        options.push({
          id: `reduce_${limitingTag}`,
          label: `Keep the ${input.pace} pace and reduce the minimum ${limitingTag} visits to ${feasible}`,
          commands: [
            { type: "set_activity_requirement", tag: limitingTag, minimumCount: feasible },
            { type: "build_itinerary" },
          ],
        });
      }
      requested.push({
        type: "set_activity_requirement",
        tag: limitingTag,
        minimumCount: requestedCount,
      });
    }

    const requiredCount = Math.max(requestedCount ?? 0, input.metrics.activityCount);
    const tagAvailable =
      limitingTag === undefined || (input.metrics.activityTagCounts[limitingTag] ?? 0) > 0;
    if (
      denser &&
      denserProfile &&
      tagAvailable &&
      requiredCount > 0 &&
      requiredCount * Math.max(5, averageVisitMinutes || 5) <= denserProfile.visitCapMinutes
    ) {
      options.push({
        id: `denser_pace_${denser}`,
        label: `Use a ${denser} pace for ${requiredCount} visits`,
        commands: [{ type: "set_activity_pace", pace: denser }, { type: "build_itinerary" }],
      });
    }

    options.push({
      id: "review_program",
      label: "Keep my request for now and review meals and activities",
      commands: [],
    });

    // A clarification needs at least two options, and only supported feasible
    // options may be offered. When no supported change exists (e.g. a visit-cap
    // overrun the planner caused without any stored requirement), fall back to
    // the recovery decision instead of promising an impossible adjustment.
    if (options.length < 2) {
      return {
        kind: "recovery",
        question: null,
        options: [],
        recoveryOptionIds: ["change_meals", "change_hotel"],
        requestedCommands: requested,
      };
    }

    return {
      kind: "clarification",
      question:
        reviewConflict && input.review
          ? input.review.explanation
          : `The requested program cannot fit the ${input.pace} pace: ${input.errors
              .filter(
                (error) =>
                  error.code === "preference_conflict" ||
                  error.code === "unmet_minimum_activity_count",
              )
              .map((error) => error.message)
              .join(" ")}`,
      options,
      recoveryOptionIds: [],
      requestedCommands: requested,
    };
  }

  return {
    kind: "recovery",
    question: null,
    options: [],
    recoveryOptionIds: ["change_meals", "change_hotel"],
    requestedCommands: [],
  };
}