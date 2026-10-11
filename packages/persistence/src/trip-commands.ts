import type { Pool, PoolClient } from "pg";
import { tripPreferencesSchema, type DomainCommand, type TripPreferences } from "@odft/contracts";
import { insertEvent } from "./events.js";
import { lockTrip } from "./trips.js";

/**
 * Apply admitted domain commands to the trip's route/preference columns
 * (Phase 06). Worker writes never advance `trip.revision`; they only mutate the
 * trip inputs the graph then revalidates.
 *
 * A batch is applied in ONE transaction after the whole batch is validated in
 * memory, so a later command that cannot be honored (e.g. a route change after a
 * confirmed reservation) leaves none of the earlier commands applied.
 */

export interface ApplyTripCommandResult {
  readonly outcome: "applied" | "noop";
  /** True when origin/city/date/variant changed and route evidence is now stale. */
  readonly routeChanged: boolean;
}

export interface ApplyTripCommandsResult extends ApplyTripCommandResult {
  /** Number of commands that actually changed trip state. */
  readonly appliedCount: number;
}

/** An Error carrying a safe domain code that the worker maps to a conflict. */
export class TripCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

interface TripRouteState {
  originAirportId: string;
  destinationCityId: string;
  destinationCountryKey: string;
  sightseeingDate: string;
  travelVariant: string;
  preferences: TripPreferences;
}

/** Apply one command to the in-memory state; reference checks read, never write. */
async function applyCommandInMemory(
  client: PoolClient,
  state: TripRouteState,
  command: DomainCommand,
): Promise<{ state: TripRouteState; routeChanged: boolean; preferencesChanged: boolean }> {
  let { originAirportId, destinationCityId, destinationCountryKey, sightseeingDate, travelVariant } =
    state;
  let preferences = state.preferences;
  let routeChanged = false;
  const originalPreferences = JSON.stringify(preferences);

  switch (command.type) {
    case "set_route": {
      if (command.originAirportId !== undefined) {
        const row = await client.query<{ id: string }>(
          `SELECT id FROM odft_app.reference_airports WHERE id = $1 AND eligible_origin = true`,
          [command.originAirportId],
        );
        if (!row.rows[0]) {
          throw new Error("origin airport is not an admitted eligible origin");
        }
        if (originAirportId !== command.originAirportId) {
          originAirportId = command.originAirportId;
          routeChanged = true;
        }
      }
      if (command.destinationCityId !== undefined) {
        const row = await client.query<{ country_key: string }>(
          `SELECT country_key FROM odft_app.reference_cities WHERE id = $1`,
          [command.destinationCityId],
        );
        const found = row.rows[0];
        if (!found) {
          throw new Error("destination city is not an admitted reference city");
        }
        if (destinationCityId !== command.destinationCityId) {
          destinationCityId = command.destinationCityId;
          destinationCountryKey = found.country_key;
          routeChanged = true;
        }
      }
      if (command.sightseeingDate !== undefined && sightseeingDate !== command.sightseeingDate) {
        sightseeingDate = command.sightseeingDate;
        routeChanged = true;
      }
      if (command.travelVariant !== undefined && travelVariant !== command.travelVariant) {
        travelVariant = command.travelVariant;
        preferences = tripPreferencesSchema.parse({
          ...preferences,
          travelVariant: command.travelVariant,
        });
        routeChanged = true;
      }
      break;
    }
    case "set_default_service_level":
      preferences = tripPreferencesSchema.parse({
        ...preferences,
        defaultServiceLevel: command.level,
      });
      break;
    case "set_service_override": {
      const overrides = { ...preferences.serviceOverrides };
      if (command.level === null) {
        delete overrides[command.service];
      } else {
        overrides[command.service] = command.level;
      }
      preferences = tripPreferencesSchema.parse({ ...preferences, serviceOverrides: overrides });
      break;
    }
    case "set_activity_pace":
      preferences = tripPreferencesSchema.parse({ ...preferences, activityPace: command.pace });
      break;
    case "set_interests":
      preferences = tripPreferencesSchema.parse({
        ...preferences,
        interests: command.interests,
        preferredActivityTags: command.preferredTags,
      });
      break;
    case "set_activity_requirement": {
      const counts = { ...preferences.minimumActivityCounts };
      if (command.minimumCount === null) {
        delete counts[command.tag];
      } else {
        counts[command.tag] = command.minimumCount;
      }
      preferences = tripPreferencesSchema.parse({
        ...preferences,
        minimumActivityCounts: counts,
      });
      break;
    }
    case "set_budget": {
      const next = { ...preferences };
      if (command.maxBudgetMinor === null) {
        delete next.maxBudgetMinor;
      } else {
        next.maxBudgetMinor = command.maxBudgetMinor;
      }
      preferences = tripPreferencesSchema.parse(next);
      break;
    }
    default:
      // Non-preference/non-route commands (find_alternatives, propose_selection,
      // set_program, build_itinerary, retry_failed_domains, set_simulation) are
      // handled by later phases; they do not mutate trip inputs here.
      break;
  }

  return {
    state: {
      originAirportId,
      destinationCityId,
      destinationCountryKey,
      sightseeingDate,
      travelVariant,
      preferences,
    },
    routeChanged,
    preferencesChanged: JSON.stringify(preferences) !== originalPreferences,
  };
}

