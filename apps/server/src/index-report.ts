import type { IndexReport } from "@ushelf/core";

/** Names each item file the index left out, so the owner can repair or remove it. */
export function warnSkippedItems({ skipped }: IndexReport): void {
  for (const { filePath, error } of skipped)
    console.warn(`Skipped ${filePath} while indexing the library: ${error}`);
}
