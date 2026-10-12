"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api-client";
import { submitCommand, submitDecision } from "@/lib/decision-client";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { ClarificationOptions } from "./clarification-options";
import { MessageList } from "./message-list";
import { RouteChangeCard } from "./route-change-card";

/**
 * The assistant rail (08-frontend-ux.md): persisted conversation, the pending
 * clarification card, the route-change impact card, and the chat composer. Every
 * message becomes one admitted operation; the rail never claims unconfirmed
 * success and never confirms a reservation.
 *
 * Phase 11: a chat while ANY decision is pending is admitted by the worker as a
 * modification of that exact interrupt (the old decision is resolved
 * explicitly), so the composer stays available — it only waits for active work.
 */
export function ConversationRail({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, error, refresh } = useTripProjection(tripId);
  const onEvent = useCallback(() => refresh(), [refresh]);
  useTripEvents(tripId, onEvent);

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();

  const activeWork = useMemo(
    () =>
      projection?.operations.some(
        (operation) => operation.status === "queued" || operation.status === "running",
      ) ?? false,
    [projection],
  );

  const handleError = useCallback(
    (caught: unknown): void => {
      setActionError(
        caught instanceof ApiError ? caught.message : "The request could not be completed.",
      );
      if (
        caught instanceof ApiError &&
        (caught.code === "CONFLICT" ||
          caught.code === "STALE_REVISION" ||
          caught.code === "OPERATION_IN_PROGRESS" ||
          caught.code.startsWith("STALE_"))
      ) {
        // Refresh the authoritative state; the typed message stays in the
        // composer so the user can deliberately resubmit — never auto-replay.
        refresh();
      }
    },
    [refresh],
  );

  const send = useCallback(async (): Promise<void> => {
    const message = draft.trim();
    if (!projection || message.length === 0) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: projection.trip.revision,
        chat: message,
      });
      setDraft("");
      refresh();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }, [draft, handleError, projection, refresh, tripId]);

  const chooseOption = useCallback(
    async (optionId: string): Promise<void> => {
      if (!projection?.pendingDecision) {
        return;
      }
      setBusy(true);
      setActionError(undefined);
      try {
        await submitDecision({
          tripId,
          decisionId: projection.pendingDecision.id,
          expectedRevision: projection.trip.revision,
          response: { action: "choose_option", optionId },
        });
        refresh();
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
    [handleError, projection, refresh, tripId],
  );

  const confirmRouteChange = useCallback(async (): Promise<void> => {
    const preview = projection?.routeChange;
    if (!projection?.pendingDecision || !preview) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await submitDecision({
        tripId,
        decisionId: projection.pendingDecision.id,
        expectedRevision: projection.trip.revision,
        response: {
          action: "confirm_route_change",
          proposalId: preview.proposalId,
          affectedReservationIds: preview.affectedReservations.map((entry) => entry.id),
        },
      });
      refresh();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }, [handleError, projection, refresh, tripId]);

  const clarification = projection?.clarification ?? null;
  const pendingClarification =
    clarification && projection?.pendingDecision?.kind === "clarification" ? clarification : null;
  const routeChange =
    projection?.pendingDecision?.kind === "route_change_confirmation"
      ? (projection.routeChange ?? null)
      : null;
  const inspectorHref =
    projection?.display.demoControlsEnabled === true ? `/trips/${tripId}/inspector` : null;

  return (
    <aside
      data-testid="assistant-rail"
      aria-label="Assistant"
      className="flex h-full flex-col gap-4 rounded border border-border bg-paper p-4"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Assistant</h2>
          {inspectorHref ? (
            <Link
              href={inspectorHref}
              className="text-xs text-teal underline"
              data-testid="inspector-link"
            >
              Inspector
            </Link>
          ) : null}
        </div>
        <p role="note" className="text-xs text-ink-muted">
          {projection?.display.aiMode === "openrouter"
            ? "Live AI mode: interpretation calls the configured model."
            : "Deterministic fixture mode: no live AI calls."}
        </p>
      </header>

      <MessageList messages={projection?.conversation ?? []} />

      {pendingClarification ? (
        <ClarificationOptions
          question={pendingClarification.question}
          options={pendingClarification.options}
          busy={busy}
          onChoose={(optionId) => {
            void chooseOption(optionId);
          }}
        />
      ) : null}

      {routeChange ? (
        <RouteChangeCard
          preview={routeChange}
          busy={busy || activeWork}
          onConfirm={() => {
            void confirmRouteChange();
          }}
        />
      ) : null}

      {actionError ? (
        <p role="alert" className="text-sm text-red-700">
          {actionError}
        </p>
      ) : null}
      {error && !actionError ? (
        <p role="status" className="text-xs text-ink-muted">
          {error.message}
        </p>
      ) : null}

      <form
        className="mt-auto flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="assistant-chat" className="text-sm font-medium">
          Ask for a change
        </label>
        <textarea
          id="assistant-chat"
          name="chat"
          rows={2}
          maxLength={2000}
          value={draft}
          disabled={busy || !projection}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="e.g. Make the day less exhausting, or find a cheaper hotel"
          className="resize-none rounded border border-border bg-cream px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || activeWork || draft.trim().length === 0}
          className="self-end rounded bg-teal px-4 py-2 text-sm font-medium text-paper disabled:opacity-50"
        >
          {activeWork ? "Working…" : "Send"}
        </button>
      </form>
    </aside>
  );
}
