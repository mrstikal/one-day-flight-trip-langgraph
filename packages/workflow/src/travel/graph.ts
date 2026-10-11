import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { TRAVEL_GRAPH_VERSION, travelStateSchema, type TravelState } from "./state.js";
import { loadContextNode } from "../nodes/load-context.js";
import { applyCommandsNode } from "../nodes/apply-commands.js";
import { validateRouteNode } from "../nodes/validate-route.js";
import { generateFlightsNode } from "../nodes/generate-flights.js";
import { validateSchedulesNode } from "../nodes/validate-schedules.js";
import { ensureDomainsNode } from "../nodes/ensure-domains.js";
import { researchServicesNode } from "../nodes/research-services.js";
import { validateSelectedLogisticsNode } from "../nodes/validate-selected-logistics.js";
import { detectProgressNode } from "../nodes/detect-progress.js";
import { prepareDecisionNode } from "../nodes/prepare-decision.js";
import { awaitDecisionNode } from "../nodes/await-decision.js";
import { applyDecisionNode } from "../nodes/apply-decision.js";
import { stageSelectionNode } from "../nodes/stage-selection.js";
import { stageCommandProposalNode } from "../nodes/stage-command-proposal.js";
import { commitBookingNode } from "../nodes/commit-booking.js";
import { applyProgramNode } from "../nodes/apply-program.js";
import { publishSummaryNode } from "../nodes/publish-summary.js";

/**
 * Production travel graph (Phase 06-07).
 *
 * START -> load_context -> apply_commands ->
 *   propose_selection -> stage_command_proposal -> prepare_decision
 *   else -> validate_route -> (FEASIBLE) generate_flights -> validate_schedules
 *     -> (VALID) prepare_decision -> await_decision -> apply_decision ->
 *          choose_offer -> stage_selection -> prepare_decision ...
 *          confirm_booking -> commit_booking ->
 *              flights -> ensure_domains -> research_services -> prepare_decision ...
 *              else -> validate_selected_logistics -> ...
 *          submit_program -> apply_program -> validate_selected_logistics ->
 *              publish_summary -> END
 *     (rejected / no schedule) -> publish_summary -> END
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
  if (state.scheduleStatus !== "VALID") {
    return "publish_summary";
  }
  // After a Phase 07 domain extension the snapshot version changes, so the
  // schedule validation must be rebound before any non-flight confirmation.
  if (state.domainsEnsured && state.researchStatus === "pending") {
    return "research_services";
  }
  return "prepare_decision";
}

/** A `propose_selection` command skips feasibility and opens a confirmation; a
 * `set_program` command applies the program directly. Everything else first reads
 * the confirmed progress so a preference change resumes at the relevant step. */
export function routeAfterApplyCommands(state: TravelState): string {
  if (state.commandType === "propose_selection") {
    return "stage_command_proposal";
  }
  if (state.commandType === "set_program") {
    return "apply_program";
  }
  return "detect_progress";
}

/** With a confirmed flight, re-derive the non-flight steps; otherwise run feasibility. */
export function routeAfterDetectProgress(state: TravelState): string {
  return state.hasConfirmedFlight ? "ensure_domains" : "validate_route";
}

export function routeAfterApplyDecision(state: TravelState): string {
  switch (state.pendingStage) {
    case "stage":
      return "stage_selection";
    case "commit":
      return "commit_booking";
    case "program":
      return "apply_program";
    case "reselection":
      return "prepare_decision";
    default:
      return "publish_summary";
  }
}

/** After a confirmed booking: flights continue to hotel research, others to logistics. */
export function routeAfterCommit(state: TravelState): string {
  return state.bookingService === "flights" ? "ensure_domains" : "validate_selected_logistics";
}

/** After materialization, revalidate Stage B against the extended snapshot. */
export function routeAfterEnsureDomains(): string {
  return "validate_schedules";
}

/** After research, offer the hotel choice. */
export function routeAfterResearch(): string {
  return "prepare_decision";
}

/** Program application always runs the deterministic logistics check next. */
export function routeAfterApplyProgram(): string {
  return "validate_selected_logistics";
}

export function routeAfterLogistics(state: TravelState): string {
  if (state.logisticsStatus === "conflict") {
    return "prepare_decision";
  }
  if (
    state.nextDecisionKind === "program_choices" ||
    state.nextDecisionKind === "replacement_confirmation" ||
    state.nextDecisionKind === "recovery"
  ) {
    return "prepare_decision";
  }
  return "publish_summary";
}

export interface BuildTravelGraphOptions {
  readonly checkpointer: BaseCheckpointSaver;
}

export function buildTravelGraph(options: BuildTravelGraphOptions) {
  const builder = new StateGraph(travelStateSchema)
    .addNode("load_context", loadContextNode)
    .addNode("apply_commands", applyCommandsNode)
    .addNode("detect_progress", detectProgressNode)
    .addNode("validate_route", validateRouteNode)
    .addNode("generate_flights", generateFlightsNode)
    .addNode("validate_schedules", validateSchedulesNode)
    .addNode("ensure_domains", ensureDomainsNode)
    .addNode("research_services", researchServicesNode)
    .addNode("validate_selected_logistics", validateSelectedLogisticsNode)
    .addNode("prepare_decision", prepareDecisionNode)
    .addNode("await_decision", awaitDecisionNode)
    .addNode("apply_decision", applyDecisionNode)
    .addNode("stage_command_proposal", stageCommandProposalNode)
    .addNode("stage_selection", stageSelectionNode)
    .addNode("commit_booking", commitBookingNode)
    .addNode("apply_program", applyProgramNode)
    .addNode("publish_summary", publishSummaryNode)
    .addEdge(START, "load_context")
    .addEdge("load_context", "apply_commands")
    .addConditionalEdges("apply_commands", routeAfterApplyCommands, [
      "stage_command_proposal",
      "apply_program",
      "detect_progress",
    ])
    .addConditionalEdges("detect_progress", routeAfterDetectProgress, [
      "ensure_domains",
      "validate_route",
    ])
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
      "research_services",
      "publish_summary",
    ])
    .addEdge("prepare_decision", "await_decision")
    .addEdge("await_decision", "apply_decision")
    .addConditionalEdges("apply_decision", routeAfterApplyDecision, [
      "stage_selection",
      "commit_booking",
      "apply_program",
      "prepare_decision",
      "publish_summary",
    ])
    .addEdge("stage_command_proposal", "prepare_decision")
    .addEdge("stage_selection", "prepare_decision")
    .addConditionalEdges("commit_booking", routeAfterCommit, [
      "ensure_domains",
      "validate_selected_logistics",
    ])
    .addConditionalEdges("ensure_domains", routeAfterEnsureDomains, ["validate_schedules"])
    .addConditionalEdges("research_services", routeAfterResearch, ["prepare_decision"])
    .addConditionalEdges("apply_program", routeAfterApplyProgram, ["validate_selected_logistics"])
    .addConditionalEdges("validate_selected_logistics", routeAfterLogistics, [
      "prepare_decision",
      "publish_summary",
    ])
    .addEdge("publish_summary", END);

  return builder.compile({ checkpointer: options.checkpointer });
}

export { TRAVEL_GRAPH_VERSION };
