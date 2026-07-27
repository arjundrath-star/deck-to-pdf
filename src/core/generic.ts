/**
 * Generic-mode heuristic: find the slide deck among a page's <img> elements.
 *
 * Pure module: no DOM, no chrome.* APIs. The injected collector feeds it a
 * structural snapshot of the live page; unit tests feed it fixture snapshots.
 *
 * Shape of the decision (decisions/0008 + working/GENERIC-MODE-PLAN.md):
 * - srcset is parsed for the LARGEST candidate; currentSrc is never trusted
 *   (it returns the viewport-selected variant, silently degrading quality).
 * - Candidates group by aspect ratio within a tolerance; the largest group
 *   with >= 3 members is the deck, in document order.
 * - Loop-clone carousels: duplicate URLs at the edges are trimmed (a plain
 *   keep-first collapse would rotate the deck so it starts on the last
 *   slide), then interior duplicates collapse keep-first.
 * - Same-origin gate: any group member off the page origin declines the
 *   whole page. Cross-origin decks are a manual-playbook case in v0.4.
 * - Lazy images (naturalWidth === 0) are counted so the popup can prompt
 *   "keep scrolling"; nothing unseen is ever converted.
 */

export interface ImgInput {
  /** Document order among the page's <img> elements. */
  index: number;
  /** Raw src attribute (not currentSrc). */
  src: string;
  /** Raw srcset attribute. */
  srcset: string;
  naturalWidth: number;
  naturalHeight: number;
  /** width="" / height="" attributes, the only size hint on unloaded images. */
  attrWidth: number | null;
  attrHeight: number | null;
  /** Rendered CSS size from getBoundingClientRect. */
  displayWidth: number;
  displayHeight: number;
}

export interface PageContext {
  /** document.baseURI, for resolving relative URLs. */
  baseUrl: string;
  /** location.origin; the same-origin gate compares against this. */
  origin: string;
  viewportWidth: number;
  /** Full page scroll height, for the low-count (virtualized deck) signal. */
  scrollHeight: number;
}

export interface SlideCandidate {
  index: number;
  url: string;
  width: number;
  height: number;
}

export type DeckAnalysis =
  | {
      status: "ok";
      slides: SlideCandidate[];
      /** Unloaded images that ratio-match the deck (or have passed the size
       *  filter with unknown ratio): almost certainly missing slides. The
       *  popup hard-gates conversion on these. */
      lazyCount: number;
      /** Unloaded images with NO size evidence at all (no natural size, no
       *  width/height attributes, collapsed layout box). They cannot be
       *  classified, so they cannot hard-gate, but staying silent about them
       *  risks converting a partial deck. The popup warns. */
      unsizedLazyCount: number;
      lowCountWarning: boolean;
      droppedDuplicates: number;
    }
  | {
      status: "no-deck";
      reason: "no-group" | "lazy";
      lazyCount: number;
      unsizedLazyCount: number;
    }
  | { status: "cross-origin"; sampleHost: string; count: number }
  | { status: "too-many"; count: number };

export const MIN_SLIDE_WIDTH = 800;
export const MIN_VIEWPORT_FRACTION = 0.5;
export const MIN_GROUP_SIZE = 3;
export const RATIO_TOLERANCE = 0.02;
export const MAX_IMAGES = 200;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** scrollHeight beyond this multiple of the deck's own height fires the warning. */
const LOW_COUNT_FACTOR = 2.5;

/**
 * Largest URL in a srcset, by w descriptor, else by x density, else first.
 * Tokenized like the spec's parser (URL = run of non-whitespace, trailing
 * commas stripped, then an optional descriptor up to the next comma), NOT a
 * naive comma split: Cloudinary/Imgix transformation URLs carry commas
 * (`/w_1920,c_fill/slide.jpg`) and are among the most common srcset sources.
 */
