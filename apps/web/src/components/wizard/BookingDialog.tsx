"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CONFIRMATION_DISCLAIMER, DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { formatEuroMinor } from "@/lib/format/money";

/**
 * Modal booking confirmation. The body mounts only while open, so the
 * disclaimer acknowledgement resets on every close/reopen without an effect.
 */
export function BookingDialog({
  open,
  priceMinor,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  readonly open: boolean;
  readonly priceMinor: number;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): React.JSX.Element | null {
  if (!open) {
    return null;
  }
  return (
    <DialogBody
      priceMinor={priceMinor}
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function DialogBody({
  priceMinor,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  readonly priceMinor: number;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      // Return focus to the trigger so keyboard users are not dropped at the top.
      previouslyFocused?.focus?.();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) {
      return;
    }
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-dialog-heading"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex w-full max-w-lg flex-col gap-4 rounded border border-border bg-paper p-6 shadow-xl"
      >
        <h2 id="booking-dialog-heading" className="text-xl">
          Confirm this simulated booking
        </h2>
        <p className="text-sm">
          Total price <span className="font-semibold">{formatEuroMinor(priceMinor)}</span> for the
          party.
        </p>
        <p role="note" className="rounded bg-cream p-3 text-sm text-clay">
          {CONFIRMATION_DISCLAIMER}
        </p>
        <p role="note" className="text-xs text-ink-muted">
          {DEMO_DISCLAIMER}
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="I understand this is a simulated booking"
            className="mt-1"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I understand this is a simulated booking.
        </label>
        {error ? (
          <p className="text-sm text-clay" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!acknowledged || busy}
            className="rounded bg-teal px-4 py-2 text-sm font-medium text-paper hover:bg-teal-strong disabled:opacity-50"
          >
            {busy ? "Confirming…" : "Confirm simulated booking"}
          </button>
        </div>
      </div>
    </div>
  );
}
