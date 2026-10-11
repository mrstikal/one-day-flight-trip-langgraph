"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { PublicDecisionResponse } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { submitCommand, submitDecision, retryOperation } from "@/lib/decision-client";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { BookingDialog } from "./BookingDialog";
import { FlightCard } from "./FlightCard";
import { RouteFix } from "./RouteFix";
import {
  ErrorPanel,
  ExpiredProposalCard,
  FailedCard,
  RouteRejectionCard,
  ScheduleEmptyCard,
  StatusPanel,
  SuccessPanel,
} from "./FlightGating";

/** Flights step: gating, offers, flight choice, and the demo booking dialog. */
export function FlightsView({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, error, refresh } = useTripProjection(tripId);
  const onEvent = useCallback(() => refresh(), [refresh]);
  const { reconnecting } = useTripEvents(tripId, onEvent);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [variantBusy, setVariantBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);

  const activeWork = useMemo(
    () =>
      projection?.operations.some(
        (operation) => operation.status === "queued" || operation.status === "running",
      ) ?? false,
    [projection],
  );

  const handleError = useCallback(
    (caught: unknown): void => {
      const message =
        caught instanceof ApiError ? caught.message : "The request could not be completed.";
      setActionError(message);
      // Stale/busy conflicts refresh; the response is never replayed silently.
      if (
        caught instanceof ApiError &&
        (caught.code === "CONFLICT" ||
          caught.code === "STALE_REVISION" ||
          caught.code.startsWith("STALE_"))
      ) {
        refresh();
      }
    },
    [refresh],
  );

  const chooseOffer = useCallback(
    async (decisionId: string, revision: number, offerId: string): Promise<void> => {
      setBusy(true);
      setActionError(undefined);
      try {
        await submitDecision({
          tripId,
          decisionId,
          expectedRevision: revision,
          response: { action: "choose_offer", offerId },
        });
        refresh();
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
    [handleError, refresh, tripId],
  );

  const submitResponse = useCallback(
    async (
      decisionId: string,
      revision: number,
      response: PublicDecisionResponse,
    ): Promise<void> => {
      setBusy(true);
      setActionError(undefined);
      try {
        await submitDecision({ tripId, decisionId, expectedRevision: revision, response });
        setDialogOpen(false);
        refresh();
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
    [handleError, refresh, tripId],
  );

  const requestTwoNights = useCallback(async (): Promise<void> => {
    if (!projection) {
      return;
    }
    setVariantBusy(true);
    setActionError(undefined);
    try {
      await submitCommand(tripId, {
        expectedRevision: projection.trip.revision,
        requestId: crypto.randomUUID(),
        command: { type: "set_route", travelVariant: "two_nights" },
      });
      refresh();
    } catch (caught) {
      handleError(caught);
    } finally {
      setVariantBusy(false);
    }
  }, [handleError, projection, refresh, tripId]);

  const retryPlanning = useCallback(
    async (operationId: string): Promise<void> => {
      if (!projection) {
        return;
      }
      setRetryBusy(true);
      setActionError(undefined);
      try {
        await retryOperation(tripId, operationId, projection.trip.revision);
        refresh();
      } catch (caught) {
        handleError(caught);
      } finally {
        setRetryBusy(false);
      }
    },
    [handleError, projection, refresh, tripId],
  );

  if (!projection) {
    if (error) {
      return <ErrorPanel message={error.message} onRetry={refresh} />;
    }
    return <StatusPanel message="Loading your trip…" />;
  }

  const { flights, pendingDecision, proposal, reservations } = projection;
  const confirmedFlight = reservations.find(
    (row) => row.serviceKey === "flights" && row.status === "confirmed",
  );

  const failedOperation = [...projection.operations]
    .reverse()
    .find((operation) => operation.status === "failed");

  const stalenessBanner = error ? (
    <p role="status" className="rounded border border-clay bg-cream p-3 text-sm text-clay">
      {error.message} Showing the last known state.
    </p>
  ) : reconnecting ? (
    <p role="status" className="text-sm text-ink-muted">
      Live updates reconnecting…
    </p>
  ) : null;

  const wrap = (content: React.JSX.Element): React.JSX.Element => (
    <div className="flex flex-col gap-4">
      {stalenessBanner}
      {content}
    </div>
  );

  if (projection.trip.recoveryRequired || projection.trip.workflowStatus === "failed") {
    return wrap(
      <FailedCard
        message="The planner stopped before finishing this trip. Retrying re-runs only the unfinished work."
        canRetry={Boolean(failedOperation)}
        busy={retryBusy}
        onRetry={() => {
          if (failedOperation) {
            void retryPlanning(failedOperation.operationId);
          }
        }}
      />,
    );
  }

  // A live gating decision or a pending decision always wins over an earlier
  // reservation, so a route change cannot leave a stale confirmation on screen.
  if (flights.routeStatus === "INFEASIBLE" || flights.routeStatus === "UNDETERMINED") {
    return wrap(
      <RouteRejectionCard reasons={flights.routeReasons} alternatives={flights.alternatives}>
        <RouteFix tripId={tripId} revision={projection.trip.revision} onSubmitted={refresh} />
      </RouteRejectionCard>,
    );
  }

  if (flights.routeStatus === "FEASIBLE" && flights.scheduleStatus === "NO_VALID_OFFERS") {
    return wrap(
      <ScheduleEmptyCard
        oneNight={projection.trip.travelVariant === "one_night"}
        reasons={flights.scheduleReasons}
        explanation={flights.scheduleExplanation}
        busy={variantBusy}
        onRequestTwoNights={() => void requestTwoNights()}
      />,
    );
  }

  if (pendingDecision?.kind === "booking_confirmation" && proposal?.serviceKey === "flights") {
    const proposalUsable = proposal !== null && proposal.status === "proposed" && !proposal.expired;
    if (!proposalUsable) {
      return wrap(
        <ExpiredProposalCard
          busy={busy}
          onReselect={() => {
            if (pendingDecision.proposalId ?? proposal?.id) {
              void submitResponse(pendingDecision.id, projection.trip.revision, {
                action: "reject_proposal",
                proposalId: (pendingDecision.proposalId ?? proposal?.id) as string,
              });
            }
          }}
        />,
      );
    }
    const selected = flights.offers.find((offer) => offer.id === proposal.offerId) ?? null;
    return (
      <div className="flex flex-col gap-6">
        {stalenessBanner}
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        <section className="flex flex-col gap-3 rounded border border-border bg-paper p-6">
          <h2 className="text-lg">Review and confirm</h2>
          <p className="text-sm">
            Your selected flight is staged as a review proposal. Confirm to create the simulated
            reservation, or choose a different flight.
          </p>
          <p role="note" className="rounded bg-cream p-3 text-sm text-clay">
            {DEMO_DISCLAIMER}
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong"
            >
              Review booking
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void submitResponse(pendingDecision.id, projection.trip.revision, {
                  action: "reject_proposal",
                  proposalId: proposal.id,
                })
              }
              className="w-fit rounded border border-border px-4 py-2 text-sm disabled:opacity-50"
            >
              Choose a different flight
            </button>
          </div>
        </section>
        <BookingDialog
          open={dialogOpen}
          flight={selected}
          proposal={proposal}
          busy={busy}
          error={actionError}
          onClose={() => setDialogOpen(false)}
          onReject={() => {
            setDialogOpen(false);
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "reject_proposal",
              proposalId: proposal.id,
            });
          }}
          onConfirm={() =>
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "confirm_booking",
              proposalId: proposal.id,
              acceptedDemoDisclaimer: true,
            })
          }
        />
      </div>
    );
  }

  if (pendingDecision?.kind === "flight_choice") {
    return (
      <div className="flex flex-col gap-6">
        {stalenessBanner}
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium uppercase tracking-wide text-teal">Step 3 of 3</p>
          <h1 className="text-2xl">Choose your flights</h1>
          <p className="text-sm text-ink-muted">
            These combinations passed the independent schedule validator. Prices are simulated in
            EUR.
          </p>
        </header>
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        <ul className="flex flex-col gap-4" aria-label="Flight combinations">
          {flights.offers.map((flight) => (
            <FlightCard
              key={flight.id}
              flight={flight}
              selected={false}
              disabled={busy || activeWork}
              onChoose={() =>
                void chooseOffer(pendingDecision.id, projection.trip.revision, flight.id)
              }
            />
          ))}
        </ul>
        <p className="text-sm">
          <Link href={`/trips/${tripId}/summary`} className="underline">
            View trip summary
          </Link>
        </p>
      </div>
    );
  }

  if (confirmedFlight) {
    return (
      <div className="flex flex-col gap-6">
        {stalenessBanner}
        <SuccessPanel demoReference={confirmedFlight.demoReference} tripId={tripId} />
        <p className="text-sm">
          <Link href={`/trips/${tripId}/hotel`} className="underline">
            Continue to hotel selection
          </Link>
        </p>
        <p role="note" className="rounded bg-cream p-3 text-sm text-clay">
          {DEMO_DISCLAIMER}
        </p>
      </div>
    );
  }

  const activeOperation = projection.operations.find(
    (operation) => operation.status === "queued" || operation.status === "running",
  );
  return wrap(
    <StatusPanel
      message={
        activeWork
          ? `Accepted - planning in progress${
              activeOperation ? ` (operation ${activeOperation.operationId.slice(0, 8)})` : ""
            }`
          : "Preparing flight options…"
      }
    />,
  );
}