/**
 * Apply a whole command batch atomically. Every command is validated and applied
 * in memory first; the single UPDATE and one event per applied command commit
 * together, so a batch either fully applies or leaves the trip untouched.
 */
export async function applyTripCommands(
  pool: Pool,
  input: { readonly tripId: string; readonly commands: readonly DomainCommand[] },
): Promise<ApplyTripCommandsResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const trip = await lockTrip(client, input.tripId);
    if (!trip) {
      throw new Error(`trip ${input.tripId} not found while applying commands`);
    }

    let state: TripRouteState = {
      originAirportId: trip.originAirportId,
      destinationCityId: trip.destinationCityId,
      destinationCountryKey: trip.destinationCountryKey,
      sightseeingDate: trip.sightseeingDate,
      travelVariant: trip.travelVariant,
      preferences: trip.preferences,
    };
    let routeChanged = false;
    const applied: DomainCommand[] = [];
    for (const command of input.commands) {
      const result = await applyCommandInMemory(client, state, command);
      state = result.state;
      routeChanged = routeChanged || result.routeChanged;
      if (result.routeChanged || result.preferencesChanged) {
        applied.push(command);
      }
    }

    if (applied.length === 0) {
      await client.query("ROLLBACK");
      return { outcome: "noop", routeChanged: false, appliedCount: 0 };
    }

    // Changing the route (origin/destination/date/variant) invalidates any
    // confirmed reservation. Replacing a booking needs an explicit impact review
    // (Phase 07+), so refuse the WHOLE batch instead of silently diverging.
    if (routeChanged) {
      const reservations = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.reservations
          WHERE trip_id = $1 AND status = 'confirmed'`,
        [input.tripId],
      );
      if (Number(reservations.rows[0]?.count ?? "0") > 0) {
        throw new TripCommandError(
          "REPLACEMENT_CONFIRMATION_REQUIRED",
          "changing the route after a confirmed reservation requires an impact review",
        );
      }
    }

    await client.query(
      `UPDATE odft_app.trips
          SET origin_airport_id = $2, destination_city_id = $3, destination_country_key = $4,
              sightseeing_date = $5, travel_variant = $6, preferences = $7::jsonb, updated_at = now()
        WHERE id = $1`,
      [
        input.tripId,
        state.originAirportId,
        state.destinationCityId,
        state.destinationCountryKey,
        state.sightseeingDate,
        state.travelVariant,
        JSON.stringify(state.preferences),
      ],
    );
    for (const command of applied) {
      await insertEvent(client, {
        tripId: input.tripId,
        type: routeChanged ? "trip.route_changed" : "trip.preferences_changed",
        payload: { command: command.type },
      });
    }
    await client.query("COMMIT");
    return { outcome: "applied", routeChanged, appliedCount: applied.length };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Apply a single admitted command (atomic batch of one). */
export async function applyTripCommand(
  pool: Pool,
  input: { readonly tripId: string; readonly command: DomainCommand },
): Promise<ApplyTripCommandResult> {
  const result = await applyTripCommands(pool, {
    tripId: input.tripId,
    commands: [input.command],
  });
  return { outcome: result.outcome, routeChanged: result.routeChanged };
}
