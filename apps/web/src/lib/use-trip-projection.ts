"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TripProjection } from "@odft/contracts";
import { ApiError, apiGet } from "./api-client";

const POLL_INTERVAL_MS = 1500;

interface ProjectionState {
  readonly projection: TripProjection | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
}

function hasActiveWork(projection: TripProjection): boolean {
  return projection.operations.some(
    (operation) => operation.status === "queued" || operation.status === "running",
  );
}

/**
 * Own projection reader. Polls while the worker has active work and refetches on
 * demand (e.g. after a resume or an SSE event). It never triggers work.
 */
export function useTripProjection(tripId: string): ProjectionState & {
  readonly refresh: () => void;
} {
  const [state, setState] = useState<ProjectionState>({
    projection: null,
    error: null,
    loading: true,
  });
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const projection = await apiGet<TripProjection>(`/api/trips/${tripId}`);
      if (!mounted.current) {
        return;
      }
      setState({ projection, error: null, loading: false });
      if (hasActiveWork(projection)) {
        timer.current = setTimeout(() => void load(), POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (!mounted.current) {
        return;
      }
      setState((previous) => ({
        projection: previous.projection,
        error: error instanceof ApiError ? error : null,
        loading: false,
      }));
    } finally {
      inFlight.current = false;
    }
  }, [tripId]);

  const refresh = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    void load();
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, [load]);

  return { ...state, refresh };
}
