import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getServerDeps } from "@/lib/server";
import { resolveSession } from "@/lib/session";
import { buildTripProjection } from "@/lib/projection";
import { CONFIRMATION_DISCLAIMER, DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { formatLocalDate } from "@/lib/format/datetime";
import { formatEuroMinor } from "@/lib/format/money";

export const dynamic = "force-dynamic";

/** Trip summary: the confirmed (or pending) demo reservation for one trip. */
export default async function SummaryPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const deps = getServerDeps();
  const cookieHeader = (await cookies()).toString();
  const session = await resolveSession(deps.pool, deps.config, cookieHeader, { renew: false });
  if (!session) {
    notFound();
  }
  const projection = await buildTripProjection(deps.pool, id, {
    aiMode: deps.config.aiMode,
    demoControlsEnabled: deps.config.demoControlsEnabled,
    mapTileUrl: deps.config.mapTileUrl ?? null,
  });
  if (!projection || projection.trip.sessionId !== session.sessionId) {
    notFound();
  }

  const { trip, reservations, itinerary } = projection;
  const activeReservations = reservations.filter((row) => row.status === "confirmed");

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl">Trip summary</h1>
        <p className="text-sm text-ink-muted">
          {trip.userName} · {trip.adults} {trip.adults === 1 ? "adult" : "adults"} ·{" "}
          {formatLocalDate(trip.sightseeingDate)} ·{" "}
          {trip.travelVariant === "one_night" ? "one night" : "two nights"}
        </p>
      </header>

      {itinerary ? (
        <p className="text-sm">
          Itinerary version {itinerary.version} ({itinerary.status}).{" "}
          <Link href={`/trips/${id}/itinerary`} className="underline">
            Open the itinerary
          </Link>
        </p>
      ) : null}

      {activeReservations.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-xl text-teal">Confirmed simulated reservations</h2>
          <ul className="flex flex-col gap-3">
            {activeReservations.map((reservation) => (
              <li
                key={reservation.id}
                className="flex flex-col gap-2 rounded border border-teal bg-paper p-4"
              >
                <h3 className="text-base capitalize">{reservation.serviceKey}</h3>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-ink-muted">Reference</dt>
                  <dd className="font-mono font-semibold">{reservation.demoReference}</dd>
                  <dt className="text-ink-muted">Status</dt>
                  <dd>{reservation.status}</dd>
                  <dt className="text-ink-muted">Party total</dt>
                  <dd>{formatEuroMinor(reservation.partyTotalMinor)}</dd>
                </dl>
              </li>
            ))}
          </ul>
          <p role="note" className="text-sm text-clay">
            {CONFIRMATION_DISCLAIMER}
          </p>
        </section>
      ) : (
        <section className="flex flex-col gap-3 rounded border border-border bg-paper p-6">
          <h2 className="text-lg">No confirmed reservation yet</h2>
          <Link href={`/trips/${id}/flights`} className="text-sm underline">
            Go to flight selection
          </Link>
        </section>
      )}

      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
