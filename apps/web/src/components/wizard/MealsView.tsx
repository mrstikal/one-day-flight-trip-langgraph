"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { PublicDecisionResponse, PublicMealOffer, Meal } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { submitCommand, submitDecision } from "@/lib/decision-client";
import { formatEuroMinor } from "@/lib/format/money";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { BookingConfirmationDialog } from "@/components/booking/BookingConfirmationDialog";
import { ConfirmationResult } from "@/components/booking/ConfirmationResult";
import { ProposalReview } from "@/components/booking/ProposalReview";
import { RecoveryCard } from "@/components/booking/RecoveryCard";
import { StaleProposalNotice } from "@/components/booking/StaleProposalNotice";
import { ServiceLevelControl } from "@/components/preferences/ServiceLevelControl";
import { ProgramChoices } from "@/components/program/ProgramChoices";
import { ErrorPanel, StatusPanel } from "@/components/wizard/FlightGating";
import { ResearchFailurePanel, SimulatedFailureNote } from "@/components/wizard/ResearchGap";

const MEALS: readonly Meal[] = ["breakfast", "lunch", "dinner"];

function mealOfferLabel(meals: readonly PublicMealOffer[], offerId: string | null): string {
  if (!offerId) {
    return "Not included";
  }
  const offer = meals.find((candidate) => candidate.id === offerId);
  return offer ? `${offer.name} · ${formatEuroMinor(offer.partyTotalMinor)}` : offerId;
}

