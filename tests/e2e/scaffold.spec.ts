import { expect, test } from "@playwright/test";

const DEMO_DISCLAIMER =
  "DEMO APPLICATION - No real reservations are made and no payments are processed.";
const SCAFFOLD_STATUS = "Scaffold - travel planning is not implemented yet";

test("scaffold page renders an honest status and the permanent disclaimer", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/AI Travel Planner/);
  await expect(page.getByRole("heading", { level: 1, name: "AI Travel Planner" })).toBeVisible();
  await expect(page.getByText(SCAFFOLD_STATUS, { exact: true })).toBeVisible();
  await expect(page.getByText(DEMO_DISCLAIMER, { exact: true }).first()).toBeVisible();
});

test("permanent disclaimer is present in both header and footer", async ({ page }) => {
  await page.goto("/");
  const banners = page.getByText(DEMO_DISCLAIMER, { exact: true });
  await expect(banners).toHaveCount(3);
});
