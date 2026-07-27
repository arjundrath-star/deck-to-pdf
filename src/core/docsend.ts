/**
 * DocSend adapter — all DocSend-specific knowledge lives here.
 *
 * VERIFIED against real decks (2026-06):
 *   - Each slide is an <img class="preso-view page-view"> at full resolution
 *     (e.g. 2048x1152), served from a CloudFront host.
 *   - The image URL path ends with the 1-based page number, giving page order.
 *   - DocSend lazy-loads slides as the WINDOW scrolls. We scroll top-to-bottom
 *     and harvest each slide's URL as it loads (accumulating, so it survives any
 *     unload), then report the page count so the caller can refuse a partial.
 *   - Images are cross-origin without CORS, so they are fetched in the
 *     background worker (canvas would taint). See src/background.ts.
 */

import {
  type DeckContext,
  type SiteAdapter,
  orderedUnique,
  delay,
} from "./site-adapter";

const MIN_SLIDE_W = 200;

export const docsendAdapter: SiteAdapter = {
  id: "docsend",
  label: "DocSend",
  matches: () => /(^|\.)docsend\.com$/i.test(location.hostname),
  collect: async () => {
    // Like Papermark, DocSend lazy-loads slides as the user scrolls through the
    // deck. We do NOT auto-drive the viewer (that proved janky and incomplete).
    // We wait for what is loaded to settle, capture it, and report the total so
    // the popup refuses a partial and tells the user to scroll through.
    await waitForStable();
    const slides = loadedSlideImages();
    if (slides.length === 0) return null;
    const pageUrls = orderedUnique(
      slides.map((img) => {
        const url = img.currentSrc || img.src;
        return { url, page: pageNumberFromUrl(url) };
      })
    );
    const expectedCount = Math.max(pageUrls.length, allSlideElements().length);
    return { title: extractTitle(), pageUrls, expectedCount };
  },
};

/** Wait until the loaded-slide count holds steady (slides finish decoding). */
async function waitForStable(): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    const n = loadedSlideImages().length;
    if (n === last) {
      if (++stable >= 3) break;
    } else {
      stable = 0;
      last = n;
    }
    await delay(200);
  }
}

/** Slide images that have finished loading. */
function loadedSlideImages(): HTMLImageElement[] {
  return allSlideElements().filter(
    (img) => (img.currentSrc || img.src) && img.complete && img.naturalWidth >= MIN_SLIDE_W
  );
}

/** All slide elements present, loaded or not. */
function allSlideElements(): HTMLImageElement[] {
  return Array.from(document.querySelectorAll<HTMLImageElement>("img.page-view"));
}

/** Parse the trailing page index from a slide URL. Large fallback keeps unknowns last. */
function pageNumberFromUrl(url: string): number {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const m = path.match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function extractTitle(): string {
  // Do not use og:title on DocSend — it is their marketing tagline, not the deck.
  const fromAttr = document
    .querySelector<HTMLElement>("[data-document-name]")
    ?.textContent?.trim();
  const fromTitle = document.title.replace(/\s*[|–—-]\s*DocSend\s*$/i, "").trim();
  const candidate = fromAttr || fromTitle;
  if (candidate && !/docsend/i.test(candidate)) return candidate;
  const date = new Date().toISOString().slice(0, 10);
  const slug = location.pathname.split("/").filter(Boolean).pop() || "deck";
  return `docsend-${slug}-${date}`;
}
