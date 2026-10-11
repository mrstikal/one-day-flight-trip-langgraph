"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { PublicDecisionResponse, PublicHotelOffer } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { submitDecision } from "@/lib/decision-client";
import { formatLocalDate } from "@/lib/format/datetime";
import { formatEuroMinor } from "@/lib/format/money";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { BookingConfirmationDialog } from "@/components/booking/BookingConfirmationDialog";
import { ConfirmationResult } from "@/components/booking/ConfirmationResult";
import { ProposalReview } from "@/components/booking/ProposalReview";
import { RecoveryCard } from "@/components/booking/RecoveryCard";
import { StaleProposalNotice } from "@/components/booking/StaleProposalNotice";
import { OfferCard } from "@/components/offers/OfferCard";
import { OfferGrid } from "@/components/offers/OfferGrid";
import { ServiceLevelControl } from "@/components/preferences/ServiceLevelControl";
import { ErrorPanel, StatusPanel } from "@/components/wizard/FlightGating";

function hotelDetails(offer: PublicHotelOffer): { label: string; value: string }[] {
  return [
    { label: "Check-in", value: formatLocalDate(offer.date) },
    { label: "Nights", value: String(offer.nights) },
    { label: "Rooms", value: String(offer.rooms) },
    { label: "Per night", value: formatEuroMinor(offer.perNightMinor) },
    { label: "Rating", value: offer.rating.toFixed(1) },
    { label: "From centre", value: `${offer.centerDistanceKm.toFixed(1)} km` },
    { label: "Luggage storage", value: offer.luggageStorage ? "Available" : "Not available" },
    { label: "Category", value: offer.level },
  ];
}

