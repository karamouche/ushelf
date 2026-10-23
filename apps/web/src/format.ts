import type { ItemSummary, ReadingStatus } from "./api.js";

export const statuses: Array<{ value: "" | ReadingStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "inbox", label: "Inbox" },
  { value: "reading", label: "Reading" },
  { value: "read", label: "Read" },
  { value: "archived", label: "Archived" },
];

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function sourceTypeLabel(value: ItemSummary["sourceType"]): string {
  switch (value) {
    case "article":
      return "Article";
    case "document":
      return "Document";
    case "x":
      return "X";
  }
}

export function stateLabel(value: string) {
  return (
    (
      {
        ready: "Ready",
        awaiting_source: "Needs source",
        awaiting_enrichment: "Needs description",
        failed: "Failed",
        extracting: "Extracting",
      } as Record<string, string>
    )[value] ?? value
  );
}
