// PDF.js names its Node-compatible distribution "legacy"; this is unrelated to uShelf schemas.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const MIN_VISIBLE_CHARACTERS = 40;

export interface ExtractedPdf {
  title: string;
  author?: string;
  markdown: string;
  pageCount: number;
}

export function decodePdfPayload(filename: string, contentBase64: string): Buffer {
  if (!filename || filename.length > 255 || !/^[^/\\\u0000-\u001f\u007f]+$/.test(filename)) {
    throw new Error("PDF filename must be a plain filename without path separators");
  }
  if (!filename.toLowerCase().endsWith(".pdf")) throw new Error("Only PDF files are supported");
  if (contentBase64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) {
    throw new Error("PDF is larger than 10 MiB");
  }
  if (!contentBase64 || contentBase64.length % 4 !== 0) {
    throw new Error("PDF content is not valid base64");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64)
    throw new Error("PDF content is not valid base64");
  if (bytes.length > MAX_PDF_BYTES) throw new Error("PDF is larger than 10 MiB");
  if (bytes.subarray(0, 1024).indexOf(Buffer.from("%PDF-")) < 0) {
    throw new Error("File content is not a valid PDF");
  }
  return bytes;
}

export async function extractPdf(bytes: Uint8Array, filename: string): Promise<ExtractedPdf> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    useSystemFonts: true,
    useWasm: false,
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error("PDF contains more than 500 pages");
    }
    const metadata = await document.getMetadata().catch(() => undefined);
    const pages: string[] = [];
    let visibleCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pageText(content.items);
      visibleCharacters += text.replace(/\s/g, "").length;
      pages.push(`## Page ${pageNumber}\n\n${text || "_No extractable text on this page._"}`);
    }
    if (visibleCharacters < MIN_VISIBLE_CHARACTERS) {
      throw new Error("PDF does not contain enough embedded text; OCR is not supported");
    }
    const markdown = pages.join("\n\n");
    if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new Error("Extracted PDF text is larger than 5 MiB");
    }
    const info = metadata?.info as { Title?: unknown; Author?: unknown } | undefined;
    const title =
      cleanMetadata(info?.Title) ?? (filename.replace(/\.pdf$/i, "").trim() || "Document");
    const author = cleanMetadata(info?.Author);
    return { title, ...(author ? { author } : {}), markdown, pageCount: document.numPages };
  } catch (error) {
    if (isPasswordError(error)) throw new Error("Encrypted PDFs are not supported");
    throw error;
  } finally {
    await loadingTask.destroy();
  }
}

function pageText(items: readonly unknown[]): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const value = String(item.str).replace(/\s+/g, " ").trim();
    if (value) line = line ? `${line} ${value}` : value;
    if ("hasEOL" in item && item.hasEOL) {
      if (line) lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

function isPasswordError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "PasswordException" || /password/i.test(error.message))
  );
}
