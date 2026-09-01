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
    const info = metadata?.info as { Title?: unknown; Author?: unknown } | undefined;
    const metadataTitle = cleanMetadata(info?.Title);
    const author = cleanMetadata(info?.Author);
    const pages: string[] = [];
    const assets = new Map<string, MediaAsset>();
    const media: MediaCaptureStats = { discovered: 0, localized: 0, omitted: 0, filtered: 0 };
    let mediaBytes = 0;
    let visibleCharacters = 0;
    let inferredTitle: string | undefined;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [content, operatorList] = await Promise.all([
        page.getTextContent(),
        page.getOperatorList(),
      ]);
      const layout = pageTextLayout(content.items);
      const titleLine = pageNumber === 1 ? inferTitleLine(layout) : undefined;
      if (!metadataTitle && titleLine) inferredTitle = titleLine.text;
      const chosenTitle = metadataTitle ?? inferredTitle;
      const textBlocks = renderTextBlocks(
        layout,
        titleLine && chosenTitle && normalizedText(titleLine.text) === normalizedText(chosenTitle)
          ? titleLine
          : undefined,
      );
      const figureResult = await pageFigures(page, operatorList.fnArray, operatorList.argsArray);
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
      visibleCharacters += layout.visibleCharacters;
      pages.push(`## Page ${pageNumber}\n\n${text || "_No extractable text on this page._"}`);
    }
    if (visibleCharacters < MIN_VISIBLE_CHARACTERS) {
      throw new Error("PDF does not contain enough embedded text; OCR is not supported");
    }
    const markdown = pages.join("\n\n");
    if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new Error("Extracted PDF text is larger than 5 MiB");
    }
    const title =
      metadataTitle ?? inferredTitle ?? (filename.replace(/\.pdf$/i, "").trim() || "Document");
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

interface TextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
}

interface TextSegment {
  text: string;
  x: number;
  right: number;
}

interface TextLine {
  text: string;
  x: number;
  y: number;
  right: number;
  height: number;
  fontName: string;
  segments: TextSegment[];
}