export function parseSrcsetLargest(srcset: string): string | null {
  const entries: { url: string; w: number; x: number }[] = [];
  let i = 0;
  const n = srcset.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(srcset[i])) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !/\s/.test(srcset[i])) i++;
    let url = srcset.slice(start, i);
    let desc = "";
    const stripped = url.replace(/,+$/, "");
    if (stripped === url) {
      while (i < n && /\s/.test(srcset[i])) i++;
      start = i;
      while (i < n && srcset[i] !== ",") i++;
      desc = srcset.slice(start, i).trim();
      i++;
    } else {
      // URL ended in a comma: the entry has no descriptor.
      url = stripped;
    }
    if (!url) continue;
    let w = 0;
    let x = 0;
    const m = /^([\d.]+)(w|x)$/.exec(desc);
    if (m) {
      if (m[2] === "w") w = parseFloat(m[1]);
      else x = parseFloat(m[1]);
    }
    entries.push({ url, w, x });
  }
  if (entries.length === 0) return null;
  const byW = entries.filter((e) => e.w > 0);
  if (byW.length > 0) return byW.reduce((a, b) => (b.w > a.w ? b : a)).url;
  const byX = entries.filter((e) => e.x > 0);
  if (byX.length > 0) return byX.reduce((a, b) => (b.x > a.x ? b : a)).url;
  return entries[0].url;
}

interface Cand {
  index: number;
  url: URL;
  loaded: boolean;
  width: number;
  height: number;
  displayHeight: number;
  ratio: number | null;
}

