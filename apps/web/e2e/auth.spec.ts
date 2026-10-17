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

test("connector consent sends the browser back to the app with a code", async ({ page }) => {
  const callback = "http://localhost:5555/callback";
  const registration = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Browser connector",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id: clientId } = (await registration.json()) as { client_id: string };

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    state: "browser-state",
  });
  await page.goto(`${baseUrl}/oauth/authorize?${params}`);
  await expect(page.getByText("Browser connector")).toBeVisible();
  await page.getByLabel("uShelf password").fill(password);
  // The approval POST relies on the browser's real Origin header; a policy that makes it
  // `null` leaves the user on an error page instead of returning to the app.
  const [returning] = await Promise.all([
    page.waitForRequest((request) => request.url().startsWith(`${callback}?`)),
    page.getByRole("button", { name: "Allow access" }).click(),
  ]);
  const returned = new URL(returning.url());
  expect(returned.searchParams.get("code")).toBeTruthy();
  expect(returned.searchParams.get("state")).toBe("browser-state");
});
