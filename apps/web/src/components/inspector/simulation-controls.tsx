"use client";

import { useCallback, useState } from "react";
import type { PublicInspector } from "@odft/contracts";
import { ApiError } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";

/**
 * Phase 11 simulation controls (08-frontend-ux.md section 10).
 *
 * The controls are owner-protected (session + trip ownership on the BFF) and
 * flag-protected (they only render when demo controls are enabled; the command
 * route rejects `set_simulation` when the flag is off). Every control submits an
 * ordinary `set_simulation` command through the same admitted-operation path, so
 * the worker — not the browser — arms the labeled overlay.
 */

const MODES = [
  {
    mode: "budget_conflict" as const,
    label: "Budget conflict",
    description: "Sets an explicit low budget; the itinerary planner reports a budget conflict.",
  },
  {
    mode: "preference_conflict" as const,
    label: "Preference conflict",
    description: "Requests six museums at a relaxed pace; the graph clarifies instead of inventing.",
  },
  {
    mode: "invalid_itinerary" as const,
    label: "Invalid itinerary (first attempt)",
    description: "Injects one labeled overlap on the first planning attempt; replanning repairs it.",
  },
];

export function SimulationControls({
  tripId,
  revision,
  inspector,
  onSubmitted,
}: {
  readonly tripId: string;
  readonly revision: number;
  readonly inspector: PublicInspector;
  readonly onSubmitted: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const arm = useCallback(
    async (mode: (typeof MODES)[number]["mode"]): Promise<void> => {
      setBusy(true);
      setMessage(undefined);
      try {
        await submitCommand(tripId, {
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          command: { type: "set_simulation", mode },
        });
        setMessage(`Scenario "${mode}" queued; the worker arms it as a labeled simulated failure.`);
        onSubmitted();
      } catch (caught) {
        setMessage(
          caught instanceof ApiError
            ? caught.message
            : "The scenario command could not be admitted.",
        );
      } finally {
        setBusy(false);
      }
    },
    [onSubmitted, revision, tripId],
  );

  return (
    <section aria-label="Simulation controls" data-testid="simulation-controls">
      <h3 className="font-serif text-sm font-semibold">Scenario controls</h3>
      <p className="mt-1 text-xs text-ink-muted">
        Current scenario mode: <span data-testid="scenario-mode">{inspector.scenarioMode}</span>.
        Armed faults are always labeled &quot;Simulated failure&quot; and never fake prices.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {MODES.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            disabled={busy}
            title={entry.description}
            onClick={() => {
              void arm(entry.mode);
            }}
            className="rounded border border-border bg-cream px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {entry.label}
          </button>
        ))}
      </div>
      {message ? (
        <p role="status" className="mt-2 text-xs text-ink-muted">
          {message}
        </p>
      ) : null}
    </section>
  );
}
