import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { MediaCaptureStats } from "../domain/library-item.js";
import { fetchPublicBytes } from "./safe-html-fetcher.js";

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_ITEM_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_MEDIA_REFERENCES = 200;
const DOWNLOAD_CONCURRENCY = 4;
const CONTENT_ADDRESS = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|svg)$/;

export interface MediaAsset {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface LocalizedMarkdown {
  markdown: string;
  assets: MediaAsset[];
  stats: MediaCaptureStats;
}

interface ImageReference {
  start: number;
  end: number;
  alt: string;
  destination: string;
}

export async function localizeMarkdownImages(
  markdown: string,
  itemId: string,
  existingAsset?: (filename: string) => Promise<boolean>,
): Promise<LocalizedMarkdown> {
  const references = findMarkdownImages(markdown);
  const selected = references.slice(0, MAX_MEDIA_REFERENCES);
  const replacements = new Map<ImageReference, string>();
  const assets = new Map<string, MediaAsset>();
  let localized = 0;
  let omitted = references.length - selected.length;
  let totalBytes = 0;
  let cursor = 0;

  async function processReference(reference: ImageReference): Promise<void> {
    try {
      const localFilename = canonicalLocalFilename(reference.destination, itemId);
      if (localFilename) {
        if (!existingAsset || !(await existingAsset(localFilename))) {
          throw new Error("local media file does not exist");
        }
        localized += 1;
        replacements.set(reference, renderLocalImage(reference.alt, itemId, localFilename));
        return;
      }
      const image = reference.destination.startsWith("data:")
        ? decodeDataImage(reference.destination)
        : await downloadImage(reference.destination);
      const normalized = validateImage(image.bytes, image.contentType);
      if (totalBytes + normalized.bytes.byteLength > MAX_ITEM_MEDIA_BYTES) {
        throw new Error("item media limit exceeded");
      }
      const digest = createHash("sha256").update(normalized.bytes).digest("hex");
      const filename = `${digest}.${normalized.extension}`;
      if (!assets.has(filename)) {
        totalBytes += normalized.bytes.byteLength;
        assets.set(filename, {
          filename,
          mediaType: normalized.mediaType,
          bytes: normalized.bytes,
        });
      }
      localized += 1;
      replacements.set(reference, renderLocalImage(reference.alt, itemId, filename));
    } catch {
      omitted += 1;
      replacements.set(reference, omissionNote(reference.alt));
    }
  }

  async function worker(): Promise<void> {
    while (cursor < selected.length) {
      const reference = selected[cursor++];
      if (reference) await processReference(reference);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, selected.length) }, () => worker()),
  );

  for (const reference of references.slice(selected.length)) {
    replacements.set(reference, omissionNote(reference.alt));
  }
  let rewritten = "";
  let offset = 0;
  for (const reference of references) {
    rewritten += markdown.slice(offset, reference.start);
    rewritten += replacements.get(reference) ?? omissionNote(reference.alt);
    offset = reference.end;
  }
  rewritten += markdown.slice(offset);
  return {
    markdown: rewritten,
    assets: [...assets.values()],
    stats: { discovered: references.length, localized, omitted, filtered: 0 },
  };
}

export function assertLocalMarkdownImages(markdown: string, itemId: string): string[] {
  return findMarkdownImages(markdown).map((reference) => {
    const filename = canonicalLocalFilename(reference.destination, itemId);
    if (!filename) throw new Error("Imported Markdown contains a non-local image reference");
    return filename;
  });
}

export function mediaPath(itemId: string, filename: string): string {
  return `../../files/${itemId}/media/${filename}`;
}

export function isMediaFilename(filename: string): boolean {
  return CONTENT_ADDRESS.test(filename);
}

export function mediaTypeForFilename(filename: string): string {
  if (!isMediaFilename(filename)) throw new Error("Invalid media filename");
  const extension = filename.slice(filename.lastIndexOf(".") + 1);
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      svg: "image/svg+xml",
    } as Record<string, string>
  )[extension]!;
}

function renderLocalImage(alt: string, itemId: string, filename: string): string {
  return `![${alt}](${mediaPath(itemId, filename)})`;
}

function omissionNote(alt: string): string {
  const label = alt.trim() || "image";
  return `*Image omitted: ${label}.*`;
}

async function downloadImage(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("unsupported image URL");
  }
  const response = await fetchPublicBytes(parsed.toString(), {
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml",
    maxBytes: MAX_MEDIA_BYTES,
  });
  if (!response.contentType.startsWith("image/")) throw new Error("resource is not an image");
  return response;
}

