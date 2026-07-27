/**
 * DOM layer for generic mode: turn a live Document into the pure heuristic's
 * input snapshot. No chrome.* APIs, so the browser test harness runs the
 * exact same code path against fixture pages that the injected collector
 * runs against real decks.
 */

import {
  analyzeDeck,
  type DeckAnalysis,
  type ImgInput,
  type PageContext,
} from "./generic.js";

/** Hard ceiling on how many <img> elements a snapshot will consider. */
export const MAX_SNAPSHOT_IMAGES = 1000;

export function snapshotImages(doc: Document): {
  imgs: HTMLImageElement[];
  inputs: ImgInput[];
} {
  const imgs = Array.from(doc.images).slice(0, MAX_SNAPSHOT_IMAGES);
  const inputs = imgs.map((el, index): ImgInput => {
    const rect = el.getBoundingClientRect();
    return {
      index,
      src: el.getAttribute("src") ?? "",
      srcset: el.getAttribute("srcset") ?? "",
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
      attrWidth: numAttr(el, "width"),
      attrHeight: numAttr(el, "height"),
      displayWidth: rect.width,
      displayHeight: rect.height,
    };
  });
  return { imgs, inputs };
}

export function pageContextOf(win: Window, doc: Document): PageContext {
  return {
    baseUrl: doc.baseURI,
    origin: win.location.origin,
    viewportWidth: win.innerWidth,
    scrollHeight: Math.max(
      doc.documentElement.scrollHeight,
      doc.body ? doc.body.scrollHeight : 0
    ),
  };
}

export function analyzeDocument(
  win: Window,
  doc: Document
): { analysis: DeckAnalysis; imgs: HTMLImageElement[] } {
  const { imgs, inputs } = snapshotImages(doc);
  return { analysis: analyzeDeck(inputs, pageContextOf(win, doc)), imgs };
}

function numAttr(el: Element, name: string): number | null {
  const v = el.getAttribute(name);
  // Digits only: parseFloat would read width="100%" as a credible 100px and
  // misclassify the image. Percent and other units carry no pixel meaning.
  if (!v || !/^\d+$/.test(v.trim())) return null;
  const n = parseInt(v, 10);
  return n > 0 ? n : null;
}
