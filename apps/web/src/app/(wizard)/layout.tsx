import type { ReactNode } from "react";
import { WizardDraftProvider } from "@/components/wizard/WizardDraft";

/** The two draft steps (welcome, destination) share one browser-side draft. */
export default function WizardLayout({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  return <WizardDraftProvider>{children}</WizardDraftProvider>;
}
