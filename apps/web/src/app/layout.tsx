import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { DEMO_DISCLAIMER } from "@/lib/disclaimers";

export const metadata: Metadata = {
  title: "AI Travel Planner",
  description: "Demo AI travel planner for one sightseeing day in a European city.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-cream text-ink">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-teal focus:px-4 focus:py-2 focus:text-paper"
        >
          Skip to content
        </a>
        <header className="border-b border-border bg-paper">
          <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-4">
            <p className="font-serif text-lg font-semibold">AI Travel Planner</p>
            <p role="note" className="text-sm text-clay">
              {DEMO_DISCLAIMER}
            </p>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">
          {children}
        </main>
        <footer className="border-t border-border bg-paper">
          <div className="mx-auto max-w-5xl px-4 py-4">
            <p role="note" className="text-sm text-ink-muted">
              {DEMO_DISCLAIMER}
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
