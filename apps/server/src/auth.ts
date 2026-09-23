import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CLAIM_TTL_MS = 30 * 60 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;

export interface RemoteAuth {
  auth: {
    handler(request: Request): Promise<Response>;
    api: {
      getSession(input: { headers: Headers }): Promise<{ user: Record<string, unknown> } | null>;
      signUpEmail(input: {
        body: { email: string; password: string; name: string };
      }): Promise<unknown>;
    };
    $context: Promise<{ password: { hash(password: string): Promise<string> } }>;
  };
  claimCode?: string;
  isClaimed(): boolean;
  claim(input: { code: string; email: string; password: string; name?: string }): Promise<void>;
  issuePasswordReset(): { code: string; expiresAt: string };
  resetPassword(input: { code: string; password: string }): Promise<void>;
  close(): void;
}

export async function createRemoteAuth(options: {
  authDir: string;
  publicUrl: URL;
  suppliedSecret?: string;
}): Promise<RemoteAuth> {
  await fs.mkdir(options.authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(options.authDir, 0o700);
  const secret = options.suppliedSecret || (await loadOrCreateSecret(options.authDir));
  if (secret.length < 32) throw new Error("USHELF_AUTH_SECRET must contain at least 32 characters");

  const databasePath = path.join(options.authDir, "auth.db");
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  const config = authOptions(database, secret, options.publicUrl);
  await (await getMigrations(config)).runMigrations();
  database.exec(`
    CREATE TABLE IF NOT EXISTS ushelf_auth_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER
    )
  `);
  const auth = instantiateAuth(database, secret, options.publicUrl);
  const ownerCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number }).count,
  );
  const claimCode = ownerCount === 0 ? randomBytes(24).toString("base64url") : undefined;
  const claimExpiresAt = claimCode ? Date.now() + CLAIM_TTL_MS : 0;
  let claimInProgress = false;

  const isClaimed = () =>
    Number(
      (database.prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number }).count,
    ) > 0;

  return {
    auth,
    ...(claimCode ? { claimCode } : {}),
    isClaimed,
    async claim(input) {
      if (claimInProgress || isClaimed()) {
        throw new Error("This uShelf installation has already been claimed");
      }
      if (!claimCode || Date.now() > claimExpiresAt || !safeEqual(input.code, claimCode)) {
        throw new Error("The claim code is invalid or expired");
      }
      claimInProgress = true;
      try {
        await auth.api.signUpEmail({
          body: {
            email: input.email.trim().toLowerCase(),
            password: input.password,
            name: input.name?.trim() || input.email.trim(),
          },
        });
      } catch (error) {
        claimInProgress = false;
        throw error;
      }
    },
    issuePasswordReset() {
      if (!isClaimed()) throw new Error("This uShelf installation has not been claimed");
      const code = randomBytes(24).toString("base64url");
      const expiresAt = Date.now() + RESET_TTL_MS;
      database
        .prepare(
          `INSERT INTO ushelf_auth_state (key, value, expires_at) VALUES ('password-reset', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
        )
        .run(code, expiresAt);
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    },
    async resetPassword(input) {
      const reset = database
        .prepare(
          "SELECT value, expires_at AS expiresAt FROM ushelf_auth_state WHERE key = 'password-reset'",
        )
        .get() as { value: string; expiresAt: number } | undefined;
      if (!reset || reset.expiresAt < Date.now() || !safeEqual(input.code, reset.value)) {
        throw new Error("The password-reset code is invalid or expired");
      }
      if (input.password.length < 12)
        throw new Error("Password must contain at least 12 characters");
      const context = await auth.$context;
      const passwordHash = await context.password.hash(input.password);
      const transaction = database.transaction(() => {
        database
          .prepare(`UPDATE account SET password = ? WHERE providerId = 'credential'`)
          .run(passwordHash);
        database.prepare("DELETE FROM session").run();
        database.prepare("DELETE FROM ushelf_auth_state WHERE key = 'password-reset'").run();
      });
      transaction.immediate();
    },
    close() {
      database.close();
    },
  };
}

function authOptions(database: Database.Database, secret: string, publicUrl: URL) {
  return {
    database,
    secret,
    baseURL: publicUrl.origin,
    basePath: "/api/auth",
    trustedOrigins: [publicUrl.origin],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    rateLimit: { enabled: true, window: 60, max: 20, storage: "database" as const },
    advanced: { useSecureCookies: true },
  };
}

function instantiateAuth(database: Database.Database, secret: string, publicUrl: URL) {
  return betterAuth(authOptions(database, secret, publicUrl));
}

async function loadOrCreateSecret(authDir: string): Promise<string> {
  const secretPath = path.join(authDir, "signing-secret");
  try {
    return (await fs.readFile(secretPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secret = randomBytes(48).toString("base64url");
  try {
    await fs.writeFile(secretPath, `${secret}\n`, { mode: 0o600, flag: "wx" });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await fs.readFile(secretPath, "utf8")).trim();
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
