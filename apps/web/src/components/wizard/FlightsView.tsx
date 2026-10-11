"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { PublicDecisionResponse } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { DEMO_DISCLAIMER, CONFIRMATION_DISCLAIMER } from "@/lib/disclaimers";
import { submitCommand, submitDecision, retryOperation } from "@/lib/decision-client";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { BookingDialog } from "./BookingDialog";
import { FlightCard } from "./FlightCard";
import {
  ErrorPanel,
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
  useTripEvents(tripId, onEvent);

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

  const confirmBooking = useCallback(
    async (response: PublicDecisionResponse): Promise<void> => {
      if (!projection) {
        return;
      }
      setBusy(true);
      setActionError(undefined);
      try {
        await submitDecision({
          tripId,
          decisionId: projection.pendingDecision?.id ?? "",
          expectedRevision: projection.trip.revision,
          response,
        });
        setDialogOpen(false);
        refresh();
      } catch (caught) {
        handleError(caught);
      } finally {
        setBusy(false);
      }
    },
    [handleError, projection, refresh, tripId],
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

  const { flights, pendingDecision, proposal, reservation } = projection;

  const failedOperation = [...projection.operations]
    .reverse()
    .find((operation) => operation.status === "failed");

  if (projection.trip.recoveryRequired || projection.trip.workflowStatus === "failed") {
    return (
      <FailedCard
        message="The planner stopped before finishing this trip. Retrying re-runs only the unfinished work."
        canRetry={Boolean(failedOperation)}
        busy={retryBusy}
        onRetry={() => {
          if (failedOperation) {
            void retryPlanning(failedOperation.operationId);
          }
        }}
      />
    );
  }

  if (projection.trip.workflowStatus === "blocked") {
    return (
      <FailedCard
        message="This trip is blocked by a decision that needs to be resolved. Refresh to check the current state."
        canRetry={false}
        busy={false}
        onRetry={() => {}}
      />
    );
  }

  if (reservation) {
    return (
      <div className="flex flex-col gap-6">
        <SuccessPanel demoReference={reservation.demoReference} tripId={tripId} />
        <p role="note" className="rounded bg-cream p-3 text-sm text-clay">
          {CONFIRMATION_DISCLAIMER}
        </p>
      </div>
    );
  }

  if (flights.routeStatus === "INFEASIBLE" || flights.routeStatus === "UNDETERMINED") {
    return (
      <RouteRejectionCard reasons={flights.routeReasons} alternatives={flights.alternatives} />
    );
  }

  if (flights.routeStatus === "FEASIBLE" && flights.scheduleStatus === "NO_VALID_OFFERS") {
    return (
      <div className="flex flex-col gap-4">
        <ScheduleEmptyCard
          oneNight={projection.trip.travelVariant === "one_night"}
          reasons={flights.scheduleReasons}
          explanation={flights.scheduleExplanation}
          busy={variantBusy}
          onRequestTwoNights={() => void requestTwoNights()}
        />
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
      </div>
    );
  }

  if (flights.scheduleStatus !== "VALID" || flights.offers.length === 0) {
    const activeOperation = projection.operations.find(
      (operation) => operation.status === "queued" || operation.status === "running",
    );
    return (
      <StatusPanel
        message={
          activeWork
            ? `Accepted - planning in progress${
                activeOperation ? ` (operation ${activeOperation.operationId.slice(0, 8)})` : ""
              }`
            : "Preparing flight options…"
        }
      />
    );
  }

  const bookingDecision = pendingDecision?.kind === "booking_confirmation" ? pendingDecision : null;
  const proposalPrice = proposal?.partyTotalMinor ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium uppercase tracking-wide text-teal">Step 3 of 3</p>
        <h1 className="text-2xl">Choose your flights</h1>
        <p className="text-sm text-ink-muted">
          These combinations passed the independent schedule validator. Prices are simulated in EUR.
        </p>
      </header>

      {actionError ? (
        <p role="alert" className="text-sm text-clay">
          {actionError}
        </p>
      ) : null}

      {pendingDecision?.kind === "flight_choice" ? (
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
      ) : null}

      {bookingDecision && proposal ? (
        <section className="flex flex-col gap-3 rounded border border-border bg-paper p-6">
          <h2 className="text-lg">Review and confirm</h2>
          <p className="text-sm">
            Selected offer is staged as a review proposal. Confirm to create the simulated
            reservation.
          </p>
          <p role="note" className="rounded bg-cream p-3 text-sm text-clay">
            {DEMO_DISCLAIMER}
          </p>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong"
          >
            Review booking
          </button>
        </section>
      ) : null}

      <BookingDialog
        open={dialogOpen}
        priceMinor={proposalPrice}
        busy={busy}
        error={actionError}
        onClose={() => setDialogOpen(false)}
        onConfirm={() => {
          if (bookingDecision?.proposalId ?? proposal?.id) {
            void confirmBooking({
              action: "confirm_booking",
              proposalId: (bookingDecision?.proposalId ?? proposal?.id) as string,
              acceptedDemoDisclaimer: true,
            });
          }
        }}
      />

      <p className="text-sm">
        <Link href={`/trips/${tripId}/summary`} className="underline">
          View trip summary
        </Link>
      </p>
    </div>
  );
}