function decodeDataImage(value: string): { bytes: Uint8Array; contentType: string } {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match?.[1] || !match[2]) throw new Error("invalid image data URL");
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length || bytes.byteLength > MAX_MEDIA_BYTES)
    throw new Error("invalid image data URL");
  return { bytes, contentType: match[1].toLowerCase() };
}

export function validateImage(
  input: Uint8Array,
  declaredType: string,
): { bytes: Uint8Array; mediaType: string; extension: string } {
  const bytes = new Uint8Array(input);
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { bytes, mediaType: "image/png", extension: "png" };
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff]))
    return { bytes, mediaType: "image/jpeg", extension: "jpg" };
  const header = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
    return { bytes, mediaType: "image/gif", extension: "gif" };
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")
    return { bytes, mediaType: "image/webp", extension: "webp" };
  if (header.slice(4, 12) === "ftypavif" || header.slice(4, 12) === "ftypavis")
    return { bytes, mediaType: "image/avif", extension: "avif" };
  if (declaredType === "image/svg+xml" || looksLikeSvg(bytes)) {
    const sanitized = sanitizeSvg(bytes);
    return { bytes: sanitized, mediaType: "image/svg+xml", extension: "svg" };
  }
  throw new Error("unsupported or spoofed image format");
}

function sanitizeSvg(bytes: Uint8Array): Uint8Array {
  const source = new TextDecoder().decode(bytes);
  const dom = new JSDOM(source, { contentType: "image/svg+xml" });
  const root = dom.window.document.documentElement;
  if (root.localName !== "svg") throw new Error("invalid SVG image");
  for (const element of dom.window.document.querySelectorAll(
    "script,style,foreignObject,iframe,object,embed,audio,video",
  )) {
    element.remove();
  }
  for (const element of dom.window.document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "style" ||
        ((name === "href" || name === "xlink:href") && value && !value.startsWith("#")) ||
        /url\(\s*["']?(?!#)/i.test(value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return new TextEncoder().encode(root.outerHTML);
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  return /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(
    new TextDecoder().decode(bytes.subarray(0, 512)),
  );
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function canonicalLocalFilename(destination: string, itemId: string): string | undefined {
  const prefix = `../../files/${itemId}/media/`;
  if (!destination.startsWith(prefix)) return undefined;
  const filename = destination.slice(prefix.length);
  return isMediaFilename(filename) ? filename : undefined;
}

function findMarkdownImages(markdown: string): ImageReference[] {
  const references: ImageReference[] = [];
  const definitions = markdownImageDefinitions(markdown);
  for (let start = 0; start < markdown.length; start += 1) {
    if (markdown[start] !== "!" || markdown[start + 1] !== "[") continue;
    const altEnd = findUnescaped(markdown, "]", start + 2);
    if (altEnd < 0) continue;
    const alt = markdown.slice(start + 2, altEnd);
    let destination = "";
    let end = altEnd + 1;
    if (markdown[altEnd + 1] === "(") {
      const destinationEnd = findClosingParenthesis(markdown, altEnd + 2);
      if (destinationEnd < 0) continue;
      destination = markdownDestination(markdown.slice(altEnd + 2, destinationEnd).trim());
      end = destinationEnd + 1;
    } else if (markdown[altEnd + 1] === "[") {
      const labelEnd = findUnescaped(markdown, "]", altEnd + 2);
      if (labelEnd < 0) continue;
      const label = markdown.slice(altEnd + 2, labelEnd) || alt;
      destination = definitions.get(normalizeReferenceLabel(label)) ?? "";
      end = labelEnd + 1;
    } else {
      destination = definitions.get(normalizeReferenceLabel(alt)) ?? "";
    }
    if (!destination) continue;
    references.push({
      start,
      end,
      alt,
      destination,
    });
    start = end - 1;
  }
  return references;
}

function markdownImageDefinitions(markdown: string): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const match of markdown.matchAll(/^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]+>|\S+)/gm)) {
    if (!match[1] || !match[2]) continue;
    definitions.set(normalizeReferenceLabel(match[1]), markdownDestination(match[2]));
  }
  return definitions;
}

function normalizeReferenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function markdownDestination(raw: string): string {
  if (raw.startsWith("<")) {
    const end = raw.indexOf(">");
    return end >= 0 ? raw.slice(1, end) : raw;
  }
  return raw.match(/^\S+/)?.[0] ?? raw;
}

function findUnescaped(value: string, token: string, offset: number): number {
  for (let index = offset; index < value.length; index += 1) {
    if (value[index] === token && value[index - 1] !== "\\") return index;
  }
  return -1;
}

function findClosingParenthesis(value: string, offset: number): number {
  let depth = 0;
  let angle = false;
  for (let index = offset; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "<") angle = true;
    else if (character === ">") angle = false;
    else if (!angle && character === "(") depth += 1;
    else if (!angle && character === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}
