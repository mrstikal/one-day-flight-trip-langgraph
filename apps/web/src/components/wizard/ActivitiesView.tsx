"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import type { PublicDecisionResponse } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { submitCommand, submitDecision } from "@/lib/decision-client";
import { useTripProjection } from "@/lib/use-trip-projection";
import { useTripEvents } from "@/lib/use-sse";
import { ActivityCard } from "@/components/program/ActivityCard";
import { InterestControls } from "@/components/program/InterestControls";
import { RecoveryCard } from "@/components/booking/RecoveryCard";
import { ErrorPanel, StatusPanel } from "@/components/wizard/FlightGating";

/** Activities step: program choices focused on the sightseeing activity list. */
export function ActivitiesView({ tripId }: { readonly tripId: string }): React.JSX.Element {
  const { projection, error, refresh } = useTripProjection(tripId);
  const onEvent = useCallback(() => refresh(), [refresh]);
  const { reconnecting } = useTripEvents(tripId, onEvent);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [selectedOverride, setSelectedOverride] = useState<readonly string[] | null>(null);

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
        refresh();
      } catch (caught) {
        setActionError(
          caught instanceof ApiError ? caught.message : "The request could not be completed.",
        );
      } finally {
        setBusy(false);
      }
    },
    [refresh, tripId],
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
    return <StatusPanel message="Loading your activities…" />;
  }

  const { program, pendingDecision } = projection;
  const selectedIds = selectedOverride ?? program?.preferredActivityIds ?? [];

  function toggleActivity(id: string): void {
    setSelectedOverride(
      selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id],
    );
  }

  async function saveActivities(): Promise<void> {
    if (!program || !projection) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: projection.trip.revision,
        command: {
          type: "set_program",
          mealOfferIds: {
            breakfast: program.selectedMeals.breakfast ?? program.mealDefaults.breakfast,
            lunch: program.selectedMeals.lunch ?? program.mealDefaults.lunch,
            dinner: program.selectedMeals.dinner ?? program.mealDefaults.dinner,
          },
          preferredActivityIds: [...selectedIds],
        },
      });
      setSelectedOverride(null);
      refresh();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : "The activity change failed.");
    } finally {
      setBusy(false);
    }
  }

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

  if (program) {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl">Activities</h1>
          <p className="text-sm text-ink-muted">
            These are demo activity choices for your sightseeing day. They are recorded preferences
            and never booked.
          </p>
        </header>
        {pendingDecision === null ? (
          <>
            <InterestControls
              tripId={tripId}
              revision={projection.trip.revision}
              pace={projection.trip.preferences.activityPace}
              onChanged={refresh}
            />
            {actionError ? (
              <p role="alert" className="text-sm text-clay">
                {actionError}
              </p>
            ) : null}
            <ul className="flex flex-col gap-2" aria-label="Activity choices">
              {program.activities.map((activity) => (
                <ActivityCard
                  key={activity.id}
                  activity={activity}
                  selected={selectedIds.includes(activity.id)}
                  disabled={busy || activeWork}
                  onToggle={() => toggleActivity(activity.id)}
                />
              ))}
            </ul>
            <div>
              <button
                type="button"
                disabled={busy || activeWork}
                onClick={() => void saveActivities()}
                className="rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save activity preferences"}
              </button>
            </div>
            <p className="text-sm">
              <Link href={`/trips/${tripId}/itinerary`} className="underline">
                Continue to the itinerary
              </Link>
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-muted">
              {pendingDecision?.kind === "program_choices" ? (
                <>
                  Meal choices are still pending.{" "}
                  <Link href={`/trips/${tripId}/meals`} className="underline">
                    Choose your meals
                  </Link>
                </>
              ) : (
                <>
                  Activity pace:{" "}
                  <span className="capitalize">{projection.trip.preferences.activityPace}</span>. A
                  pending choice must be answered before preferences can change.
                </>
              )}
            </p>
            <ul className="flex flex-col gap-2" aria-label="Activity choices">
              {program.activities.map((activity) => (
                <ActivityCard
                  key={activity.id}
                  activity={activity}
                  selected={selectedIds.includes(activity.id)}
                  disabled
                  onToggle={() => undefined}
                />
              ))}
            </ul>
          </>
        )}
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
        message={activeWork ? "Accepted - preparing activities…" : "Preparing activity options…"}
      />
    </div>
  );
}
