import type { PublicActivityChoice } from "@odft/contracts";
import { formatEuroMinor } from "@/lib/format/money";
import { ProvenanceLabel } from "@/components/offers/ProvenanceLabel";

function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${rest} min`;
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * One selectable activity choice. Selecting is a preference for the itinerary;
 * it never books or reserves anything. `preferredActivityIds` only records the
 * user's choices.
 */
export function ActivityCard({
  activity,
  selected,
  disabled,
  onToggle,
}: {
  readonly activity: PublicActivityChoice;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    <li className="flex flex-col gap-2 rounded border border-border bg-paper p-4">
      <div className="flex items-start justify-between gap-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={selected}
            disabled={disabled}
            onChange={onToggle}
            aria-label={`Include ${activity.name}`}
          />
          <span>
            <span className="block text-base">{activity.name}</span>
            <span className="block text-xs text-ink-muted capitalize">
              {activity.category} · {durationLabel(activity.durationMinutes)}
              {activity.ticketMinorPerAdult > 0
                ? ` · ${formatEuroMinor(activity.ticketMinorPerAdult)} ticket`
                : " · free"}
            </span>
          </span>
        </label>
        <span className="rounded border border-border px-2 py-0.5 text-xs text-ink-muted">
          {activity.reference ? "geographic reference" : "demo activity"}
        </span>
      </div>
      <ProvenanceLabel labels={activity.demoLabels} />
    </li>
  );
}
