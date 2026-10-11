import type { PublicPendingDecision } from "@odft/contracts";

const OPTION_LABELS: Readonly<Record<string, string>> = {
  change_hotel: "Adjust the hotel",
  change_meals: "Adjust the meals",
  change_program: "Adjust the program",
};

/**
 * Typed recovery decision (Phase 07 step 7, extended in Phase 09). A
 * deterministic logistics conflict or an unavailable necessary research domain
 * opens this instead of editing a reservation: the user re-opens the affected
 * step. The reason itself is not carried in the decision DTO (no free text), only
 * the offered recovery options.
 */
export function RecoveryCard({
  decision,
  busy,
  error,
  onChoose,
}: {
  readonly decision: PublicPendingDecision;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onChoose: (optionId: string) => void;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-3 rounded border border-clay bg-paper p-6"
      aria-labelledby="recovery-heading"
    >
      <h2 id="recovery-heading" className="text-lg text-clay">
        We need one change to keep your day feasible
      </h2>
      <p className="text-sm text-ink-muted">
        The confirmed plan needs one adjustment (for example a transfer, a meal window, or an
        option that is unavailable for the selected category). Nothing has been changed
        automatically; pick which part to adjust.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {decision.allowedOptionIds.map((optionId) => (
          <button
            key={optionId}
            type="button"
            disabled={busy}
            onClick={() => onChoose(optionId)}
            className="w-fit rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {OPTION_LABELS[optionId] ?? optionId}
          </button>
        ))}
      </div>
    </section>
  );
}
