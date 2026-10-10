import type { EventRef, SnapshotContext } from "@odft/contracts";
import { deriveEntityId } from "./ids.js";
import { createDomainFaker } from "./seed.js";

/**
 * Deterministic demo-event generator (05 sections 7-9). Events are explicitly
 * synthetic entertainment options; never a claim about a real venue program.
 */

export interface EventGenInput {
  readonly scenarioKey: string;
  readonly seed: string;
  readonly generatorVersion: string;
  readonly context: SnapshotContext;
}

const KINDS: readonly EventRef["kind"][] = ["performance", "exhibition", "festival"];
const NAMES = ["Demo Evening Performance", "Demo Local Exhibition", "Demo City Festival"];

export function generateEvents(input: EventGenInput): EventRef[] {
  const { context } = input;
  const faker = createDomainFaker(input.seed, input.scenarioKey, "events", input.generatorVersion);
  return KINDS.map((kind, index) => {
    const fraction = faker.number.float({ min: 0, max: 1 });
    const distanceKm = context.envelopeRadiusKm * 0.4 * fraction;
    const bearing = fraction * Math.PI * 2;
    const lat = context.center.lat + (distanceKm * Math.cos(bearing)) / 111;
    const lon =
      context.center.lon +
      (distanceKm * Math.sin(bearing)) /
        (111 * Math.max(0.1, Math.cos((context.center.lat * Math.PI) / 180)));
    const hour = 19 + index;
    return {
      id: deriveEntityId(input.scenarioKey, "events", index, kind),
      name: NAMES[index] ?? `Demo Event ${index}`,
      kind,
      date: context.sightseeingDate,
      startLocalTime: `${String(hour).padStart(2, "0")}:00 (simulated)`,
      durationMinutes: 90 + index * 15,
      ticketMinorPerAdult: 1200 + Math.round(fraction * 2300),
      anchor: {
        lat: Math.round(lat * 1e6) / 1e6,
        lon: Math.round(lon * 1e6) / 1e6,
        precisionMeters: 1000,
      },
      synthetic: true,
      demoLabels: ["Demo offer", "Simulated schedule/price", "Approximate location"],
    };
  });
}
