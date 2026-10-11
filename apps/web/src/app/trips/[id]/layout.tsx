import type { ReactNode } from "react";
import { ConversationRail } from "@/components/assistant/conversation-rail";

export const dynamic = "force-dynamic";

/** Trip workspace: the step content plus the persistent assistant rail. */
export default async function TripLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">{children}</div>
      <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-6rem)]">
        <ConversationRail tripId={id} />
      </div>
    </div>
  );
}