interface PageTextLayout {
  lines: TextLine[];
  bodyHeight: number;
  visibleCharacters: number;
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

function pageTextLayout(items: readonly unknown[]): PageTextLayout {
  const runs: TextRun[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const text = String(item.str).replace(/\s+/g, " ").trim();
    const transform =
      "transform" in item && Array.isArray(item.transform) ? item.transform : undefined;
    if (!text || !transform) continue;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    const width = "width" in item ? Number(item.width) : 0;
    const reportedHeight = "height" in item ? Number(item.height) : 0;
    const transformHeight = Math.hypot(Number(transform[2] ?? 0), Number(transform[3] ?? 0));
    const height = reportedHeight > 0 ? reportedHeight : transformHeight;
    if (![x, y, width, height].every(Number.isFinite) || height <= 0) continue;
    runs.push({
      text,
      x,
      y,
      width: Math.max(0, width),
      height,
      fontName: "fontName" in item ? String(item.fontName) : "",
    });
  }

  runs.sort((left, right) => right.y - left.y || left.x - right.x);
  const grouped: TextRun[][] = [];
  for (const run of runs) {
    const line = grouped.find((candidate) => {
      const baseline = candidate[0]?.y ?? run.y;
      const candidateHeight = Math.max(...candidate.map((entry) => entry.height));
      return (
        Math.abs(baseline - run.y) <= Math.max(1.5, Math.min(candidateHeight, run.height) * 0.25)
      );
    });
    if (line) line.push(run);
    else grouped.push([run]);
  }

  const lines = grouped.map(textLine).sort((left, right) => right.y - left.y || left.x - right.x);
  return {
    lines,
    bodyHeight: dominantBodyHeight(runs),
    visibleCharacters: runs.reduce((count, run) => count + run.text.replace(/\s/g, "").length, 0),
  };
}

function textLine(unsortedRuns: TextRun[]): TextLine {
  const runs = [...unsortedRuns].sort((left, right) => left.x - right.x);
  const height = Math.max(...runs.map((run) => run.height));
  const segments: TextSegment[] = [];
  let segmentRuns: TextRun[] = [];
  for (const run of runs) {
    const previous = segmentRuns.at(-1);
    const gap = previous ? run.x - (previous.x + previous.width) : 0;
    if (previous && gap > Math.max(12, height * 1.5)) {
      segments.push(textSegment(segmentRuns));
      segmentRuns = [];
    }
    segmentRuns.push(run);
  }
  if (segmentRuns.length) segments.push(textSegment(segmentRuns));
  const fontWeights = new Map<string, number>();
  for (const run of runs) {
    fontWeights.set(run.fontName, (fontWeights.get(run.fontName) ?? 0) + run.text.length);
  }
  const fontName =
    [...fontWeights.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
  return {
    text: segments.map((segment) => segment.text).join(" "),
    x: Math.min(...runs.map((run) => run.x)),
    y: runs.reduce((sum, run) => sum + run.y, 0) / runs.length,
    right: Math.max(...runs.map((run) => run.x + run.width)),
    height,
    fontName,
    segments,
  };
}

function textSegment(runs: TextRun[]): TextSegment {
  return {
    text: joinInlineRuns(runs),
    x: Math.min(...runs.map((run) => run.x)),
    right: Math.max(...runs.map((run) => run.x + run.width)),
  };
}

function joinInlineRuns(runs: TextRun[]): string {
  let text = "";
  for (const run of runs) {
    if (!text) {
      text = run.text;
      continue;
    }
    const noLeadingSpace = /^[,.;:!?%)\]}]/.test(run.text);
    const noTrailingSpace = /[(\[{/]$/.test(text);
    text += noLeadingSpace || noTrailingSpace ? run.text : ` ${run.text}`;
  }
  return text;
}

function dominantBodyHeight(runs: TextRun[]): number {
  if (!runs.length) return 10;
  const buckets = new Map<number, number>();
  for (const run of runs) {
    const bucket = Math.round(run.height * 2) / 2;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + Math.max(1, run.text.length));
  }
  return [...buckets.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 10;
}

function inferTitleLine(layout: PageTextLayout): TextLine | undefined {
  const candidates = layout.lines
    .slice(0, 6)
    .filter(
      (line) =>
        line.segments.length === 1 &&
        line.text.length <= 200 &&
        line.height >= layout.bodyHeight * 1.2 &&
        !endsLikeSentence(line.text) &&
        !bulletText(line.text),
    );
  return candidates.sort((left, right) => right.height - left.height || right.y - left.y)[0];
}

function renderTextBlocks(layout: PageTextLayout, skippedLine?: TextLine): PositionedBlock[] {
  const lines = layout.lines.filter((line) => line !== skippedLine);
  const headingHeights = [
    ...new Set(
      lines
        .map((line, index) => (isHeadingAt(lines, index, layout.bodyHeight) ? line : undefined))
        .filter((line): line is TextLine => line !== undefined)
        .map((line) => Math.round(line.height * 2) / 2),
    ),
  ].sort((left, right) => right - left);
  const blocks: PositionedBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const table = tableAt(lines, index, layout.bodyHeight);
    if (table) {
      blocks.push({ y: lines[index]!.y, markdown: renderTable(table.rows) });
      index = table.end;
      continue;
    }

    const line = lines[index]!;
    if (isHeadingAt(lines, index, layout.bodyHeight)) {
      const tier = Math.max(0, headingHeights.indexOf(Math.round(line.height * 2) / 2));
      blocks.push({ y: line.y, markdown: `${"#".repeat(Math.min(6, 3 + tier))} ${line.text}` });
      index += 1;
      continue;
    }

    const bullet = bulletText(line.text);
    if (bullet) {
      const listLines = [bullet];
      let next = index + 1;
      while (next < lines.length) {
        const nextBullet = bulletText(lines[next]!.text);
        if (
          !nextBullet ||
          isHeadingAt(lines, next, layout.bodyHeight) ||
          tableAt(lines, next, layout.bodyHeight)
        ) {
          break;
        }
        listLines.push(nextBullet);
        next += 1;
      }
      blocks.push({ y: line.y, markdown: listLines.map((value) => `- ${value}`).join("\n") });
      index = next;
      continue;
    }

    const paragraph = [line.text];
    let previous = line;
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next]!;
      if (
        isHeadingAt(lines, next, layout.bodyHeight) ||
        bulletText(candidate.text) ||
        tableAt(lines, next, layout.bodyHeight) ||
        !continuesParagraph(previous, candidate, layout.bodyHeight)
      ) {
        break;
      }
      paragraph.push(candidate.text);
      previous = candidate;
      next += 1;
    }
    blocks.push({ y: line.y, markdown: joinWrappedLines(paragraph) });
    index = next;
  }
  return blocks;
}

function isHeadingLine(line: TextLine, bodyHeight: number): boolean {
  return (
    line.segments.length === 1 &&
    line.height >= bodyHeight * 1.18 &&
    line.text.length <= 160 &&
    !endsLikeSentence(line.text)
  );
}

function isHeadingAt(lines: TextLine[], index: number, bodyHeight: number): boolean {
  const line = lines[index];
  if (!line || !isHeadingLine(line, bodyHeight)) return false;
  const next = lines[index + 1];
  return !(
    next &&
    Math.abs(line.height - next.height) <= 1 &&
    continuesParagraph(line, next, bodyHeight)
  );
}

