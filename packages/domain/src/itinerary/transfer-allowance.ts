import type { ActivityPace } from "@odft/contracts";
import {
  chooseRouteMode,
  haversineKm,
  type ItineraryLatLon,
  type ItineraryRouting,
} from "./assemble.js";
import { PACE_PROFILES } from "./taxonomy.js";

/**
 * Deterministic transfer-allowance pass (Phase 10). The planner proposes the
 * selection and order; the required room between consecutive located stops is
 * domain arithmetic, never model arithmetic. A live planner reliably leaves some
 * back-to-back pairs (a meal ending exactly when the next stop starts), which the
 * assembler can only report as `transfer_gap`. This pass widens each such pair —
 * by moving the later stop and everything after it — until the gap fits the
 * simulated route estimate plus the pace buffer. A stop with a fixed window (a
 * meal) is never moved past what its window allows, and genuine conflicts are
 * left for the validator to report.
 */

export type AllowanceStopKind = "meal" | "activity" | "break" | "free_time";

export interface AllowanceStop {
  readonly kind: AllowanceStopKind;
  readonly refId: string | null;
  /** Resolved location of the stop (meals and activities); breaks are unlocated. */
  readonly anchor: ItineraryLatLon | null;
  /**
   * Latest start the stop's fixed window allows (a meal's serving window end
   * minus its duration), or null when the stop is flexible.
   */
  readonly latestStartMinute: number | null;
  readonly startMinute: number;
  readonly durationMinutes: number;
}

export interface TransferAllowanceInput {
  readonly stops: readonly AllowanceStop[];
  readonly pace: ActivityPace;
  readonly adults: number;
  readonly routing: ItineraryRouting;
  readonly routingRuleVersion: string;
}

/** Required free minutes between two located stops (route estimate + pace buffer). */
function requiredMinutes(
  input: TransferAllowanceInput,
  from: ItineraryLatLon,
  to: ItineraryLatLon,
  fromRef: string,
  toRef: string,
): number {
  const profile = PACE_PROFILES[input.pace];
  const distanceKm = haversineKm(from, to);
  const mode = chooseRouteMode(distanceKm, profile.legWalkCapKm);
  const estimate = input.routing.estimate({
    startRef: fromRef,
    endRef: toRef,
    mode,
    adults: input.adults,
    start: from,
    end: to,
    ruleVersion: input.routingRuleVersion,
  });
  return estimate.estimatedMinutes + profile.bufferMinutes;
}

export function ensureTransferAllowance(input: TransferAllowanceInput): AllowanceStop[] {
  const ordered = [...input.stops].sort((a, b) => a.startMinute - b.startMinute);
  const out: AllowanceStop[] = [];
  let shift = 0;
  let previousLocated: { readonly anchor: ItineraryLatLon; readonly ref: string; readonly end: number } | null =
    null;
  let lastBlockEnd = 0;
  for (const stop of ordered) {
    let start = stop.startMinute + shift;
    if (previousLocated && stop.anchor) {
      const required = requiredMinutes(
        input,
        previousLocated.anchor,
        stop.anchor,
        previousLocated.ref,
        stop.refId ?? stop.kind,
      );
      const freeStart = Math.max(previousLocated.end, lastBlockEnd);
      const free = start - freeStart;
      if (free < required) {
        shift += required - free;
        start = stop.startMinute + shift;
      }
    }
    if (stop.latestStartMinute !== null && start > stop.latestStartMinute) {
      // A fixed window wins: the validator reports the remaining conflict instead
      // of the pass silently moving a confirmed meal time.
      start = stop.latestStartMinute;
    }
    out.push({ ...stop, startMinute: start });
    if (stop.anchor) {
      previousLocated = {
        anchor: stop.anchor,
        ref: stop.refId ?? stop.kind,
        end: start + stop.durationMinutes,
      };
      lastBlockEnd = 0;
    } else {
      lastBlockEnd = Math.max(lastBlockEnd, start + stop.durationMinutes);
    }
  }
  return out;
}