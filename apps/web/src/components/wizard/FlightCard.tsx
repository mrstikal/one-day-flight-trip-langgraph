import type { PublicFlightCombination, PublicFlightDirection } from "@odft/contracts";
import { formatDuration, formatStops, formatTime } from "@/lib/format/datetime";
import { formatEuroMinor } from "@/lib/format/money";

function DirectionSummary({
  title,
  direction,
  stops,
}: {
  readonly title: string;
  readonly direction: PublicFlightDirection;
  readonly stops: number;
}): React.JSX.Element {
  const first = direction.segments[0];
  const last = direction.segments[direction.segments.length - 1];
  if (!first || !last) {
    return <p>{title}: no segments</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm">
        {first.fromIata} {formatTime(first.departureInstant, first.departureZone)} →{" "}
        {last.toIata} {formatTime(last.arrivalInstant, last.arrivalZone)}
      </p>
      <p className="text-xs text-ink-muted">
        {first.airlineName} {first.flightNumber} · {formatStops(stops)}
      </p>
      <p className="text-xs text-ink-muted">
        Local {first.departureZone} / {last.arrivalZone} · departs{" "}
        {formatTime(first.departureInstant, "UTC")} UTC
      </p>
    </div>
  );
}

export function FlightCard({
  flight,
  selected,
  onChoose,
  disabled,
}: {
  readonly flight: PublicFlightCombination;
  readonly selected: boolean;
  readonly onChoose: () => void;
  readonly disabled: boolean;
}): React.JSX.Element {
  return (
    <li
      className={`flex flex-col gap-3 rounded border p-4 ${
        selected ? "border-teal bg-paper" : "border-border bg-paper"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base">Flight combination</h3>
        <p className="text-base font-semibold">
          {formatEuroMinor(flight.partyTotalMinor)}{" "}
          <span className="text-xs font-normal text-ink-muted">
            total for {flight.adults} {flight.adults === 1 ? "adult" : "adults"}
          </span>
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <DirectionSummary title="Outbound" direction={flight.outbound} stops={flight.outboundStops} />
        <DirectionSummary title="Return" direction={flight.inbound} stops={flight.inboundStops} />
      </div>
      <p className="text-xs text-ink-muted">
        Total travel time {formatDuration(flight.totalTravelMinutes)} ·{" "}
        {formatEuroMinor(flight.perAdultMinor)} per adult ·{" "}
        {flight.supportedVariants.includes("one_night") ? "one-night trip" : "two-night trip"}
      </p>
      <p className="text-xs text-ink-muted">{flight.demoLabels.join(" · ")}</p>
      <div>
        <button
          type="button"
          onClick={onChoose}
          disabled={disabled}
          aria-pressed={selected}
          className="rounded bg-teal px-3 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
        >
          {selected ? "Selected" : "Choose this flight"}
        </button>
      </div>
    </li>
  );
}