/** Hotel step: gating, offers, hotel choice, and the demo booking dialog. */
export function HotelView({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, error, refresh } = useTripProjection(tripId);
  const onEvent = useCallback(() => refresh(), [refresh]);
  const { reconnecting } = useTripEvents(tripId, onEvent);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleError = useCallback(
    (caught: unknown): void => {
      setActionError(
        caught instanceof ApiError ? caught.message : "The request could not be completed.",
      );
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

  const activeWork = useMemo(
    () =>
      projection?.operations.some(
        (operation) => operation.status === "queued" || operation.status === "running",
      ) ?? false,
    [projection],
  );

  if (!projection) {
    if (error) {
      return <ErrorPanel message={error.message} onRetry={refresh} />;
    }
    return <StatusPanel message="Loading your hotel options…" />;
  }

  const { hotel, pendingDecision, proposal, reservations, serviceLevels } = projection;
  const confirmedHotel = reservations.find(
    (reservation) => reservation.serviceKey === "hotel" && reservation.status === "confirmed",
  );

  const banner = error ? (
    <p role="status" className="rounded border border-clay bg-cream p-3 text-sm text-clay">
      {error.message} Showing the last known state.
    </p>
  ) : reconnecting ? (
    <p role="status" className="text-sm text-ink-muted">
      Live updates reconnecting…
    </p>
  ) : null;

  if (pendingDecision?.kind === "recovery") {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <RecoveryCard
          decision={pendingDecision}
          busy={busy}
          error={actionError}
          onChoose={(optionId) =>
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "choose_option",
              optionId,
            })
          }
        />
      </div>
    );
  }

  if (pendingDecision?.kind === "hotel_choice") {
    const selectedId = proposal?.serviceKey === "hotel" ? proposal.offerId : null;
    return (
      <div className="flex flex-col gap-6">
        {banner}
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium uppercase tracking-wide text-teal">Step 4 of 5</p>
          <h1 className="text-2xl">Choose your hotel</h1>
          <p className="text-sm text-ink-muted">
            Simulated offers in EUR. Selecting a card starts a review; nothing is booked yet.
          </p>
        </header>
        <p className="text-sm text-ink-muted" data-testid="hotel-level">
          Hotel category: <span className="capitalize">{serviceLevels.hotel.level}</span> (
          {serviceLevels.hotel.inherited ? "using the global default" : "explicit choice"}). A
          pending choice must be answered before preferences can change.
        </p>
        {hotel.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No hotel offers are available for your selection.
          </p>
        ) : (
          <OfferGrid label="Hotel offers">
            {hotel.map((offer) => (
              <OfferCard
                key={offer.id}
                title={offer.name}
                subtitle={`${offer.level} · ${offer.nights} night(s)`}
                priceMinor={offer.partyTotalMinor}
                priceNote={`total for ${offer.adults} adults`}
                details={hotelDetails(offer)}
                demoLabels={offer.demoLabels}
                actionLabel={selectedId === offer.id ? "Selected" : "Choose this hotel"}
                selected={selectedId === offer.id}
                disabled={busy || activeWork}
                testId="hotel-offer"
                onAction={() =>
                  void submitResponse(pendingDecision.id, projection.trip.revision, {
                    action: "choose_offer",
                    offerId: offer.id,
                  })
                }
              />
            ))}
          </OfferGrid>
        )}
        <p className="text-sm">
          <Link href={`/trips/${tripId}/flights`} className="underline">
            Back to flights
          </Link>
        </p>
      </div>
    );
  }

  if (
    pendingDecision?.kind === "booking_confirmation" &&
    (proposal === null || proposal.serviceKey === "hotel")
  ) {
    if (proposal === null || proposal.expired) {
      const staleProposalId = proposal?.id ?? pendingDecision.proposalId;
      return (
        <div className="flex flex-col gap-6">
          {banner}
          <StaleProposalNotice
            serviceLabel="hotel"
            busy={busy}
            canReselect={Boolean(staleProposalId)}
            onReselect={() => {
              if (staleProposalId) {
                void submitResponse(pendingDecision.id, projection.trip.revision, {
                  action: "reject_proposal",
                  proposalId: staleProposalId,
                });
              }
            }}
          />
        </div>
      );
    }
    const selected = hotel.find((offer) => offer.id === proposal.offerId) ?? null;
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <ProposalReview
          title="Review and confirm your hotel"
          description="Your selected hotel is staged as a review proposal. Confirm to create the simulated reservation, or choose a different hotel."
          proposal={proposal}
          reviewLabel="Review booking"
          busy={busy}
          onReview={() => setDialogOpen(true)}
          onReject={() =>
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "reject_proposal",
              proposalId: proposal.id,
            })
          }
        />
        <BookingConfirmationDialog
          open={dialogOpen}
          heading="Confirm this simulated hotel booking"
          busy={busy}
          error={actionError}
          onCancel={() => setDialogOpen(false)}
          onReject={() => {
            setDialogOpen(false);
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "reject_proposal",
              proposalId: proposal.id,
            });
          }}
          rejectLabel="Choose a different hotel"
          onConfirm={() =>
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "confirm_booking",
              proposalId: proposal.id,
              acceptedDemoDisclaimer: true,
            })
          }
          summary={
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-ink-muted">Hotel</dt>
              <dd>{selected?.name ?? "Selected hotel"}</dd>
              <dt className="text-ink-muted">Total price</dt>
              <dd className="font-semibold">{formatEuroMinor(proposal.partyTotalMinor)}</dd>
            </dl>
          }
        />
      </div>
    );
  }

  if (confirmedHotel) {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <ConfirmationResult
          reservation={confirmedHotel}
          tripId={tripId}
          nextHref={`/trips/${tripId}/meals`}
          nextLabel="Continue to meals"
        />
        {pendingDecision === null ? (
          <ServiceLevelControl
            tripId={tripId}
            revision={projection.trip.revision}
            service="hotel"
            label="Hotel"
            levelState={serviceLevels.hotel}
            onChanged={refresh}
          />
        ) : null}
        <p role="note" className="text-sm text-ink-muted">
          {DEMO_DISCLAIMER}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {banner}
      <StatusPanel
        message={activeWork ? "Accepted - preparing hotel offers…" : "Preparing hotel options…"}
      />
    </div>
  );
}
