import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const configDir = () => {
  const dir = process.env.JEEVES_E2E_CONFIG_DIR;
  if (!dir) throw new Error("JEEVES_E2E_CONFIG_DIR is not set (see playwright.config.ts)");
  return dir;
};

const ORIGINAL_COMMENT = '# The "Plan my day" button in the app.';

test("form edit keeps comments on disk, and a stale save shows the reload prompt", async ({ page }) => {
  const file = join(configDir(), "workflows", "manual-plan.yaml");
  expect(readFileSync(file, "utf8")).toContain(ORIGINAL_COMMENT);

  // Workflows list → manual-plan editor.
  await page.goto("workflows");
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await page.getByRole("link", { name: "manual-plan", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/workflows\/manual-plan$/);
  await expect(page.getByRole("heading", { name: "manual-plan" })).toBeVisible();

  // Add a message step through the form.
  const text = `E2E hello ${Date.now()}`;
  await page.getByLabel("New step type (steps)").selectOption("message");
  await page.getByRole("button", { name: "Add step to steps" }).click();
  await page.getByLabel("Message text").last().fill(text);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  const saved = readFileSync(file, "utf8");
  expect(saved).toContain(text);
  expect(saved).toContain(ORIGINAL_COMMENT);
  expect(saved).toContain("id: plan"); // the original step is still there

  // Someone edits the file by hand meanwhile…
  appendFileSync(file, "# edited by hand\n");

  // …so the next save from the stale page is refused with the reload prompt.
  await page.getByLabel("Message text").last().fill(`${text} (again)`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This file changed elsewhere — reload?");

  // Reload shows the version on disk, including the hand edit.
  await dialog.getByRole("button", { name: "Reload" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("tab", { name: "YAML" }).click();
  await expect(page.getByLabel("Workflow YAML")).toHaveValue(/# edited by hand/);
  expect(readFileSync(file, "utf8")).not.toContain("(again)");
});

test("deep link opens the plugins page", async ({ page }) => {
  await page.goto("plugins");
  await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(page.getByText("todo", { exact: false }).first()).toBeVisible();
});
