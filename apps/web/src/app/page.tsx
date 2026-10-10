import { DEMO_DISCLAIMER, SCAFFOLD_STATUS } from "@/lib/disclaimers";

const SCAFFOLDED_CAPABILITIES = [
  "Runnable Next.js BFF, a dedicated Node.js worker, and PostgreSQL 17 with migrations 0001-0003.",
  "Offline European reference data (countries, cities, airports, curated landmarks) is imported and loaded.",
  "A deterministic booking foundation exists (command admission, effect ledger, BookingService) with no UI yet.",
  "The travel planner, AI roles, maps, itineraries, and booking dialogs are not implemented yet.",
];

export default function HomePage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold">AI Travel Planner</h1>
        <p className="mt-3 inline-block rounded border border-border bg-paper px-3 py-1 text-sm text-ink-muted">
          {SCAFFOLD_STATUS}
        </p>
      </div>

      <p className="max-w-2xl text-ink-muted">
        This deployment is the repository and runtime foundation plus offline reference data and the
        deterministic booking service. It lets the team verify the pinned toolchain, database setup,
        worker health, and test commands before any travel-planning UI is built.
      </p>

      <section aria-labelledby="capabilities-heading" className="max-w-2xl">
        <h2 id="capabilities-heading" className="text-xl font-semibold">
          Current status
        </h2>
        <ul className="mt-3 list-disc space-y-1 pl-6 text-ink-muted">
          {SCAFFOLDED_CAPABILITIES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <p role="note" className="max-w-2xl font-medium text-clay">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
