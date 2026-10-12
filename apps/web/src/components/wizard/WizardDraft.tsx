"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Browser-only trip draft spanning the welcome and destination steps. It holds
 * no server identifiers: the trip (and its id) does not exist until the city is
 * chosen and `POST /api/trips` is admitted. The provider is mounted in the ROOT
 * layout, so the draft survives client-side navigation across the whole app
 * (including a trip workspace round trip); a full page reload intentionally
 * starts fresh. Once `tripId` is set the draft is a read-only record: the
 * wizard only creates trips, so the draft steps render disabled and edits go
 * through the trip's own commands.
 */

export interface WizardDraft {
  userName: string;
  adults: number;
  originAirportId: string;
  originLabel: string;
  sightseeingDate: string;
  travelVariant: "one_night" | "two_nights";
  defaultServiceLevel: "budget" | "standard" | "luxury";
  activityPace: "relaxed" | "moderate" | "intensive";
  maxBudgetEur: string;
  countryKey: string;
  countryName: string;
  destinationCityId: string;
  destinationCityLabel: string;
  creationRequestId: string;
  tripId: string;
}

function emptyDraft(): WizardDraft {
  return {
    userName: "",
    adults: 1,
    originAirportId: "",
    originLabel: "",
    sightseeingDate: "",
    travelVariant: "one_night",
    defaultServiceLevel: "standard",
    activityPace: "moderate",
    maxBudgetEur: "",
    countryKey: "",
    countryName: "",
    destinationCityId: "",
    destinationCityLabel: "",
    creationRequestId: "",
    tripId: "",
  };
}

interface WizardContextValue {
  readonly draft: WizardDraft;
  update: (partial: Partial<WizardDraft>) => void;
  reset: () => void;
}

const WizardContext = createContext<WizardContextValue | null>(null);

export function WizardDraftProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const [draft, setDraft] = useState<WizardDraft>(emptyDraft);

  const update = useCallback((partial: Partial<WizardDraft>) => {
    setDraft((previous) => ({ ...previous, ...partial }));
  }, []);

  const reset = useCallback(() => setDraft(emptyDraft()), []);

  const value = useMemo(() => ({ draft, update, reset }), [draft, update, reset]);
  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizardDraft(): WizardContextValue {
  const value = useContext(WizardContext);
  if (!value) {
    throw new Error("useWizardDraft must be used inside WizardDraftProvider");
  }
  return value;
}
