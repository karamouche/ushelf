import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
// PDF.js names its Node-compatible distribution "legacy"; this is unrelated to uShelf schemas.
import { getDocument, ImageKind, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { MediaCaptureStats } from "../domain/library-item.js";
import type { MediaAsset } from "./media-localizer.js";
import { mediaPath } from "./media-localizer.js";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const MIN_VISIBLE_CHARACTERS = 40;
const MIN_IMAGE_PIXELS = 64;
const MIN_RENDERED_POINTS = 32;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export interface ExtractedPdf {
  title: string;
  author?: string;
  markdown: string;
  pageCount: number;
  assets: MediaAsset[];
  media: MediaCaptureStats;
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

export async function extractPdf(
  bytes: Uint8Array,
  filename: string,
  itemId: string,
): Promise<ExtractedPdf> {
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
    const assets = new Map<string, MediaAsset>();
    const media: MediaCaptureStats = { discovered: 0, localized: 0, omitted: 0, filtered: 0 };
    let mediaBytes = 0;
    let visibleCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [content, operatorList] = await Promise.all([
        page.getTextContent(),
        page.getOperatorList(),
      ]);
      const textBlocks = pageTextBlocks(content.items);
      const figureResult = pageFigures(page, operatorList.fnArray, operatorList.argsArray);
      const figures = figureResult.figures;
      const blocks: PositionedBlock[] = [...textBlocks];
      media.discovered += figures.length + figureResult.filtered + figureResult.omitted.length;
      media.filtered += figureResult.filtered;
      media.omitted += figureResult.omitted.length;
      for (const y of figureResult.omitted) {
        blocks.push({ y, markdown: "*Image omitted: unsupported PDF figure.*" });
      }
      for (const figure of figures) {
        if (
          figure.width < MIN_IMAGE_PIXELS ||
          figure.height < MIN_IMAGE_PIXELS ||
          figure.renderedWidth < MIN_RENDERED_POINTS ||
          figure.renderedHeight < MIN_RENDERED_POINTS
        ) {
          media.filtered += 1;
          continue;
        }
        if (figure.width * figure.height > MAX_IMAGE_PIXELS) {
          media.omitted += 1;
          blocks.push({ y: figure.y, markdown: "*Image omitted: PDF figure is too large.*" });
          continue;
        }
        try {
          const png = encodePng(figure);
          const digest = createHash("sha256").update(png).digest("hex");
          const filename = `${digest}.png`;
          if (!assets.has(filename)) {
            if (mediaBytes + png.byteLength > MAX_MEDIA_BYTES) throw new Error("media limit");
            mediaBytes += png.byteLength;
            assets.set(filename, { filename, mediaType: "image/png", bytes: png });
          }
          media.localized += 1;
          blocks.push({
            y: figure.y,
            markdown: `![PDF figure — page ${pageNumber}](${mediaPath(itemId, filename)})`,
          });
        } catch {
          media.omitted += 1;
          blocks.push({ y: figure.y, markdown: "*Image omitted: PDF figure.*" });
        }
      }
      blocks.sort((left, right) => right.y - left.y);
      const text = blocks
        .map((block) => block.markdown)
        .join("\n\n")
        .trim();
      visibleCharacters += textBlocks
        .map((block) => block.markdown)
        .join("")
        .replace(/\s/g, "").length;
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
    return {
      title,
      ...(author ? { author } : {}),
      markdown,
      pageCount: document.numPages,
      assets: [...assets.values()],
      media,
    };
  } catch (error) {
    if (isPasswordError(error)) throw new Error("Encrypted PDFs are not supported");
    throw error;
  } finally {
    await loadingTask.destroy();
  }
}

interface PositionedBlock {
  y: number;
  markdown: string;
}

interface PdfFigure {
  width: number;
  height: number;
  renderedWidth: number;
  renderedHeight: number;
  y: number;
  kind: number;
  data: Uint8Array;
}

function pageTextBlocks(items: readonly unknown[]): PositionedBlock[] {
  const lines: PositionedBlock[] = [];
  let line = "";
  let lineY = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const value = String(item.str).replace(/\s+/g, " ").trim();
    if (value) {
      const itemY =
        "transform" in item && Array.isArray(item.transform)
          ? Number(item.transform[5] ?? lineY)
          : lineY;
      if (line && Math.abs(itemY - lineY) > 2) {
        lines.push({ y: lineY, markdown: line });
        line = "";
      }
      if (!line) lineY = itemY;
      line = line ? `${line} ${value}` : value;
    }
    if ("hasEOL" in item && item.hasEOL) {
      if (line) lines.push({ y: lineY, markdown: line });
      line = "";
    }
  }
  if (line) lines.push({ y: lineY, markdown: line });
  return lines;
}

