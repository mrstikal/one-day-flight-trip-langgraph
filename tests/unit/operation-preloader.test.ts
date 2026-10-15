import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPERATION_PRELOADER_DELAY_MS,
  OperationPreloader,
} from "../../apps/web/src/lib/operation-preloader.js";

describe("OperationPreloader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("remains hidden until an operation exceeds 500 ms", () => {
    const preloader = new OperationPreloader();
    const finish = preloader.start("Saving your plan...");

    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS - 1);
    expect(preloader.getSnapshot()).toBeNull();

    vi.advanceTimersByTime(1);
    expect(preloader.getSnapshot()).toBe("Saving your plan...");

    finish();
    expect(preloader.getSnapshot()).toBeNull();
  });

  it("only shows an overlapping action after that action reaches the delay", () => {
    const preloader = new OperationPreloader();
    const finishFirst = preloader.start("Loading city data...");

    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS);
    expect(preloader.getSnapshot()).toBe("Loading city data...");

    const finishSecond = preloader.start("Waiting for the AI assistant's response...");
    finishFirst();
    expect(preloader.getSnapshot()).toBeNull();

    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS - 1);
    expect(preloader.getSnapshot()).toBeNull();

    vi.advanceTimersByTime(1);
    expect(preloader.getSnapshot()).toBe("Waiting for the AI assistant's response...");

    finishSecond();
    expect(preloader.getSnapshot()).toBeNull();
  });

  it("keeps an accepted operation visible until its projected status settles", () => {
    const preloader = new OperationPreloader();
    preloader.trackAcceptedOperation("operation-1", "Saving your plan...");

    vi.advanceTimersByTime(OPERATION_PRELOADER_DELAY_MS);
    expect(preloader.getSnapshot()).toBe("Saving your plan...");

    preloader.reconcileOperations([{ operationId: "operation-1", status: "running" }]);
    expect(preloader.getSnapshot()).toBe("Saving your plan...");

    preloader.reconcileOperations([{ operationId: "operation-1", status: "waiting_user" }]);
    expect(preloader.getSnapshot()).toBeNull();
  });
});
