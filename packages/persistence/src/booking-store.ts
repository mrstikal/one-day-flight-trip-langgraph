import type { Pool, PoolClient } from "pg";
import type {
  BookableKey,
  BookingEventInput,
  BookingStore,
  BookingTx,
  CurrentApprovals,
  EffectKey,
  InsertProposalInput,
  InsertReservationInput,
  OfferRecord,
  OperationRef,
  ProposalStatus,
  SelectionUpsertInput,
  TripRecord,
} from "@odft/contracts";
import { loadDecision, resolveDecision } from "./decisions.js";
import { readEffect, writeEffect } from "./effects.js";
import { insertEvent } from "./events.js";
import { loadOperationById } from "./operations.js";
import { getProposal, insertProposal, markProposalResolved } from "./proposals.js";
import {
  getActiveReservation,
  getReservationByConfirmationKey,
  insertReservationWithGeneratedReference,
  supersedeReservation,
} from "./reservations.js";
import { currentApprovalGuard } from "./scenario/validations.js";
import { lockTrip, upsertSelection } from "./trips.js";

/** Postgres-backed implementation of the `BookingStore` port (one tx per call). */
export class PostgresBookingStore implements BookingStore {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (tx: BookingTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PostgresBookingTx(client);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Do not let a dead-connection rollback mask the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

const VALID_VARIANTS = new Set(["one_night", "two_nights"]);

class PostgresBookingTx implements BookingTx {
  constructor(private readonly client: PoolClient) {}

  lockTrip(tripId: string): Promise<TripRecord | undefined> {
    return lockTrip(this.client, tripId);
  }

  loadOperation(operationId: string): Promise<OperationRef | undefined> {
    return loadOperationById(this.client, operationId);
  }

  async loadCurrentApprovals(tripId: string): Promise<CurrentApprovals> {
    return currentApprovalGuard(this.client, tripId);
  }

  loadDecision(decisionId: string) {
    return loadDecision(this.client, decisionId);
  }

  loadProposal(tripId: string, proposalId: string) {
    return getProposal(this.client, tripId, proposalId);
  }

  async loadOffer(
    snapshotId: string,
    serviceKey: BookableKey,
    offerId: string,
  ): Promise<OfferRecord | undefined> {
    const result = await this.client.query<{ offer: unknown }>(
      `SELECT inventory -> 'offers' -> $2::text -> $3::text AS offer
         FROM odft_app.scenario_snapshots WHERE id = $1`,
      [snapshotId, serviceKey, offerId],
    );
    const offer = result.rows[0]?.offer as
      | { partyTotalMinor?: unknown; adults?: unknown; supportedVariants?: unknown }
      | null
      | undefined;
    if (!offer || typeof offer.partyTotalMinor !== "number" || typeof offer.adults !== "number") {
      return undefined;
    }
    const variants = Array.isArray(offer.supportedVariants)
      ? offer.supportedVariants.filter((value): value is string => typeof value === "string")
      : [];
    if (variants.length === 0 || !variants.every((variant) => VALID_VARIANTS.has(variant))) {
      return undefined;
    }
    return {
      offerId,
      serviceKey,
      snapshotId,
      partyTotalMinor: offer.partyTotalMinor,
      adults: offer.adults,
      supportedVariants: variants as ("one_night" | "two_nights")[],
      synthetic: true,
    };
  }

  getActiveReservation(tripId: string, serviceKey: BookableKey) {
    return getActiveReservation(this.client, tripId, serviceKey);
  }

  getReservationByConfirmationKey(tripId: string, confirmationKey: string) {
    return getReservationByConfirmationKey(this.client, tripId, confirmationKey);
  }

  async supersedeProposals(tripId: string, serviceKey: BookableKey): Promise<void> {
    await this.client.query(
      `UPDATE odft_app.selection_proposals SET status = 'superseded', resolved_at = now()
        WHERE trip_id = $1 AND service_key = $2 AND status = 'proposed'`,
      [tripId, serviceKey],
    );
  }

  insertProposal(input: InsertProposalInput) {
    return insertProposal(this.client, input);
  }

  markProposalResolved(proposalId: string, status: ProposalStatus) {
    return markProposalResolved(this.client, proposalId, status);
  }

  resolveDecision(decisionId: string): Promise<void> {
    return resolveDecision(this.client, decisionId, "resolved");
  }

  supersedeReservation(reservationId: string, supersededBy?: string) {
    return supersedeReservation(this.client, reservationId, supersededBy);
  }

  insertReservationWithGeneratedReference(
    input: InsertReservationInput,
    generateReference: (service: BookableKey) => string,
    attempts: number,
  ) {
    return insertReservationWithGeneratedReference(this.client, input, generateReference, attempts);
  }

  upsertSelection(input: SelectionUpsertInput): Promise<void> {
    return upsertSelection(this.client, input);
  }

  recordEvent(input: BookingEventInput): Promise<void> {
    return insertEvent(this.client, {
      tripId: input.tripId,
      type: input.type,
      payload: input.payload,
    });
  }

  readEffect(key: EffectKey) {
    return readEffect(this.client, key);
  }

  writeEffect(key: EffectKey, result: unknown) {
    return writeEffect(this.client, key, result);
  }
}