function pageFigures(
  page: { objs: { get(id: string): unknown }; commonObjs: { get(id: string): unknown } },
  operations: number[],
  argumentsList: unknown[][],
): { figures: PdfFigure[]; filtered: number; omitted: number[] } {
  const figures: PdfFigure[] = [];
  const omitted: number[] = [];
  let filtered = 0;
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const args = argumentsList[index] ?? [];
    if (operation === OPS.save) stack.push([...matrix]);
    else if (operation === OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (operation === OPS.transform) matrix = multiply(matrix, numericMatrix(args));
    else if (operation === OPS.paintInlineImageXObject) {
      const figure = imageFigure(args[0], matrix);
      figure ? figures.push(figure) : omitted.push(matrix[5]);
    } else if (operation === OPS.paintInlineImageXObjectGroup) {
      const image = args[0];
      const maps = Array.isArray(args[1]) ? args[1] : [];
      for (const entry of maps) {
        const transform =
          entry &&
          typeof entry === "object" &&
          "transform" in entry &&
          Array.isArray(entry.transform)
            ? numericMatrix(entry.transform)
            : ([1, 0, 0, 1, 0, 0] as Matrix);
        const positioned = multiply(matrix, transform);
        const figure = imageFigure(image, positioned);
        figure ? figures.push(figure) : omitted.push(positioned[5]);
      }
    } else if (operation === OPS.paintImageXObject) {
      const id = String(args[0] ?? "");
      try {
        const image = id.startsWith("g_") ? page.commonObjs.get(id) : page.objs.get(id);
        const figure = imageFigure(image, matrix);
        figure ? figures.push(figure) : omitted.push(matrix[5]);
      } catch {
        omitted.push(matrix[5]);
      }
    } else if (operation === OPS.paintImageXObjectRepeat) {
      const id = String(args[0] ?? "");
      const scaleX = Number(args[1] ?? 0);
      const scaleY = Number(args[2] ?? 0);
      const positions = Array.isArray(args[3])
        ? args[3]
        : ArrayBuffer.isView(args[3]) && "length" in args[3]
          ? Array.from(args[3] as unknown as ArrayLike<number>)
          : [];
      for (let position = 0; position < positions.length; position += 2) {
        const positioned = multiply(matrix, [
          scaleX,
          0,
          0,
          scaleY,
          Number(positions[position] ?? 0),
          Number(positions[position + 1] ?? 0),
        ]);
        try {
          const image = id.startsWith("g_") ? page.commonObjs.get(id) : page.objs.get(id);
          const figure = imageFigure(image, positioned);
          figure ? figures.push(figure) : omitted.push(positioned[5]);
        } catch {
          omitted.push(positioned[5]);
        }
      }
    } else if (
      operation === OPS.paintImageMaskXObject ||
      operation === OPS.paintImageMaskXObjectGroup ||
      operation === OPS.paintImageMaskXObjectRepeat ||
      operation === OPS.paintSolidColorImageMask
    ) {
      filtered += 1;
    }
  }
  return { figures, filtered, omitted };
}

type Matrix = [number, number, number, number, number, number];

function numericMatrix(values: unknown[]): Matrix {
  return [0, 1, 2, 3, 4, 5].map((index) => Number(values[index] ?? 0)) as Matrix;
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function imageFigure(value: unknown, matrix: Matrix): PdfFigure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const image = value as { width?: unknown; height?: unknown; kind?: unknown; data?: unknown };
  const width = Number(image.width ?? 0);
  const height = Number(image.height ?? 0);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
  ) {
    return undefined;
  }
  return {
    width,
    height,
    renderedWidth: Math.hypot(matrix[0], matrix[1]),
    renderedHeight: Math.hypot(matrix[2], matrix[3]),
    y: Math.max(matrix[5], matrix[5] + matrix[3]),
    kind: Number(image.kind ?? 0),
    data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
  };
}

function encodePng(image: PdfFigure): Uint8Array {
  const rgba = new Uint8Array(image.width * image.height * 4);
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    const target = pixel * 4;
    if (image.kind === ImageKind.RGBA_32BPP) {
      rgba.set(image.data.subarray(target, target + 4), target);
    } else if (image.kind === ImageKind.RGB_24BPP) {
      const source = pixel * 3;
      rgba[target] = image.data[source] ?? 0;
      rgba[target + 1] = image.data[source + 1] ?? 0;
      rgba[target + 2] = image.data[source + 2] ?? 0;
      rgba[target + 3] = 255;
    } else if (image.kind === ImageKind.GRAYSCALE_1BPP) {
      const byte = image.data[Math.floor(pixel / 8)] ?? 0;
      const gray = byte & (1 << (7 - (pixel % 8))) ? 255 : 0;
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = 255;
    } else {
      throw new Error("unsupported PDF image format");
    }
  }
  const stride = image.width * 4;
  const scanlines = new Uint8Array((stride + 1) * image.height);
  for (let row = 0; row < image.height; row += 1) {
    scanlines[row * (stride + 1)] = 0;
    scanlines.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, image.width);
  new DataView(header.buffer).setUint32(4, image.height);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.byteLength + 12);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.byteLength + 8);
  return output;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
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
