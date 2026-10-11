import type { ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { startWorker, stopWorker, resetRateLimits } from "./_worker.js";

/**
 * AC-07-1/2/5/6: from a confirmed flight the wizard continues into hotel
 * selection, a review proposal, and a simulated hotel reservation, then the
 * program choices. The confirmation dialog shows both disclaimers verbatim and
 * stays blocked until acknowledged. Runs on desktop and mobile.
 */

const DEMO_DISCLAIMER =
  "DEMO APPLICATION - No real reservations are made and no payments are processed.";
const CONFIRMATION_DISCLAIMER =
  "Simulated booking - not valid for travel, accommodation, or restaurant admission.";

const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
test.use({ baseURL: ORIGIN });
// The Phase 07 flow drives flights, hotel, and program choices through the
// worker; under the full parallel run this exceeds the 30s default.
test.setTimeout(180_000);

let worker: ChildProcess | undefined;

test.beforeAll(async () => {
  await resetRateLimits();
  worker = startWorker();
});

test.afterAll(async () => {
  await stopWorker(worker);
});

async function selectCombobox(page: Page, label: string, query: string): Promise<void> {
  const input = page.getByRole("combobox", { name: label });
  await input.click();
  await input.fill(query);
  const listbox = page.getByRole("listbox", { name: label });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").first()).toBeVisible();
  await input.press("Enter");
}

async function createTrip(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await selectCombobox(page, "Origin airport", "PRG");
  await page.getByLabel("Sightseeing date").fill("2026-12-01");
  await page.getByRole("button", { name: "Continue to destination" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Choose your destination");
  await selectCombobox(page, "Country", "Italy");
  await selectCombobox(page, "City", "Rome");
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/flights$/, { timeout: 60_000 });
  const match = /\/trips\/([0-9a-f-]+)\/flights/.exec(page.url());
  return match?.[1] ?? "";
}

async function confirmDialog(page: Page, referencePrefix: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(CONFIRMATION_DISCLAIMER, { exact: true })).toBeVisible();
  await expect(dialog.getByText(DEMO_DISCLAIMER, { exact: true })).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Confirm simulated booking" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("I understand this is a simulated booking").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const reference = page.getByTestId("demo-reference");
  await expect(reference).toBeVisible({ timeout: 60_000 });
  await expect(reference).toContainText(referencePrefix);
}

test("books a simulated flight and hotel, then saves the program choices", async ({ page }) => {
  const tripId = await createTrip(page);
  expect(tripId).not.toBe("");

  const firstFlight = page.getByRole("button", { name: "Choose this flight" }).first();
  await expect(firstFlight).toBeVisible({ timeout: 60_000 });
  await firstFlight.click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-FLT-");

  await page.getByRole("link", { name: "Continue to hotel selection" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/hotel$/, { timeout: 60_000 });
  const firstHotel = page.getByTestId("hotel-offer").first();
  await expect(firstHotel).toBeVisible({ timeout: 60_000 });
  await firstHotel.getByRole("button", { name: "Choose this hotel" }).click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await confirmDialog(page, "DEMO-HTL-");

  await page.getByRole("link", { name: "Continue to meals" }).click();
  await expect(page).toHaveURL(/\/trips\/[0-9a-f-]+\/meals$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Plan your day" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Save program" }).click();
  await expect(page.getByRole("heading", { name: "Meals and activities" })).toBeVisible({
    timeout: 60_000,
  });
});
