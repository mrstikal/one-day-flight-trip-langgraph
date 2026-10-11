import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { TRAVEL_GRAPH_VERSION, travelStateSchema, type TravelState } from "./state.js";
import { loadContextNode } from "../nodes/load-context.js";
import { applyCommandsNode } from "../nodes/apply-commands.js";
import { validateRouteNode } from "../nodes/validate-route.js";
import { generateFlightsNode } from "../nodes/generate-flights.js";
import { validateSchedulesNode } from "../nodes/validate-schedules.js";
import { ensureDomainsNode } from "../nodes/ensure-domains.js";
import { dispatchResearchNode, routeAfterDispatch } from "../nodes/dispatch-research.js";
import { researchDomainNode } from "../nodes/research-domain.js";
import { joinResearchNode, routeAfterJoin } from "../nodes/join-research.js";
import { rankRecommendationsNode, routeAfterRank } from "../nodes/rank-recommendations.js";
import { validateSelectedLogisticsNode } from "../nodes/validate-selected-logistics.js";
import { detectProgressNode } from "../nodes/detect-progress.js";
import { prepareDecisionNode } from "../nodes/prepare-decision.js";
import { awaitDecisionNode } from "../nodes/await-decision.js";
import { applyDecisionNode } from "../nodes/apply-decision.js";
import { stageSelectionNode } from "../nodes/stage-selection.js";
import { stageCommandProposalNode } from "../nodes/stage-command-proposal.js";
import { commitBookingNode } from "../nodes/commit-booking.js";
import { applyProgramNode } from "../nodes/apply-program.js";
import {
  interpretIntentNode,
  interpretModificationNode,
  resolveClarificationNode,
} from "../nodes/interpret-intent.js";
import { publishSummaryNode } from "../nodes/publish-summary.js";
import { planItineraryNode } from "../nodes/plan-itinerary.js";
import { validateItineraryNode } from "../nodes/validate-itinerary.js";
import { reviewItineraryNode } from "../nodes/review-itinerary.js";
import { approveItineraryNode } from "../nodes/approve-itinerary.js";

/**
 * Production travel graph (Phase 06-10).
 *
 * START -> load_context -> apply_commands ->
 *   propose_selection -> stage_command_proposal -> prepare_decision
 *   build_itinerary -> plan_itinerary
 *   else -> validate_route -> (FEASIBLE) generate_flights -> validate_schedules
 *     -> (VALID) prepare_decision -> await_decision -> apply_decision ->
 *          choose_offer -> stage_selection -> prepare_decision ...
 *          confirm_booking -> commit_booking ->
 *              flights -> ensure_domains -> validate_schedules ->
 *                  dispatch_research -> Send research_domain x N ->
 *                      join_research -> (retry) dispatch_research
 *                                    -> (failed) prepare_decision
 *                                    -> rank_recommendations -> prepare_decision ...
 *              else -> validate_selected_logistics -> plan_itinerary
 *          submit_program -> apply_program -> validate_selected_logistics ->
 *              plan_itinerary -> validate_itinerary ->
 *                  (invalid, attempts < 3) plan_itinerary
 *                  (invalid at bound / budget) prepare_decision
 *                  (valid) review_itinerary ->
 *                      (revise, attempts < 3) plan_itinerary
 *                      (else) prepare_decision (itinerary_approval)
 *          approve_itinerary -> publish_summary -> END
 *     (rejected / no schedule) -> publish_summary -> END
 *
 * Stage A/B validation and itinerary assembly/validation are independent and
 * deterministic; the graph never calls an LLM. Domain truth is read and written
 * through the invocation ports.
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
  // After a domain extension the snapshot version changes, so the schedule
  // validation must be rebound before any non-flight confirmation.
  if (state.domainsEnsured && state.researchStatus === "pending") {
    return "dispatch_research";
  }
  return "prepare_decision";
}

/** A `propose_selection` command skips feasibility and opens a confirmation; a
 * `set_program` command applies the program directly; a chat request is
 * interpreted by the intent role first. Everything else first reads the
 * confirmed progress so a preference change resumes at the relevant step. */
export function routeAfterApplyCommands(state: TravelState): string {
  if (state.commandType === "chat") {
    return "interpret_intent";
  }
  if (state.commandType === "propose_selection") {
    return "stage_command_proposal";
  }
  if (state.commandType === "set_program") {
    return "apply_program";
  }
  if (state.commandType === "build_itinerary") {
    return "plan_itinerary";
  }
  return "detect_progress";
}

/** Route a validated intent result: unsupported ends, clarification interrupts,
 * program/proposal commands reuse their existing stages, and preference/search
 * commands continue through the deterministic progress detection. */
