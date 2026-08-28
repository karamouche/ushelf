import { describe, expect, it } from "vitest";
import { decodePdfPayload, extractPdf, MAX_PDF_BYTES } from "./pdf-extractor.js";

describe("PDF ingestion", () => {
  it("rejects unsafe names, malformed payloads, non-PDF content, and oversized files", () => {
    expect(() => decodePdfPayload("../paper.pdf", "JVBERg==")).toThrow(/filename/);
    expect(() => decodePdfPayload("paper.docx", "JVBERg==")).toThrow(/Only PDF/);
    expect(() => decodePdfPayload("paper.pdf", "not base64")).toThrow(/base64/);
    expect(() =>
      decodePdfPayload("paper.pdf", Buffer.from("not a pdf").toString("base64")),
    ).toThrow(/valid PDF/);
    const oversized = Buffer.alloc(MAX_PDF_BYTES + 1, 0);
    oversized.write("%PDF-", 0, "ascii");
    expect(() => decodePdfPayload("paper.pdf", oversized.toString("base64"))).toThrow(/10 MiB/);
  });

  it("rejects PDFs without usable embedded text", async () => {
    const bytes = makePdf([""]);
    await expect(extractPdf(bytes, "scan.pdf")).rejects.toThrow(/OCR is not supported/);
  });

  it("rejects encrypted PDFs", async () => {
    const bytes = makePdf(["Secret embedded text that would otherwise be long enough."], true);
    await expect(extractPdf(bytes, "secret.pdf")).rejects.toThrow(/Encrypted PDFs/);
  });

  it("rejects PDFs with more than 500 pages", async () => {
    const bytes = makePdf(Array.from({ length: 501 }, () => ""));
    await expect(extractPdf(bytes, "long.pdf")).rejects.toThrow(/more than 500 pages/);
  });
});

function makePdf(pageTexts: string[], encrypted = false): Buffer {
  const pageIds = pageTexts.map((_, index) => index + 3);
  const fontId = pageTexts.length + 3;
  const contentIds = pageTexts.map((_, index) => fontId + index + 1);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
    ...pageTexts.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pageTexts.map((text) => {
      const stream = text ? `BT\n/F1 12 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET` : "";
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let encryptId: number | undefined;
  if (encrypted) {
    objects.push(
      "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>",
    );
    encryptId = objects.length;
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  const encryption = encryptId
    ? ` /Encrypt ${encryptId} 0 R /ID [<0123456789ABCDEF0123456789ABCDEF><0123456789ABCDEF0123456789ABCDEF>]`
    : "";
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}
