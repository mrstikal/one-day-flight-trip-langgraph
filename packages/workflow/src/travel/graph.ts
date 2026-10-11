import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { TRAVEL_GRAPH_VERSION, travelStateSchema, type TravelState } from "./state.js";
import { loadContextNode } from "../nodes/load-context.js";
import { applyCommandsNode } from "../nodes/apply-commands.js";
import { validateRouteNode } from "../nodes/validate-route.js";
import { generateFlightsNode } from "../nodes/generate-flights.js";
import { validateSchedulesNode } from "../nodes/validate-schedules.js";
import { prepareDecisionNode } from "../nodes/prepare-decision.js";
import { awaitDecisionNode } from "../nodes/await-decision.js";
import { applyDecisionNode } from "../nodes/apply-decision.js";
import { stageSelectionNode } from "../nodes/stage-selection.js";
import { commitBookingNode } from "../nodes/commit-booking.js";
import { publishSummaryNode } from "../nodes/publish-summary.js";

/**
 * Production travel graph (Phase 06 section 6).
 *
 * START -> load_context -> apply_commands -> validate_route ->
 *   (FEASIBLE) generate_flights -> validate_schedules ->
 *     (VALID) prepare_decision -> await_decision -> apply_decision ->
 *       choose_offer -> stage_selection -> prepare_decision -> await_decision
 *       confirm_booking -> commit_booking -> publish_summary -> END
 *       otherwise -> publish_summary -> END
 *   (rejected / no schedule) -> publish_summary -> END
 *
 * Stage A/B validation is independent and deterministic; the graph never calls
 * an LLM. Domain truth is read and written through the invocation ports.
 */

export function routeAfterValidation(state: TravelState): string {
  return state.routeStatus === "FEASIBLE" ? "generate_flights" : "publish_summary";
}

export function routeAfterGeneration(state: TravelState): string {
  return state.snapshotId ? "validate_schedules" : "publish_summary";
}

export function routeAfterSchedules(state: TravelState): string {
  return state.scheduleStatus === "VALID" ? "prepare_decision" : "publish_summary";
}

export function routeAfterApplyDecision(state: TravelState): string {
  switch (state.pendingStage) {
    case "stage":
      return "stage_selection";
    case "commit":
      return "commit_booking";
    default:
      return "publish_summary";
  }
}

export interface BuildTravelGraphOptions {
  readonly checkpointer: BaseCheckpointSaver;
}

export function buildTravelGraph(options: BuildTravelGraphOptions) {
  const builder = new StateGraph(travelStateSchema)
    .addNode("load_context", loadContextNode)
    .addNode("apply_commands", applyCommandsNode)
    .addNode("validate_route", validateRouteNode)
    .addNode("generate_flights", generateFlightsNode)
    .addNode("validate_schedules", validateSchedulesNode)
    .addNode("prepare_decision", prepareDecisionNode)
    .addNode("await_decision", awaitDecisionNode)
    .addNode("apply_decision", applyDecisionNode)
    .addNode("stage_selection", stageSelectionNode)
    .addNode("commit_booking", commitBookingNode)
    .addNode("publish_summary", publishSummaryNode)
    .addEdge(START, "load_context")
    .addEdge("load_context", "apply_commands")
    .addEdge("apply_commands", "validate_route")
    .addConditionalEdges("validate_route", routeAfterValidation, [
      "generate_flights",
      "publish_summary",
    ])
    .addConditionalEdges("generate_flights", routeAfterGeneration, [
      "validate_schedules",
      "publish_summary",
    ])
    .addConditionalEdges("validate_schedules", routeAfterSchedules, [
      "prepare_decision",
      "publish_summary",
    ])
    .addEdge("prepare_decision", "await_decision")
    .addEdge("await_decision", "apply_decision")
    .addConditionalEdges("apply_decision", routeAfterApplyDecision, [
      "stage_selection",
      "commit_booking",
      "publish_summary",
    ])
    .addEdge("stage_selection", "prepare_decision")
    .addEdge("commit_booking", "publish_summary")
    .addEdge("publish_summary", END);

  return builder.compile({ checkpointer: options.checkpointer });
}

export { TRAVEL_GRAPH_VERSION };