export function routeAfterIntentResult(state: TravelState): string {
  if (state.intentStatus === "unsupported" || state.intentStatus === "search_pending") {
    return "publish_summary";
  }
  if (state.intentStatus === "clarification") {
    return "prepare_decision";
  }
  if (state.commandType === "set_program") {
    return "apply_program";
  }
  if (state.commandType === "propose_selection") {
    return "stage_command_proposal";
  }
  if (state.commandType === "build_itinerary") {
    return "plan_itinerary";
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
    case "approve":
      return "approve_itinerary";
    case "reselection":
      return "prepare_decision";
    case "clarification_apply":
      return "resolve_clarification";
    case "clarification_modify":
      return "interpret_modification";
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
  // Phase 10: a valid program/logistics state always (re)builds the itinerary.
  return "plan_itinerary";
}

/**
 * Phase 10 bounded planning loop. Budget conflicts stop the loop immediately;
 * other invalid results replan while attempts remain (max three total) and then
 * open the conflict decision; a valid result continues to review.
 */
export function routeAfterValidateItinerary(state: TravelState): string {
  if (state.itineraryValidationStatus === "valid") {
    return "review_itinerary";
  }
  if (state.itineraryBudgetConflict) {
    return "prepare_decision";
  }
  if (state.planningAttempt < 3) {
    return "plan_itinerary";
  }
  return "prepare_decision";
}

/** A `revise` verdict replans while attempts remain; otherwise the approval (or
 * the review-conflict decision) opens. */
export function routeAfterReviewItinerary(state: TravelState): string {
  if (state.itineraryReviewVerdict === "revise" && state.planningAttempt < 3) {
    return "plan_itinerary";
  }
  return "prepare_decision";
}

export interface BuildTravelGraphOptions {
  readonly checkpointer: BaseCheckpointSaver;
}

export function buildTravelGraph(options: BuildTravelGraphOptions) {
  const builder = new StateGraph(travelStateSchema)
    .addNode("load_context", loadContextNode)
    .addNode("apply_commands", applyCommandsNode)
    .addNode("interpret_intent", interpretIntentNode)
    .addNode("resolve_clarification", resolveClarificationNode)
    .addNode("interpret_modification", interpretModificationNode)
    .addNode("detect_progress", detectProgressNode)
    .addNode("validate_route", validateRouteNode)
    .addNode("generate_flights", generateFlightsNode)
    .addNode("validate_schedules", validateSchedulesNode)
    .addNode("ensure_domains", ensureDomainsNode)
    .addNode("dispatch_research", dispatchResearchNode)
    .addNode("research_domain", researchDomainNode)
    .addNode("join_research", joinResearchNode)
    .addNode("rank_recommendations", rankRecommendationsNode)
    .addNode("validate_selected_logistics", validateSelectedLogisticsNode)
    .addNode("plan_itinerary", planItineraryNode)
    .addNode("validate_itinerary", validateItineraryNode)
    .addNode("review_itinerary", reviewItineraryNode)
    .addNode("approve_itinerary", approveItineraryNode)
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
      "interpret_intent",
      "stage_command_proposal",
      "apply_program",
      "plan_itinerary",
      "detect_progress",
    ])
    .addConditionalEdges("interpret_intent", routeAfterIntentResult, [
      "publish_summary",
      "prepare_decision",
      "apply_program",
      "stage_command_proposal",
      "plan_itinerary",
      "detect_progress",
    ])
    .addConditionalEdges("resolve_clarification", routeAfterIntentResult, [
      "publish_summary",
      "prepare_decision",
      "apply_program",
      "stage_command_proposal",
      "plan_itinerary",
      "detect_progress",
    ])
    .addEdge("interpret_modification", "interpret_intent")
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
      "dispatch_research",
      "publish_summary",
    ])
    .addEdge("prepare_decision", "await_decision")
    .addEdge("await_decision", "apply_decision")
    .addConditionalEdges("apply_decision", routeAfterApplyDecision, [
      "stage_selection",
      "commit_booking",
      "apply_program",
      "approve_itinerary",
      "prepare_decision",
      "resolve_clarification",
      "interpret_modification",
      "publish_summary",
    ])
    .addEdge("stage_command_proposal", "prepare_decision")
    .addEdge("stage_selection", "prepare_decision")
    .addConditionalEdges("commit_booking", routeAfterCommit, [
      "ensure_domains",
      "validate_selected_logistics",
    ])
    .addConditionalEdges("ensure_domains", routeAfterEnsureDomains, ["validate_schedules"])
    // Phase 09: `dispatch_research` fans out through `Send` (or continues with
    // retained results); `research_domain` uses one static edge into the single
    // serial join; the join alone decides retry/recovery/rank.
    .addConditionalEdges("dispatch_research", routeAfterDispatch)
    .addEdge("research_domain", "join_research")
    .addConditionalEdges("join_research", routeAfterJoin, [
      "dispatch_research",
      "rank_recommendations",
      "prepare_decision",
    ])
    .addConditionalEdges("rank_recommendations", routeAfterRank, [
      "prepare_decision",
      "publish_summary",
    ])
    .addConditionalEdges("apply_program", routeAfterApplyProgram, ["validate_selected_logistics"])
    .addConditionalEdges("validate_selected_logistics", routeAfterLogistics, [
      "prepare_decision",
      "plan_itinerary",
    ])
    .addEdge("plan_itinerary", "validate_itinerary")
    .addConditionalEdges("validate_itinerary", routeAfterValidateItinerary, [
      "review_itinerary",
      "plan_itinerary",
      "prepare_decision",
    ])
    .addConditionalEdges("review_itinerary", routeAfterReviewItinerary, [
      "plan_itinerary",
      "prepare_decision",
    ])
    .addEdge("approve_itinerary", "publish_summary")
    .addEdge("publish_summary", END);

  return builder.compile({ checkpointer: options.checkpointer });
}

export { TRAVEL_GRAPH_VERSION };
export { routeAfterDispatch, routeAfterJoin, routeAfterRank };
