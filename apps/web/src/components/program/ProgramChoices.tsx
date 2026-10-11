"use client";

import { useState } from "react";
import type { PublicMealOffer, PublicProgramChoices } from "@odft/contracts";
import { formatEuroMinor } from "@/lib/format/money";
import { ActivityCard } from "./ActivityCard";

function optionsFor(
  offers: readonly PublicMealOffer[],
  meal: "breakfast" | "lunch" | "dinner",
): PublicMealOffer[] {
  return offers.filter((offer) => offer.meal === meal);
}

/**
 * Program choices (Phase 07): meal defaults plus optional activity choices. The
 * choices are applied deterministically by the server; a differing confirmed meal
 * is staged for review and never moved or removed here. Preference commands are
 * not offered while this decision is pending (a new command would conflict), so
 * pace is shown read-only.
 */
export function ProgramChoices({
  mealOffers,
  program,
  pace,
  busy,
  error,
  onSubmit,
}: {
  readonly mealOffers: readonly PublicMealOffer[];
  readonly program: PublicProgramChoices;
  readonly pace: "relaxed" | "moderate" | "intensive";
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onSubmit: (selection: {
    mealOfferIds: { breakfast: string; lunch: string; dinner: string | null };
    preferredActivityIds: string[];
  }) => void;
}): React.JSX.Element {
  const [breakfast, setBreakfast] = useState(
    program.selectedMeals.breakfast ?? program.mealDefaults.breakfast,
  );
  const [lunch, setLunch] = useState(program.selectedMeals.lunch ?? program.mealDefaults.lunch);
  const [dinner, setDinner] = useState<string | null>(
    program.selectedMeals.dinner ?? program.mealDefaults.dinner,
  );
  const [activityIds, setActivityIds] = useState<readonly string[]>([]);

  function toggleActivity(id: string): void {
    setActivityIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  const dinnerOptional = program.dinnerNotIncludedReason !== null;

  function renderMeal(
    meal: "breakfast" | "lunch" | "dinner",
    value: string | null,
    onChange: (next: string | null) => void,
  ): React.JSX.Element {
    const options = optionsFor(mealOffers, meal);
    const selectId = `program-${meal}`;
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={selectId} className="text-sm font-medium capitalize">
          {meal}
        </label>
        {meal === "dinner" && dinnerOptional ? (
          <p className="text-xs text-ink-muted">{program.dinnerNotIncludedReason}</p>
        ) : null}
        <select
          id={selectId}
          className="rounded border border-border bg-paper px-2 py-1 text-sm"
          value={value ?? ""}
          disabled={busy}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        >
          {meal === "dinner" && dinnerOptional ? <option value="">Not included</option> : null}
          {options.map((offer) => (
            <option key={offer.id} value={offer.id}>
              {offer.name} · {formatEuroMinor(offer.partyTotalMinor)} party total
            </option>
          ))}
        </select>
      </div>
    );
  }

  const ready = breakfast !== "" && lunch !== "" && (dinner === null || dinner !== "");

  return (
    <section className="flex flex-col gap-4" aria-labelledby="program-heading">
      <header className="flex flex-col gap-2">
        <h1 id="program-heading" className="text-2xl">
          Plan your day
        </h1>
        <p className="text-sm text-ink-muted">
          Choose a meal default for each meal and the activities you want. Selecting a meal here
          does not book it; restaurant reservations are optional and confirmed separately.
        </p>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        {renderMeal("breakfast", breakfast, (next) => setBreakfast(next ?? ""))}
        {renderMeal("lunch", lunch, (next) => setLunch(next ?? ""))}
        {renderMeal("dinner", dinner, setDinner)}
      </div>
      <p className="text-sm text-ink-muted" data-testid="program-pace">
        Activity pace: <span className="capitalize">{pace}</span>. A pending choice must be answered
        before preferences can change.
      </p>
      <div className="flex flex-col gap-2">
        <h2 className="text-lg">Activities</h2>
        <ul className="flex flex-col gap-2" aria-label="Activity choices">
          {program.activities.map((activity) => (
            <ActivityCard
              key={activity.id}
              activity={activity}
              selected={activityIds.includes(activity.id)}
              disabled={busy}
              onToggle={() => toggleActivity(activity.id)}
            />
          ))}
        </ul>
      </div>
      <div>
        <button
          type="button"
          disabled={busy || !ready}
          onClick={() =>
            onSubmit({
              mealOfferIds: {
                breakfast: breakfast as string,
                lunch: lunch as string,
                dinner,
              },
              preferredActivityIds: [...activityIds],
            })
          }
          className="rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save program"}
        </button>
      </div>
    </section>
  );
}
