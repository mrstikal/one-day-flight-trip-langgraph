import type { Pool } from "pg";
import {
  tripPreferencesSchema,
  type DomainCommand,
} from "@odft/contracts";
import { insertEvent } from "./events.js";
import { lockTrip } from "./trips.js";

/**
 * Apply one admitted domain command to the trip's route/preference columns
 * (Phase 06). Worker writes never advance `trip.revision`; they only mutate the
 * trip inputs the graph then revalidates. The function is deterministic and
 * idempotent, so a crash-before-checkpoint replay applies the same values.
 */

export interface ApplyTripCommandResult {
  readonly outcome: "applied" | "noop";
  /** True when origin/city/date/variant changed and route evidence is now stale. */
  readonly routeChanged: boolean;
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

export async function applyTripCommand(
  pool: Pool,
  input: { readonly tripId: string; readonly command: DomainCommand },
): Promise<ApplyTripCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const trip = await lockTrip(client, input.tripId);
    if (!trip) {
      await client.query("ROLLBACK");
      throw new Error(`trip ${input.tripId} not found while applying a command`);
    }

    let originAirportId = trip.originAirportId;
    let destinationCityId = trip.destinationCityId;
    let destinationCountryKey = trip.destinationCountryKey;
    let sightseeingDate = trip.sightseeingDate;
    let travelVariant = trip.travelVariant;
    let routeChanged = false;
    let preferences = trip.preferences;
    const originalPreferences = JSON.stringify(preferences);

    const command = input.command;
    switch (command.type) {
      case "set_route": {
        if (command.originAirportId !== undefined) {
          const row = await client.query<{ id: string }>(
            `SELECT id FROM odft_app.reference_airports WHERE id = $1 AND eligible_origin = true`,
            [command.originAirportId],
          );
          if (!row.rows[0]) {
            await client.query("ROLLBACK");
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
            await client.query("ROLLBACK");
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

    const preferencesChanged = JSON.stringify(preferences) !== originalPreferences;
    if (!routeChanged && !preferencesChanged) {
      await client.query("ROLLBACK");
      return { outcome: "noop", routeChanged: false };
    }

    // Changing the route (origin/destination/date/variant) invalidates any
    // confirmed reservation. Replacing a booking needs an explicit impact review
    // (Phase 07+), so refuse here instead of silently diverging from the booking.
    if (routeChanged) {
      const reservations = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM odft_app.reservations
          WHERE trip_id = $1 AND status = 'confirmed'`,
        [input.tripId],
      );
      if (Number(reservations.rows[0]?.count ?? "0") > 0) {
        await client.query("ROLLBACK");
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
        originAirportId,
        destinationCityId,
        destinationCountryKey,
        sightseeingDate,
        travelVariant,
        JSON.stringify(preferences),
      ],
    );
    await insertEvent(client, {
      tripId: input.tripId,
      type: routeChanged ? "trip.route_changed" : "trip.preferences_changed",
      payload: { command: command.type },
    });
    await client.query("COMMIT");
    return { outcome: "applied", routeChanged };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
