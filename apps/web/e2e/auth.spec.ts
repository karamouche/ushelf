import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { expect, test } from "@playwright/test";

const password = "browser-test-secret";
let server: ChildProcess;
let baseUrl: string;

test.beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const chosen = typeof address === "object" && address ? address.port : 0;
      listener.close(() => resolve(chosen));
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["apps/web/e2e/auth-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      USHELF_PORT: String(port),
      USHELF_APP_PASSWORD: password,
    },
    stdio: "ignore",
  });
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${baseUrl}/api/health`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(200);
});

test.afterAll(async () => {
  server?.kill();
});

test("sign-in protects the reader and API, and sign-out removes access", async ({
  page,
  context,
}) => {
  const unauthorized = await context.request.get(`${baseUrl}/api/items`);
  expect(unauthorized.status()).toBe(401);

  await page.goto(`${baseUrl}/items/example`);
  await expect(page.getByRole("heading", { name: "uShelf" })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/login/);

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/items\/example$/);
  await expect(page.getByText("This piece could not be opened")).toBeVisible();

  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "Everything" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  expect((await context.request.get(`${baseUrl}/api/items`)).status()).toBe(401);

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Everything" })).toBeVisible();
  await context.clearCookies();
  await page.reload();
  await expect(page).toHaveURL(/\/auth\/login/);
});
