/**
 * Papermark adapter.
 *
 * Derived from Papermark's open-source viewer and diagnosed on a live 35-slide
 * deck (2026-06-05 .. 06-08):
 *   - Each page is an <img src={page.file} alt="Page N"> (alt is 1-based) and
 *     ALL page elements exist in the DOM up front with their real signed
 *     CloudFront src set.
 *   - The browser only DECODES (paints) the ~10 on-screen pages, so the rest
 *     have naturalWidth 0. That is irrelevant to us: we only need each <img>'s
 *     src URL to fetch the bytes, not a painted bitmap. So we read the src from
 *     every page element, decoded or not. No scrolling, no navigation.
 *   - Images are PNGs (~3776x2124) on CloudFront SIGNED URLs with referrer
 *     hotlink protection: the worker 403s, so we fetch in the page context
 *     (fetchMode "page"). The worker/shared module downscales.
 *
 * Only handles the image "pages" viewer, not the pdf-default (canvas) viewer.
 * Caveat: Papermark watermarks are part of the page image and appear in output.
 */

import {
  type DeckContext,
  type SiteAdapter,
  orderedUnique,
  delay,
} from "./site-adapter";

const PAGE_ALT = /^page\s+(\d+)$/i;

export const papermarkAdapter: SiteAdapter = {
  id: "papermark",
  label: "Papermark",
  matches: () => /(^|\.)papermark\.(com|io)$/i.test(location.hostname),
  collect: async () => {
    await waitForStableUrls();
    const items = slideUrls();
    const expectedCount = allPageImages().length;
    // If there are page elements but none loaded yet, still return the deck (with
    // empty pageUrls) so the caller can show the "scroll through" guidance with a
    // real count, rather than a generic "nothing found".
    if (expectedCount === 0) return null;
    return { title: extractTitle(), pageUrls: orderedUnique(items), expectedCount };
  },
};

/** Every page <img> present, decoded or not. */
function allPageImages(): HTMLImageElement[] {
  return Array.from(document.querySelectorAll<HTMLImageElement>("img")).filter((img) =>
    PAGE_ALT.test(img.alt)
  );
}

/**
 * {url, page} for every page element whose src is a REAL slide URL. Off-screen
 * pages have src="…/_static/blank.gif" (a 48-byte placeholder); the real signed
 * CloudFront URL only appears once the page has been viewed. We exclude the
 * placeholder so the caller can tell how many real slides actually loaded.
 */
function slideUrls(): { url: string; page: number }[] {
  return allPageImages()
    .map((img) => ({
      url: img.getAttribute("src") || img.currentSrc || img.src || "",
      page: pageNumberFromAlt(img.alt),
    }))
    .filter((x) => /^https:\/\//i.test(x.url) && !/blank\.gif/i.test(x.url));
}

/**
 * Wait until the set of slide URLs stops growing. Papermark renders all page
 * elements up front, so this resolves quickly; the small wait just guards
 * against the React mount happening a beat after our message arrives.
 */
async function waitForStableUrls(): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    const n = slideUrls().length;
    if (n > 0 && n === last) {
      if (++stable >= 3) break;
    } else {
      stable = 0;
      last = n;
    }
    await delay(200);
  }
}

function pageNumberFromAlt(alt: string): number {
  const m = alt.match(PAGE_ALT);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function extractTitle(): string {
  const fromTitle = document.title.replace(/\s*[|–—-]\s*Papermark\s*$/i, "").trim();
  if (fromTitle && !/papermark/i.test(fromTitle)) return fromTitle;
  const date = new Date().toISOString().slice(0, 10);
  const slug = location.pathname.split("/").filter(Boolean).pop() || "deck";
  return `papermark-${slug}-${date}`;
}
