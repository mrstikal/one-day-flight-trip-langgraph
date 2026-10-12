"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError } from "@/lib/api-client";
import { submitCommand } from "@/lib/decision-client";

/**
 * Replacement entry point on the summary's confirmed-hotel row. It stages the
 * same `find_alternatives` command the assistant sends for a hotel change and
 * opens the hotel step, where the refreshed choice is presented; the confirmed
 * reservation is never touched until the user confirms the replacement.
 */
export function ChangeHotelButton({
  tripId,
  revision,
}: {
  readonly tripId: string;
  readonly revision: number;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function changeHotel(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await submitCommand(tripId, {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        command: { type: "find_alternatives", target: "hotel", objective: "match_preferences" },
      });
      router.push(`/trips/${tripId}/hotel`);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "The hotel change could not be started.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="change-hotel"
        disabled={busy}
        onClick={() => void changeHotel()}
        className="w-fit rounded border border-teal px-3 py-1.5 text-sm font-medium text-teal hover:bg-teal-50 disabled:opacity-50"
      >
        {busy ? "Preparing alternatives…" : "Change hotel"}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-clay">
          {error}
        </p>
      ) : null}
    </div>
  );
}