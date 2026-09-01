import { deflateSync } from "node:zlib";
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
    await expect(extractPdf(bytes, "scan.pdf", ITEM_ID)).rejects.toThrow(/OCR is not supported/);
  });

  it("rejects encrypted PDFs", async () => {
    const bytes = makePdf(["Secret embedded text that would otherwise be long enough."], true);
    await expect(extractPdf(bytes, "secret.pdf", ITEM_ID)).rejects.toThrow(/Encrypted PDFs/);
  });

  it("rejects PDFs with more than 500 pages", async () => {
    const bytes = makePdf(Array.from({ length: 501 }, () => ""));
    await expect(extractPdf(bytes, "long.pdf", ITEM_ID)).rejects.toThrow(/more than 500 pages/);
  });

  it("extracts meaningful raster figures into positioned local Markdown", async () => {
    const result = await extractPdf(makePdfWithImage(), "illustrated.pdf", ITEM_ID);

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ mediaType: "image/png" });
    expect([...result.assets[0]!.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(result.media).toEqual({ discovered: 1, localized: 1, omitted: 0, filtered: 0 });
    expect(result.markdown).toContain(`../../files/${ITEM_ID}/media/`);
    expect(result.markdown.indexOf("Text above the figure")).toBeLessThan(
      result.markdown.indexOf("![PDF figure"),
    );
  });

  it("recovers layout-aware Markdown, placeholder metadata, and deferred images", async () => {
    const result = await extractPdf(makeLayoutAwarePdf(), "test_document.pdf", ITEM_ID);

    expect(result.title).toBe("Test Document");
    expect(result.author).toBeUndefined();
    expect(result.markdown).toContain("### 1. Introduction");
    expect(result.markdown).toContain("#### 1.1 Purpose");
    expect(result.markdown).toContain(
      "A sample PDF generated for testing purposes includes text, headings, a table, and an image.",
    );
    expect(result.markdown).not.toContain("##### A sample PDF");
    expect(result.markdown).toContain(
      "This document was generated automatically to test wrapped paragraphs and layout-aware extraction.",
    );
    expect(result.markdown).toContain(
      [
        "| Product | Category | Units Sold | Unit Price | Revenue |",
        "| --- | --- | --- | --- | --- |",
        "| Aurora Widget | Hardware | 1,240 | $19.99 | $24,787.60 |",
      ].join("\n"),
    );
    expect(result.markdown).toContain(
      [
        "- Supports multi-page documents",
        "- Includes headings at multiple levels",
        "- Preserves simple tables and images",
      ].join("\n"),
    );
    expect(result.markdown).toContain(`## Page 2\n\n![PDF figure — page 2](`);
    expect(result.markdown).not.toContain("Image omitted");
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ mediaType: "image/png" });
    expect(result.media).toEqual({ discovered: 1, localized: 1, omitted: 0, filtered: 0 });
  });
});

const ITEM_ID = "e7cf9d0d-bba8-4b93-9503-ab8f15de9d2f";

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

function makePdfWithImage(): Buffer {
  const imageHex = "ff0000".repeat(64 * 64) + ">";
  const content =
    "BT\n/F1 12 Tf\n72 720 Td\n(Text above the figure with enough embedded text for extraction.) Tj\nET\n" +
    "q\n100 0 0 100 72 500 cm\n/Im1 Do\nQ";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${Buffer.byteLength(imageHex)} >>\nstream\n${imageHex}\nendstream`,
  ];
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
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function makeLayoutAwarePdf(): Buffer {
  const pageOne = Buffer.from(
    [
      textAt("F2", 18, 241, 714, "Test Document"),
      textAt(
        "F1",
        12,
        60,
        692,
        "A sample PDF generated for testing purposes includes text, headings, a table, and an",
      ),
      textAt("F1", 12, 60, 680, "image."),
      textAt("F2", 18, 60, 634, "1. Introduction"),
      textAt(
        "F1",
        10,
        60,
        614,
        "This document was generated automatically to test wrapped paragraphs and",
      ),
      textAt("F1", 10, 60, 602, "layout-aware extraction."),
      textAt("F2", 14, 60, 550, "1.1 Purpose"),
      textAt(
        "F1",
        10,
        60,
        530,
        "The content is illustrative and provides enough embedded text for extraction.",
      ),
      textAt("F2", 18, 60, 482, "2. Sample Data Table"),
      textAt("F1", 10, 60, 462, "The table below contains fictional product metrics."),
      tableRow("F2", 437, ["Product", "Category", "Units Sold", "Unit Price", "Revenue"]),
      tableRow("F1", 413, ["Aurora Widget", "Hardware", "1,240", "$19.99", "$24,787.60"]),
      tableRow("F1", 389, ["Nimbus Cable", "Accessory", "3,050", "$4.50", "$13,725.00"]),
      tableRow("F1", 365, ["Zephyr Case", "Accessory", "980", "$12.25", "$12,005.00"]),
    ].join("\n"),
  );
  const pageTwo = Buffer.from("q\n400 0 0 200 72 500 cm\n/Im1 Do\nQ");
  const pageThree = Buffer.from(
    [
      textAt("F2", 18, 60, 714, "3. Additional Notes"),
      textAt("F1", 10, 60, 694, "This page verifies list handling after an image-only page."),
      textAt("F1", 10, 60, 662, "- Supports multi-page documents"),
      textAt("F1", 10, 60, 646, "- Includes headings at multiple levels"),
      textAt("F1", 10, 60, 630, "- Preserves simple tables and images"),
    ].join("\n"),
  );
  const width = 600;
  const height = 300;
  const image = Buffer.alloc(width * height * 3);
  for (let offset = 0; offset < image.length; offset += 3) {
    image[offset] = Math.floor(((offset / 3) % width) / 3);
    image[offset + 1] = 120;
    image[offset + 2] = 200;
  }
  const compressedImage = deflateSync(image);
  return buildPdf(
    [
      Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
      Buffer.from("<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>"),
      Buffer.from(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R /F2 7 0 R >> >> /Contents 8 0 R >>",
      ),
      Buffer.from(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 11 0 R >> >> /Contents 9 0 R >>",
      ),
      Buffer.from(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R /F2 7 0 R >> >> /Contents 10 0 R >>",
      ),
      Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
      Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"),
      pdfStream(pageOne),
      pdfStream(pageTwo),
      pdfStream(pageThree),
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedImage.length} >>\nstream\n`,
        ),
        compressedImage,
        Buffer.from("\nendstream"),
      ]),
      Buffer.from("<< /Title (\\(anonymous\\)) /Author (\\(unspecified\\)) >>"),
    ],
    12,
  );
}

function textAt(font: string, size: number, x: number, y: number, value: string): string {
  return `BT\n/${font} ${size} Tf\n1 0 0 1 ${x} ${y} Tm\n(${escapePdfText(value)}) Tj\nET`;
}

function tableRow(font: string, y: number, values: string[]): string {
  const positions = [103, 211, 313, 388, 464];
  return values.map((value, index) => textAt(font, 9, positions[index]!, y, value)).join("\n");
}

function pdfStream(content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from("\nendstream"),
  ]);
}

function buildPdf(objects: Buffer[], infoId?: number): Buffer {
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const wrapped = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(wrapped);
    length += wrapped.length;
  }
  const xref = length;
  const entries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoId ? ` /Info ${infoId} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}