function resolveBestUrl(img: ImgInput, ctx: PageContext): URL | null {
  const best = parseSrcsetLargest(img.srcset) ?? (img.src.trim() || null);
  if (!best) return null;
  let url: URL;
  try {
    url = new URL(best, ctx.baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url;
}

function buildCandidate(img: ImgInput, ctx: PageContext): Cand | null {
  const url = resolveBestUrl(img, ctx);
  if (!url) return null;

  const loaded = img.naturalWidth > 0;
  let width = 0;
  let height = 0;
  if (loaded) {
    width = img.naturalWidth;
    height = img.naturalHeight;
  } else if (img.attrWidth && img.attrHeight) {
    width = img.attrWidth;
    height = img.attrHeight;
  } else if (img.displayWidth > 0 && img.displayHeight > 0) {
    width = img.displayWidth;
    height = img.displayHeight;
  }

  const bigEnough =
    width >= MIN_SLIDE_WIDTH ||
    img.displayWidth >= ctx.viewportWidth * MIN_VIEWPORT_FRACTION;
  if (!bigEnough) return null;

  return {
    index: img.index,
    url,
    loaded,
    width,
    height,
    displayHeight: img.displayHeight,
    ratio: width > 0 && height > 0 ? width / height : null,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function near(ratio: number, target: number): boolean {
  return Math.abs(ratio - target) <= RATIO_TOLERANCE * target;
}

/** Largest aspect-ratio cluster with >= MIN_GROUP_SIZE members, else null. */
function largestRatioCluster(cands: Cand[]): Cand[] | null {
  const sorted = [...cands].sort((a, b) => a.ratio! - b.ratio!);
  const clusters: Cand[][] = [];
  let current: Cand[] = [];
  let mean = 0;
  for (const c of sorted) {
    if (current.length > 0 && near(c.ratio!, mean)) {
      current.push(c);
      mean += (c.ratio! - mean) / current.length;
    } else {
      if (current.length > 0) clusters.push(current);
      current = [c];
      mean = c.ratio!;
    }
  }
  if (current.length > 0) clusters.push(current);

  let best: Cand[] | null = null;
  for (const cluster of clusters) {
    if (cluster.length < MIN_GROUP_SIZE) continue;
    if (
      !best ||
      cluster.length > best.length ||
      (cluster.length === best.length &&
        median(cluster.map((c) => c.width)) > median(best.map((c) => c.width)))
    ) {
      best = cluster;
    }
  }
  return best;
}

/**
 * Duplicate handling for loop-clone carousels. Swiper-style loops render
 * [clone-of-last..., real slides..., clone-of-first...], so a plain
 * keep-first collapse rotates the deck to start on the last slide. Instead:
 * trim duplicated URLs inward from the ends, back end first (back-first also
 * keeps a deck that legitimately reuses its title image as the closing
 * slide), then collapse any interior duplicates keep-first. A tracked
 * multiplicity count stops each end as soon as its element is unique.
 */
function dedupe(group: Cand[]): { slides: Cand[]; dropped: number } {
  const items = [...group].sort((a, b) => a.index - b.index);
  let dropped = 0;
  const mult = new Map<string, number>();
  for (const c of items) mult.set(c.url.href, (mult.get(c.url.href) ?? 0) + 1);
  const remove = (i: number): void => {
    const c = items.splice(i, 1)[0];
    mult.set(c.url.href, (mult.get(c.url.href) ?? 1) - 1);
    dropped++;
  };
  let trimmed = true;
  while (trimmed && items.length > 1) {
    trimmed = false;
    if (items.length > 1 && (mult.get(items[items.length - 1].url.href) ?? 0) >= 2) {
      remove(items.length - 1);
      trimmed = true;
    }
    if (items.length > 1 && (mult.get(items[0].url.href) ?? 0) >= 2) {
      remove(0);
      trimmed = true;
    }
  }
  const seen = new Set<string>();
  const out: Cand[] = [];
  for (const c of items) {
    if (seen.has(c.url.href)) {
      dropped++;
      continue;
    }
    seen.add(c.url.href);
    out.push(c);
  }
  return { slides: out, dropped };
}

function isLowCount(slides: Cand[], ctx: PageContext): boolean {
  const heights = slides.map((c) => c.displayHeight).filter((h) => h > 0);
  if (heights.length === 0 || ctx.scrollHeight <= 0) return false;
  return ctx.scrollHeight > LOW_COUNT_FACTOR * slides.length * median(heights);
}

export function analyzeDeck(imgs: ImgInput[], ctx: PageContext): DeckAnalysis {
  const cands: Cand[] = [];
  let unsizedLazy = 0;
  for (const img of imgs) {
    const c = buildCandidate(img, ctx);
    if (c) {
      cands.push(c);
      continue;
    }
    // Unloaded images with no size evidence at all cannot be classified as
    // slide or chrome. An unstyled <img loading="lazy"> deck page collapses
    // every below-the-fold slide to a 0x0 box; staying silent here would
    // convert a partial deck without warning. Counted, surfaced, soft.
    if (
      img.naturalWidth === 0 &&
      !(img.attrWidth && img.attrHeight) &&
      !(img.displayWidth > 0 && img.displayHeight > 0) &&
      resolveBestUrl(img, ctx) !== null
    ) {
      unsizedLazy++;
    }
  }
  const loaded = cands.filter((c) => c.loaded && c.ratio !== null);
  const lazy = cands.filter((c) => !c.loaded);

  const winner = largestRatioCluster(loaded);
  if (!winner) {
    return {
      status: "no-deck",
      reason:
        lazy.length >= MIN_GROUP_SIZE || unsizedLazy >= MIN_GROUP_SIZE
          ? "lazy"
          : "no-group",
      lazyCount: lazy.length,
      unsizedLazyCount: unsizedLazy,
    };
  }

  const groupRatio = median(winner.map((c) => c.ratio!));
  const lazyMatches = lazy.filter(
    (c) => c.ratio === null || near(c.ratio, groupRatio)
  );

  // Same-origin gate: one off-origin member (loaded or plausibly-lazy)
  // declines the whole page. Zero fetches happen after this.
  const offOrigin =
    winner.find((c) => c.url.origin !== ctx.origin) ??
    lazyMatches.find((c) => c.url.origin !== ctx.origin);
  if (offOrigin) {
    return {
      status: "cross-origin",
      sampleHost: offOrigin.url.host,
      count: winner.length,
    };
  }

  const { slides, dropped } = dedupe(winner);
  if (slides.length < MIN_GROUP_SIZE) {
    return {
      status: "no-deck",
      reason: "no-group",
      lazyCount: lazyMatches.length,
      unsizedLazyCount: unsizedLazy,
    };
  }
  // Cap on what would actually be fetched, so a loop-clone carousel that
  // collapses back under the limit is not declined for its clones.
  if (slides.length > MAX_IMAGES) {
    return { status: "too-many", count: slides.length };
  }

  return {
    status: "ok",
    slides: slides.map((c) => ({
      index: c.index,
      url: c.url.href,
      width: Math.round(c.width),
      height: Math.round(c.height),
    })),
    lazyCount: lazyMatches.length,
    unsizedLazyCount: unsizedLazy,
    lowCountWarning: isLowCount(slides, ctx),
    droppedDuplicates: dropped,
  };
}
