import { describe, expect, it } from "vitest";
import { nextTripStep } from "../../apps/web/src/lib/trip-step.js";

const tripId = "11111111-1111-1111-1111-111111111111";
const reservation = (serviceKey: string, status: string) => ({ serviceKey, status });

describe("nextTripStep (no server calls)", () => {
  it("starts with flight selection until a flight is confirmed", () => {
    expect(nextTripStep({ tripId, reservations: [], hasProgram: false, hasItinerary: false })).toEqual(
      { href: `/trips/${tripId}/flights`, cta: "Go to flight selection" },
    );
  });

  it("advances through hotel, meals, and activities as steps complete", () => {
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed")],
        hasProgram: false,
        hasItinerary: false,
      }),
    ).toEqual({ href: `/trips/${tripId}/hotel`, cta: "Continue to hotel selection" });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: false,
        hasItinerary: false,
      }),
    ).toEqual({ href: `/trips/${tripId}/meals`, cta: "Continue to meals" });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: false,
      }),
    ).toEqual({ href: `/trips/${tripId}/activities`, cta: "Review activities" });
  });

  it("ignores non-confirmed reservations and ends once the itinerary exists", () => {
    expect(
      nextTripStep({
        tripId,
        reservations: [
          reservation("flights", "confirmed"),
          reservation("hotel", "superseded"),
          reservation("breakfast", "confirmed"),
        ],
        hasProgram: false,
        hasItinerary: false,
      }),
    ).toEqual({ href: `/trips/${tripId}/hotel`, cta: "Continue to hotel selection" });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: true,
      }),
    ).toBeNull();
  });
});