function continuesParagraph(previous: TextLine, current: TextLine, bodyHeight: number): boolean {
  const verticalGap = previous.y - current.y;
  return (
    verticalGap > 0 &&
    verticalGap <= Math.max(bodyHeight * 1.8, previous.height * 1.8) &&
    Math.abs(previous.height - current.height) <= Math.max(2, bodyHeight * 0.25) &&
    Math.abs(previous.x - current.x) <= Math.max(8, bodyHeight)
  );
}

function joinWrappedLines(lines: string[]): string {
  return lines.reduce((text, line) => {
    if (!text) return line;
    if (text.endsWith("\u00ad")) return `${text.slice(0, -1)}${line}`;
    if (text.endsWith("-")) return `${text}${line}`;
    return `${text} ${line}`;
  }, "");
}

function bulletText(value: string): string | undefined {
  const match = value.match(/^\s*(?:[•●▪◦‣⁃*\-–—]|\d+[.)])\s+(.+)$/u);
  return match?.[1]?.trim() || undefined;
}

function endsLikeSentence(value: string): boolean {
  return /[.;,]$/.test(value.trim());
}

interface DetectedTable {
  rows: TextSegment[][];
  end: number;
}

function tableAt(lines: TextLine[], start: number, bodyHeight: number): DetectedTable | undefined {
  const first = lines[start];
  if (!first || first.segments.length < 2) return undefined;
  const columns = first.segments.length;
  const rows = [first.segments];
  const rowLines = [first];
  let end = start + 1;
  while (end < lines.length) {
    const candidate = lines[end]!;
    if (
      candidate.segments.length !== columns ||
      !alignedColumns(rows, candidate.segments, bodyHeight)
    ) {
      break;
    }
    const previousGap = rowLines.length > 1 ? rowLines.at(-2)!.y - rowLines.at(-1)!.y : undefined;
    const gap = rowLines.at(-1)!.y - candidate.y;
    if (
      gap <= 0 ||
      gap > bodyHeight * 3.5 ||
      (previousGap !== undefined &&
        Math.abs(previousGap - gap) > Math.max(bodyHeight, previousGap * 0.45))
    ) {
      break;
    }
    rows.push(candidate.segments);
    rowLines.push(candidate);
    end += 1;
  }
  if (rows.length < 3) return undefined;
  const distinctHeader = rowLines.slice(1).some((line) => line.fontName !== rowLines[0]!.fontName);
  if (columns === 2 && !distinctHeader) return undefined;
  return { rows, end };
}

function alignedColumns(
  existingRows: TextSegment[][],
  candidate: TextSegment[],
  bodyHeight: number,
): boolean {
  const tolerance = Math.max(8, bodyHeight);
  return candidate.every((cell, column) => {
    const prior = existingRows.map((row) => row[column]!).filter(Boolean);
    const leftSpread = spread([...prior.map((entry) => entry.x), cell.x]);
    const rightSpread = spread([...prior.map((entry) => entry.right), cell.right]);
    return Math.min(leftSpread, rightSpread) <= tolerance;
  });
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function renderTable(rows: TextSegment[][]): string {
  const cells = rows.map((row) => row.map((cell) => escapeTableCell(cell.text)));
  const separator = cells[0]!.map(() => "---");
  return [cells[0]!, separator, ...cells.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

function escapeTableCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

async function pageFigures(
  page: { objs: PdfObjectStore; commonObjs: PdfObjectStore },
  operations: number[],
  argumentsList: unknown[][],
): Promise<{ figures: PdfFigure[]; filtered: number; omitted: number[] }> {
  const figures: PdfFigure[] = [];
  const omitted: number[] = [];
  let filtered = 0;
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const resolvedObjects = new Map<string, Promise<unknown>>();
  const resolveObject = (id: string): Promise<unknown> => {
    const existing = resolvedObjects.get(id);
    if (existing) return existing;
    const store = id.startsWith("g_") ? page.commonObjs : page.objs;
    const pending = pdfObject(store, id);
    resolvedObjects.set(id, pending);
    return pending;
  };
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
        const image = await resolveObject(id);
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
          const image = await resolveObject(id);
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

interface PdfObjectStore {
  get(id: string, callback?: (value: unknown) => void): unknown;
}

function pdfObject(store: PdfObjectStore, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      const immediate = store.get(id, resolve);
      if (immediate !== undefined && immediate !== null) resolve(immediate);
    } catch (error) {
      reject(error);
    }
  });
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
  if (!cleaned || /^\(?\s*(?:anonymous|unspecified|untitled|unknown)\s*\)?$/i.test(cleaned)) {
    return undefined;
  }
  return cleaned.slice(0, 500);
}

function isPasswordError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "PasswordException" || /password/i.test(error.message))
  );
}
