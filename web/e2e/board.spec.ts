import { test, expect } from "@playwright/test";

// End-to-end happy path: create a project through the modal, add a task, and
// confirm it renders on the board. Exercises the full stack (React -> REST ->
// Postgres -> WebSocket echo -> render).
test("create a project and add a task", async ({ page }) => {
  await page.goto("/");

  const projectName = `E2E Project ${Date.now()}`;

  // Create a project via the sidebar "+" -> modal.
  await page.getByRole("button", { name: "+", exact: true }).click();
  await page.getByPlaceholder("e.g. Website Redesign").fill(projectName);
  await page.getByRole("button", { name: "Create" }).click();

  // The new project becomes selected; its name is the board heading.
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  // Add a task via the "+ New Task" modal.
  await page.getByRole("button", { name: "+ New Task" }).click();
  await page.getByPlaceholder("What needs to be done?").fill("Ship the release");
  await page.getByRole("button", { name: "Create" }).click();

  // The card appears on the board.
  await expect(page.getByText("Ship the release")).toBeVisible();
});
