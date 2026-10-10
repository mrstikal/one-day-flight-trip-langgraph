import { DEMO_DISCLAIMER, SCAFFOLD_STATUS } from "@/lib/disclaimers";

const SCAFFOLDED_CAPABILITIES = [
  "Next.js web/BFF shell, an independent Node.js worker, and PostgreSQL are scaffolded.",
  "Strict shared packages exist only as empty boundaries; no travel domain yet.",
  "Country/city data, flights, hotels, meals, activities, AI roles, and maps are not implemented.",
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
        This deployment is the repository and runtime foundation only. It allows the team to verify
        the pinned toolchain, database setup, worker health, and test commands before any travel
        feature is built.
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
