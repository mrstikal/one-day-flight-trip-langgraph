import { describe, expect, it } from "vitest";
import {
  hasSavedProgram,
  nextTripStep,
  recoveryOptionHref,
  tripStepStates,
} from "../../apps/web/src/lib/trip-step.js";

const tripId = "11111111-1111-1111-1111-111111111111";
const reservation = (serviceKey: string, status: string) => ({ serviceKey, status });

describe("hasSavedProgram (no server calls)", () => {
  it("does not treat the projection default program as applied", () => {
    expect(hasSavedProgram(null)).toBe(false);
    // The projection carries a program block (defaults) before the user saves it.
    expect(hasSavedProgram({ selectedMeals: { breakfast: null } })).toBe(false);
  });

  it("recognizes persisted meal selections as an applied program", () => {
    expect(hasSavedProgram({ selectedMeals: { breakfast: "b1" } })).toBe(true);
  });
});

describe("tripStepStates (no server calls)", () => {
  const byKey = (states: ReturnType<typeof tripStepStates>) =>
    Object.fromEntries(states.map((step) => [step.key, step]));

  it("unlocks each step only after its prerequisite milestone", () => {
    const fresh = byKey(
      tripStepStates({ tripId, reservations: [], hasProgram: false, hasItinerary: false }),
    );
    expect(fresh.details?.enabled).toBe(true);
    expect(fresh.destination?.enabled).toBe(true);
    expect(fresh.flights?.enabled).toBe(true);
    expect(fresh.summary?.enabled).toBe(true);
    expect(fresh.hotel?.enabled).toBe(false);
    expect(fresh.hotel?.requires).toBe("Confirm a flight first");
    expect(fresh.meals?.enabled).toBe(false);
    expect(fresh.activities?.enabled).toBe(false);
    expect(fresh.itinerary?.enabled).toBe(false);

    const flightBooked = byKey(
      tripStepStates({
        tripId,
        reservations: [reservation("flights", "confirmed")],
        hasProgram: false,
        hasItinerary: false,
      }),
    );
    expect(flightBooked.hotel?.enabled).toBe(true);
    expect(flightBooked.hotel?.requires).toBeNull();
    expect(flightBooked.meals?.enabled).toBe(false);

    const hotelBooked = byKey(
      tripStepStates({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: false,
        hasItinerary: false,
      }),
    );
    expect(hotelBooked.meals?.enabled).toBe(true);
    expect(hotelBooked.activities?.enabled).toBe(false);

    const programSaved = byKey(
      tripStepStates({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: false,
      }),
    );
    expect(programSaved.activities?.enabled).toBe(true);
    expect(programSaved.itinerary?.enabled).toBe(true);
  });

  it("marks the decision-aware step that needs the user next", () => {
    const states = tripStepStates({
      tripId,
      reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
      hasProgram: true,
      hasItinerary: false,
      pendingDecisionKind: "program_choices",
    });
    expect(states.filter((step) => step.next).map((step) => step.key)).toEqual(["meals"]);
  });
});

describe("nextTripStep (no server calls)", () => {
  it("starts with flight selection until a flight is confirmed", () => {
    expect(nextTripStep({ tripId, reservations: [], hasProgram: false, hasItinerary: false })).toEqual(
      {
        href: `/trips/${tripId}/flights`,
        cta: "Go to flight selection",
        open: "Open flight selection",
      },
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
    ).toEqual({
      href: `/trips/${tripId}/hotel`,
      cta: "Continue to hotel selection",
      open: "Open hotel selection",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: false,
        hasItinerary: false,
      }),
    ).toEqual({
      href: `/trips/${tripId}/meals`,
      cta: "Continue to meals",
      open: "Open meals",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: false,
      }),
    ).toEqual({
      href: `/trips/${tripId}/activities`,
      cta: "Review activities",
      open: "Open activities",
    });
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
    ).toEqual({
      href: `/trips/${tripId}/hotel`,
      cta: "Continue to hotel selection",
      open: "Open hotel selection",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: true,
      }),
    ).toBeNull();
  });

  it("lets a pending decision win over progress (confirmed-hotel replacement)", () => {
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: false,
        pendingDecisionKind: "hotel_choice",
      }),
    ).toEqual({
      href: `/trips/${tripId}/hotel`,
      cta: "Choose a different hotel",
      open: "Open hotel selection",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed")],
        hasProgram: false,
        hasItinerary: false,
        pendingDecisionKind: "flight_choice",
      }),
    ).toEqual({
      href: `/trips/${tripId}/flights`,
      cta: "Choose a different flight",
      open: "Open flight selection",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: false,
        hasItinerary: false,
        pendingDecisionKind: "program_choices",
      }),
    ).toEqual({
      href: `/trips/${tripId}/meals`,
      cta: "Continue to meals",
      open: "Open meals",
    });
  });

  it("maps confirmations to the proposal's service and approvals to the itinerary", () => {
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: false,
        pendingDecisionKind: "replacement_confirmation",
        proposalServiceKey: "hotel",
      }),
    ).toEqual({
      href: `/trips/${tripId}/hotel`,
      cta: "Choose a different hotel",
      open: "Open hotel selection",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: false,
        pendingDecisionKind: "booking_confirmation",
        proposalServiceKey: "dinner",
      }),
    ).toEqual({
      href: `/trips/${tripId}/meals`,
      cta: "Continue to meals",
      open: "Open meals",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: true,
        pendingDecisionKind: "itinerary_approval",
      }),
    ).toEqual({
      href: `/trips/${tripId}/itinerary`,
      cta: "Open the itinerary",
      open: "Open the itinerary",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: true,
        pendingDecisionKind: "route_change_confirmation",
      }),
    ).toEqual({
      href: `/trips/${tripId}/flights`,
      cta: "Choose a different flight",
      open: "Open flight selection",
    });
  });

  it("falls back to progress for decision kinds presented elsewhere", () => {
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed")],
        hasProgram: false,
        hasItinerary: false,
        pendingDecisionKind: "recovery",
      }),
    ).toEqual({
      href: `/trips/${tripId}/hotel`,
      cta: "Continue to hotel selection",
      open: "Open hotel selection",
    });
    expect(
      nextTripStep({
        tripId,
        reservations: [reservation("flights", "confirmed"), reservation("hotel", "confirmed")],
        hasProgram: true,
        hasItinerary: false,
        pendingDecisionKind: "booking_confirmation",
        proposalServiceKey: null,
      }),
    ).toEqual({
      href: `/trips/${tripId}/activities`,
      cta: "Review activities",
      open: "Open activities",
    });
  });
});
describe("recoveryOptionHref (recovery card navigation)", () => {
  it("sends the option to the step it reopens and stays for change_program", () => {
    expect(recoveryOptionHref(tripId, "change_hotel")).toBe(`/trips/${tripId}/hotel`);
    expect(recoveryOptionHref(tripId, "change_meals")).toBe(`/trips/${tripId}/meals`);
    // A `change_program` research failure ends the run on the affected page.
    expect(recoveryOptionHref(tripId, "change_program")).toBeNull();
    expect(recoveryOptionHref(tripId, "unknown_option")).toBeNull();
  });
});
