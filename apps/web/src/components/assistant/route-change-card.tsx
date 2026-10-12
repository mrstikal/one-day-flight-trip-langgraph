"use client";

import type { PublicRouteChangePreview } from "@odft/contracts";

/**
 * Phase 11 route-change impact card (08-frontend-ux.md section 5).
 *
 * A route change that would invalidate confirmed reservations is NOT applied
 * until the user confirms it here. The card names every affected reservation
 * explicitly; nothing is cancelled before the confirmation, and the server
 * re-validates the preview before committing.
 */
export function RouteChangeCard({
  preview,
  busy,
  onConfirm,
}: {
  readonly preview: PublicRouteChangePreview;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const money = (minor: number): string => (minor / 100).toFixed(2);
  const destination = `${preview.from.destinationCityId} → ${preview.to.destinationCityId}`;
  return (
    <section
      data-testid="route-change-card"
      aria-label="Route change impact"
      className="rounded border border-amber-500 bg-amber-50 p-3 text-sm"
    >
      <h3 className="font-serif text-sm font-semibold">Confirm the route change</h3>
      <p className="mt-1 text-xs text-ink-muted">
        {destination} · {preview.from.sightseeingDate} → {preview.to.sightseeingDate} ·{" "}
        {preview.to.travelVariant === "one_night" ? "one night" : "two nights"}
      </p>
      {preview.affectedReservations.length > 0 ? (
        <>
          <p className="mt-2 text-xs">
            These confirmed reservations will be cancelled when you confirm, and the route,
            schedule, and itinerary are re-validated from scratch:
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs" data-testid="route-change-reservations">
            {preview.affectedReservations.map((reservation) => (
              <li key={reservation.id}>
                {reservation.serviceKey} — {reservation.demoReference} ({money(reservation.partyTotalMinor)})
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-xs">
          No confirmed reservation is affected; the change still re-validates the route.
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        data-testid="route-change-confirm"
        className="mt-3 rounded bg-teal px-3 py-1.5 text-xs font-medium text-paper disabled:opacity-50"
      >
        Confirm route change
      </button>
      <p className="mt-2 text-[11px] text-ink-muted">
        Declining is safe: nothing changes until you confirm, and you can keep chatting instead.
      </p>
    </section>
  );
}