/** Meals step: program choices, optional per-meal reservations, and confirmations. */
export function MealsView({ tripId }: { readonly tripId: string }): React.JSX.Element {
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

  const reserveMeal = useCallback(
    async (meal: Meal, offerId: string): Promise<void> => {
      setBusy(true);
      setActionError(undefined);
      try {
        await submitCommand(tripId, {
          requestId: crypto.randomUUID(),
          expectedRevision: projection?.trip.revision ?? 0,
          command: { type: "propose_selection", service: meal, offerId },
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
    return <StatusPanel message="Loading your meal options…" />;
  }

  const { meals, program, pendingDecision, proposal, reservations, serviceLevels } = projection;
  const confirmedMeals = reservations.filter(
    (reservation) =>
      reservation.status === "confirmed" &&
      reservation.serviceKey !== "flights" &&
      reservation.serviceKey !== "hotel",
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

  if (pendingDecision?.kind === "program_choices" && program) {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <p className="text-sm text-ink-muted" data-testid="meal-levels">
          Meal categories: breakfast{" "}
          <span className="capitalize">{serviceLevels.breakfast.level}</span>, lunch{" "}
          <span className="capitalize">{serviceLevels.lunch.level}</span>, dinner{" "}
          <span className="capitalize">{serviceLevels.dinner.level}</span>. A pending choice must be
          answered before preferences can change.
        </p>
        <SimulatedFailureNote
          state={
            MEALS.map(
              (meal) =>
                projection.research?.domains.find((entry) => entry.domain === meal) ?? null,
            ).find((state) => state?.simulatedFailure) ?? null
          }
        />
        <ProgramChoices
          mealOffers={meals}
          program={program}
          pace={projection.trip.preferences.activityPace}
          busy={busy}
          error={actionError}
          onSubmit={(selection) =>
            void submitResponse(pendingDecision.id, projection.trip.revision, {
              action: "submit_program",
              mealOfferIds: selection.mealOfferIds,
              preferredActivityIds: selection.preferredActivityIds,
            })
          }
        />
      </div>
    );
  }

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

  const mealService = proposal?.serviceKey;
  const isMealService =
    mealService === "breakfast" || mealService === "lunch" || mealService === "dinner";
  if (
    (pendingDecision?.kind === "booking_confirmation" ||
      pendingDecision?.kind === "replacement_confirmation") &&
    pendingDecision
  ) {
    const staleProposalId = proposal?.id ?? pendingDecision.proposalId;
    if (!proposal || proposal.expired) {
      return (
        <div className="flex flex-col gap-6">
          {banner}
          <StaleProposalNotice
            serviceLabel={isMealService && mealService ? mealService : "meal"}
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
    if (isMealService && mealService) {
      return (
        <div className="flex flex-col gap-6">
          {banner}
          <ProposalReview
            title={`Confirm your ${mealService} reservation`}
            description="Restaurant reservations are optional. Confirm to create the simulated reservation, or choose a different option."
            proposal={proposal}
            reviewLabel="Review reservation"
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
            heading="Confirm this simulated restaurant booking"
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
            rejectLabel="Choose a different option"
            onConfirm={() =>
              void submitResponse(pendingDecision.id, projection.trip.revision, {
                action: "confirm_booking",
                proposalId: proposal.id,
                acceptedDemoDisclaimer: true,
              })
            }
            summary={
              <p className="text-sm">
                {mealOfferLabel(meals, proposal.offerId)} —{" "}
                <span className="font-semibold">{formatEuroMinor(proposal.partyTotalMinor)}</span>
              </p>
            }
          />
        </div>
      );
    }
  }

  if (program || confirmedMeals.length > 0) {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        {actionError ? (
          <p role="alert" className="text-sm text-clay">
            {actionError}
          </p>
        ) : null}
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium uppercase tracking-wide text-teal">Step 5 of 5</p>
          <h1 className="text-2xl">Meals and activities</h1>
          <p className="text-sm text-ink-muted">
            Meal selections are saved. Restaurant reservations are optional and confirmed one meal
            at a time.
          </p>
        </header>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          {MEALS.map((meal) => (
            <div key={meal} className="contents">
              <dt className="capitalize text-ink-muted">{meal}</dt>
              <dd>
                {mealOfferLabel(
                  meals,
                  program?.selectedMeals[meal] ?? program?.mealDefaults[meal] ?? null,
                )}
              </dd>
            </div>
          ))}
        </dl>
        {program?.dinnerNotIncludedReason ? (
          <p className="text-sm text-ink-muted">{program.dinnerNotIncludedReason}</p>
        ) : null}
        {pendingDecision === null ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {MEALS.map((meal) => (
              <ServiceLevelControl
                key={meal}
                tripId={tripId}
                revision={projection.trip.revision}
                service={meal}
                label={meal}
                levelState={serviceLevels[meal]}
                onChanged={refresh}
              />
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-3">
          {MEALS.map((meal) => {
            const offerId = program?.selectedMeals[meal] ?? program?.mealDefaults[meal] ?? null;
            const already = confirmedMeals.some((row) => row.serviceKey === meal);
            if (!offerId || already) {
              return null;
            }
            return (
              <button
                key={meal}
                type="button"
                disabled={busy || activeWork}
                onClick={() => void reserveMeal(meal, offerId)}
                className="w-fit rounded border border-teal px-4 py-2 text-sm text-teal disabled:opacity-50"
              >
                Reserve {meal}
              </button>
            );
          })}
        </div>
        {confirmedMeals.map((reservation) => (
          <ConfirmationResult key={reservation.id} reservation={reservation} tripId={tripId} />
        ))}
        <p className="text-sm">
          <Link href={`/trips/${tripId}/activities`} className="underline">
            Review activities
          </Link>
        </p>
        <p role="note" className="text-sm text-ink-muted">
          {DEMO_DISCLAIMER}
        </p>
      </div>
    );
  }

  const failedMeals = MEALS.flatMap((meal) => {
    const state = projection.research?.domains.find((entry) => entry.domain === meal) ?? null;
    return state && state.status !== "ok" ? [{ meal, state }] : [];
  });

  return (
    <div className="flex flex-col gap-4">
      {banner}
      {failedMeals.length > 0 && pendingDecision === null ? (
        <div className="flex flex-col gap-6">
          {failedMeals.map(({ meal, state }) => (
            <ResearchFailurePanel
              key={meal}
              tripId={tripId}
              revision={projection.trip.revision}
              domain={meal}
              state={state}
              disabled={activeWork}
              onRetried={refresh}
            />
          ))}
          <div className="grid gap-3 sm:grid-cols-3">
            {failedMeals.map(({ meal }) => (
              <ServiceLevelControl
                key={meal}
                tripId={tripId}
                revision={projection.trip.revision}
                service={meal}
                label={meal}
                levelState={serviceLevels[meal]}
                onChanged={refresh}
              />
            ))}
          </div>
        </div>
      ) : (
        <StatusPanel
          message={activeWork ? "Accepted - preparing meals…" : "Preparing meal options…"}
        />
      )}
    </div>
  );
}
