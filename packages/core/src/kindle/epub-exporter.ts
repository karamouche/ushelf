import { createHash } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import sharp from "sharp";
import { unified } from "unified";
import type { ShelfItem } from "../domain/library-item.js";
import { mediaPath } from "../ingestion/media-localizer.js";

const MAX_EPUB_BYTES = 60 * 1024 * 1024;
const FIXED_TIME = new Date("2000-01-01T12:00:00.000Z");

export interface EpubMedia {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}

export async function exportKindleEpub(item: ShelfItem, media: EpubMedia[]): Promise<Uint8Array> {
  let markdown = item.sourceMarkdown;
  const packaged: Array<{ filename: string; mediaType: string; bytes: Uint8Array }> = [];
  for (const asset of media) {
    const normalized = await normalizeImage(asset);
    packaged.push(normalized);
    markdown = markdown.replaceAll(
      mediaPath(item.id, asset.filename),
      `media/${normalized.filename}`,
    );
  }

  const body = String(
    await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeSanitize)
      .use(rehypeStringify, { closeSelfClosing: true })
      .process(markdown),
  );
  const title = escapeXml(item.title);
  const author = escapeXml(item.author ?? "Unknown author");
  const provenance =
    item.sourceType === "document"
      ? `Source file: ${escapeXml(item.file.name)}`
      : `Saved from <a href="${escapeXml(item.originalUrl)}">${escapeXml(item.originalUrl)}</a>`;
  const modified = item.updatedAt.replace(/\.\d{3}Z$/, "Z");

  const entries: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0, mtime: FIXED_TIME }],
    "META-INF/container.xml": [
      strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
      { mtime: FIXED_TIME },
    ],
    "EPUB/article.xhtml": [
      strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="und" lang="und">
<head><meta charset="utf-8"/><title>${title}</title><link rel="stylesheet" href="styles.css"/></head>
<body><header><h1>${title}</h1><p class="author">${author}</p><p class="provenance">${provenance}</p></header><main>${body}</main></body>
</html>`),
      { mtime: FIXED_TIME },
    ],
    "EPUB/nav.xhtml": [
      strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="und" lang="und">
<head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="article.xhtml">${title}</a></li></ol></nav></body></html>`),
      { mtime: FIXED_TIME },
    ],
    "EPUB/styles.css": [
      strToU8(
        "body{font-family:serif;line-height:1.55;margin:5%;}h1,h2,h3{line-height:1.2;}img{display:block;height:auto;max-width:100%;margin:1em auto;}pre{white-space:pre-wrap;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #777;padding:.35em;}.author,.provenance{color:#555;font-size:.9em;}",
      ),
      { mtime: FIXED_TIME },
    ],
  };

  const manifest = [
    '<item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>',
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="styles" href="styles.css" media-type="text/css"/>',
  ];
  packaged.forEach((asset, index) => {
    entries[`EPUB/media/${asset.filename}`] = [asset.bytes, { mtime: FIXED_TIME }];
    manifest.push(
      `<item id="image-${index}" href="media/${asset.filename}" media-type="${asset.mediaType}"/>`,
    );
  });
  entries["EPUB/package.opf"] = [
    strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="und" prefix="ushelf: https://ushelf.local/vocab#">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="publication-id">urn:uuid:${item.id}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>und</dc:language>
<meta property="dcterms:modified">${modified}</meta><meta property="ushelf:revision">${item.revision}</meta>
</metadata><manifest>${manifest.join("")}</manifest><spine><itemref idref="article"/></spine></package>`),
    { mtime: FIXED_TIME },
  ];

  const bytes = zipSync(entries, { level: 6 });
  if (bytes.byteLength > MAX_EPUB_BYTES) {
    throw new Error("The Kindle EPUB is larger than the 60 MiB export limit");
  }
  return bytes;
}

async function normalizeImage(asset: EpubMedia): Promise<EpubMedia> {
  if (asset.mediaType === "image/gif") return asset;
  const pipeline = sharp(asset.bytes).rotate().resize({
    width: 1600,
    height: 1600,
    fit: "inside",
    withoutEnlargement: true,
  });
  const metadata = await pipeline.metadata();
  const keepPng = asset.mediaType === "image/png";
  const usePng = keepPng || (asset.mediaType !== "image/jpeg" && Boolean(metadata.hasAlpha));
  const output = usePng
    ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
    : await pipeline.jpeg({ quality: 82, progressive: true }).toBuffer();
  const extension = usePng ? "png" : "jpg";
  const digest = createHash("sha256").update(output).digest("hex");
  return {
    filename: `${digest}.${extension}`,
    mediaType: usePng ? "image/png" : "image/jpeg",
    bytes: new Uint8Array(output),
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
