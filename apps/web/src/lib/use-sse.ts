"use client";

import { useEffect, useState } from "react";

/**
 * SSE projection wake-up. The stream is an enhancement: the caller still polls
 * while work is active and refreshes explicitly after each user action, so a
 * blocked or unsupported stream degrades to polling.
 *
 * The server emits *named* events (`event: decision.awaiting`, ...), so a plain
 * `onmessage` handler would never fire. We subscribe to the concrete event names
 * the worker writes; unknown future types still arrive via polling.
 */
const PROJECTION_EVENTS = [
  "operation.admitted",
  "operation.succeeded",
  "operation.failed",
  "operation.requeued",
  "operation.retry_requested",
  "decision.admitted",
  "decision.awaiting",
  "decision.resolved",
  "booking.confirmed",
  "trip.route_changed",
  "trip.preferences_changed",
  "node.updated",
] as const;

export function useTripEvents(
  tripId: string,
  onEvent: () => void,
): { readonly supported: boolean; readonly reconnecting: boolean } {
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return undefined;
    }
    const source = new EventSource(`/api/trips/${tripId}/events`);
    const fire = (): void => onEvent();
    for (const type of PROJECTION_EVENTS) {
      source.addEventListener(type, fire);
    }
    source.addEventListener("message", fire);
    source.addEventListener("open", () => setReconnecting(false));
    source.addEventListener("error", () => {
      // The browser reconnects EventSource automatically; polling covers the gap.
      setReconnecting(true);
    });
    return () => source.close();
  }, [tripId, onEvent]);

  return {
    supported: typeof window !== "undefined" && typeof EventSource !== "undefined",
    reconnecting,
  };
}
