import { describe, expect, it } from "vitest";
import type { TravelState } from "../../packages/workflow/src/travel/state.js";
import { loadContextNode } from "../../packages/workflow/src/nodes/load-context.js";
import { applyDecisionNode } from "../../packages/workflow/src/nodes/apply-decision.js";
import { publishSummaryNode } from "../../packages/workflow/src/nodes/publish-summary.js";
import { prepareDecisionNode } from "../../packages/workflow/src/nodes/prepare-decision.js";
import {
  routeAfterApplyDecision,
  routeAfterSchedules,
  routeAfterValidation,
} from "../../packages/workflow/src/travel/graph.js";
import { isTerminalConflictCode } from "../../apps/worker/src/driver.js";

/** P1-3 / P2-6 / P2-9: travel-graph node behavior that has no DB dependency. */

function state(partial: Partial<TravelState>): TravelState {
  return partial as TravelState;
}

describe("load_context reset (P1-3)", () => {
  it("clears prior-run decision/booking state for a new run on the same thread", async () => {
    const runtime = {
      context: { ports: { loadTrip: async () => ({ trip: { id: "t" } }) } },
    };
    const update = await loadContextNode(
      state({
        tripId: "t",
        decisionKind: "booking_confirmation",
        proposalId: "p",
        selectedOfferId: "o",
        decisionFingerprint: "f".repeat(64),
        reservationId: "r",
        demoReference: "DEMO-FLT-X",
        scheduleStatus: "VALID",
        validCombinationIds: ["o"],
        snapshotId: "s",
        gate: "booked",
        nextDecisionKind: "booking_confirmation",
      }),
      runtime,
    );
    expect(update.decisionKind).toBeNull();
    expect(update.proposalId).toBeNull();
    expect(update.selectedOfferId).toBeNull();
    expect(update.decisionFingerprint).toBeNull();
    expect(update.reservationId).toBeNull();
    expect(update.demoReference).toBeNull();
    expect(update.nextDecisionKind).toBe("flight_choice");
    expect(update.validCombinationIds).toEqual([]);
    expect(update.scheduleStatus).toBe("PENDING");
    expect(update.snapshotId).toBeNull();
    expect(update.gate).toBe("pending");
    expect(update.tripLoaded).toBe(true);
  });
});

describe("reject_proposal -> reselection (P2-6)", () => {
  it("returns to flight selection with the same combinations", () => {
    const update = applyDecisionNode(state({ lastAction: "reject_proposal" }));
    expect(update.pendingStage).toBe("reselection");
    expect(update.nextDecisionKind).toBe("flight_choice");
    expect(update.proposalId).toBeNull();
    expect(routeAfterApplyDecision(state({ pendingStage: "reselection" }))).toBe(
      "prepare_decision",
    );
  });

  it("confirm_booking commits, choose_offer stages", () => {
    expect(applyDecisionNode(state({ lastAction: "confirm_booking" })).pendingStage).toBe("commit");
    expect(applyDecisionNode(state({ lastAction: "choose_offer" })).pendingStage).toBe("stage");
  });
});

describe("publish_summary structured outcomes (P2-9)", () => {
  it("maps a rejected route and an empty schedule to blocked outcomes", () => {
    expect(publishSummaryNode(state({ gate: "route_rejected" })).lastOutcome).toBe(
      "no_feasible_route",
    );
    expect(publishSummaryNode(state({ gate: "no_schedule" })).lastOutcome).toBe(
      "no_feasible_schedule",
    );
    expect(publishSummaryNode(state({ gate: "booked" })).lastOutcome).toBe("success");
  });
});

describe("routers", () => {
  it("routes non-feasible routes and empty schedules to the summary", () => {
    expect(routeAfterValidation(state({ routeStatus: "INFEASIBLE" }))).toBe("publish_summary");
    expect(routeAfterValidation(state({ routeStatus: "FEASIBLE" }))).toBe("generate_flights");
    expect(routeAfterSchedules(state({ scheduleStatus: "NO_VALID_OFFERS" }))).toBe(
      "publish_summary",
    );
  });

  it("prepare_decision offers the validated combinations or the staged proposal", () => {
    const flight = prepareDecisionNode(
      state({ nextDecisionKind: "flight_choice", validCombinationIds: ["a", "b"] }),
    );
    expect(flight.decisionKind).toBe("flight_choice");
    expect(flight.allowedOfferIds).toEqual(["a", "b"]);
    const booking = prepareDecisionNode(
      state({ nextDecisionKind: "booking_confirmation", proposalId: "p", selectedOfferId: "a" }),
    );
    expect(booking.decisionKind).toBe("booking_confirmation");
    expect(booking.allowedOfferIds).toEqual(["a"]);
  });
});

describe("worker failure classification (P1-4)", () => {
  it("treats deterministic domain failures as terminal conflicts, not retries", () => {
    for (const code of [
      "PROPOSAL_EXPIRED",
      "STALE_DECISION",
      "STALE_ROUTE_APPROVAL",
      "REPLACEMENT_CONFIRMATION_REQUIRED",
      "OFFER_UNAVAILABLE",
      "REDUCER_CONFLICT",
    ]) {
      expect(isTerminalConflictCode(code)).toBe(true);
    }
    for (const code of ["Error", "QueryError", "UNKNOWN", "ECONNRESET"]) {
      expect(isTerminalConflictCode(code)).toBe(false);
    }
  });
});
