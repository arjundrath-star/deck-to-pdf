/**
 * PDF assembly — portable, no Chrome or DOM APIs.
 *
 * Takes a title and an ordered list of slide images (JPEG or PNG bytes) and
 * assembles a one-slide-per-page PDF, each page sized to its image's own
 * aspect ratio so 16:9 and 4:3 decks both come out without letterbox bars.
 *
 * A future web app backend can import this file unchanged.
 */

import { PDFDocument } from "pdf-lib";

export interface SlideImage {
  type: "image/jpeg" | "image/png";
  bytes: Uint8Array;
}

export interface AssemblyResult {
  bytes: Uint8Array;
  pageCount: number;
  title: string;
}

/** Strip path/illegal/control characters, leading/trailing dots, and Windows
 *  reserved device names (the title can come from an arbitrary page's
 *  document.title). chrome.downloads sanitizes too; this covers the obvious
 *  cases without leaning on it. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f/\\?%*:|"<>]/g, "-")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!cleaned || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned)) {
    return "deck";
  }
  return cleaned;
}

export async function assemblePdf(
  title: string,
  slides: SlideImage[],
  opts: { strict?: boolean } = {}
): Promise<AssemblyResult> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator("Deck to PDF");

  let pageCount = 0;

  for (const slide of slides) {
    let image;
    try {
      image =
        slide.type === "image/png"
          ? await pdf.embedPng(slide.bytes)
          : await pdf.embedJpg(slide.bytes);
    } catch {
      // strict (generic mode): a page the user confirmed must never vanish
      // silently. The classic path keeps the old skip-and-warn behavior.
      if (opts.strict) {
        throw new Error(`Page ${pageCount + 1} could not be embedded. Try again.`);
      }
      console.warn("[docsend-pdf] Skipping a slide that could not be embedded.");
      continue;
    }

    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    pageCount++;
  }

  if (pageCount === 0) {
    throw new Error("No pages could be assembled. The deck may not have fully loaded.");
  }

  const bytes = await pdf.save();
  return { bytes, pageCount, title };
}
