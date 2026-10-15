export const OPERATION_PRELOADER_DELAY_MS = 500;

interface ActiveOperation {
  readonly message: string;
  readonly startedAt: number;
}

interface ProjectedOperationStatus {
  readonly operationId: string;
  readonly status: string;
}

/**
 * Tracks user-initiated requests and exposes the most recent request that has
 * exceeded the display delay.
 */
export class OperationPreloader {
  private readonly activeOperations = new Map<number, ActiveOperation>();
  private readonly listeners = new Set<() => void>();
  private readonly trackedOperations = new Map<string, () => void>();
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private message: string | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): string | null => this.message;

  start(message: string): () => void {
    const id = this.nextId;
    this.nextId += 1;
    this.activeOperations.set(id, { message, startedAt: Date.now() });
    this.update();

    return () => {
      if (this.activeOperations.delete(id)) {
        this.update();
      }
    };
  }

  /**
   * Keep accepted background work visible until a projection reports that the
   * operation is no longer queued or running.
   */
  trackAcceptedOperation(operationId: string, message: string): void {
    if (this.trackedOperations.has(operationId)) {
      return;
    }
    this.trackedOperations.set(operationId, this.start(message));
  }

  reconcileOperations(operations: readonly ProjectedOperationStatus[]): void {
    const statusByOperationId = new Map(
      operations.map((operation) => [operation.operationId, operation.status]),
    );

    for (const [operationId, finish] of this.trackedOperations) {
      const status = statusByOperationId.get(operationId);
      if (status !== undefined && status !== "queued" && status !== "running") {
        this.trackedOperations.delete(operationId);
        finish();
      }
    }
  }

  private update(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    const now = Date.now();
    const eligible = [...this.activeOperations.values()].filter(
      (operation) => now - operation.startedAt >= OPERATION_PRELOADER_DELAY_MS,
    );
    const nextMessage = eligible.at(-1)?.message ?? null;

    if (this.message !== nextMessage) {
      this.message = nextMessage;
      for (const listener of this.listeners) {
        listener();
      }
    }

    const nextVisibleAt = [...this.activeOperations.values()]
      .filter((operation) => now - operation.startedAt < OPERATION_PRELOADER_DELAY_MS)
      .reduce<number | null>(
        (earliest, operation) =>
          earliest === null
            ? operation.startedAt + OPERATION_PRELOADER_DELAY_MS
            : Math.min(earliest, operation.startedAt + OPERATION_PRELOADER_DELAY_MS),
        null,
      );

    if (nextVisibleAt !== null) {
      this.timeout = setTimeout(() => this.update(), Math.max(0, nextVisibleAt - now));
    }
  }
}

export const operationPreloader = new OperationPreloader();

export async function runWithOperationPreloader<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  const finish = operationPreloader.start(message);
  try {
    return await operation();
  } finally {
    finish();
  }
}
