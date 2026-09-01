import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/persistence/sqlite/schema.ts",
  out: "./drizzle",
});
