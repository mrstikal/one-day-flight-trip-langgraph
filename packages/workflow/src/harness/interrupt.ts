import { interrupt } from "@langchain/langgraph";
import { graphResumeEnvelopeSchema } from "@odft/contracts";
import { harnessStateSchema } from "./state.js";

/**
 * The single generic interrupt node for the harness. It has NO side effects and
 * no counters before the interrupt (03-langgraph-design.md section 7). On resume
 * it applies the trusted {@link GraphResumeEnvelope} operation identity/revision
 * into serial state, so any later effect is keyed by the new operation.
 */
export async function awaitDecisionNode(
  state: typeof harnessStateSchema.State,
): Promise<typeof harnessStateSchema.Update> {
  const descriptor = {
    kind: state.decisionKind ?? "clarification",
    pendingDecisionRef: state.pendingDecisionRef,
    allowedOptionIds: ["continue"],
  };
  const resume = interrupt(descriptor, { responseSchema: graphResumeEnvelopeSchema });
  const envelope = graphResumeEnvelopeSchema.parse(resume);
  return {
    operationId: envelope.operationId,
    acceptedRevision: envelope.acceptedRevision,
    pendingDecisionRef: null,
    decisionKind: null,
    lastOutcome: "success",
  };
}
