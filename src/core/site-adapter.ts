/**
 * Site adapter contract. One adapter per supported viewer (DocSend, Papermark).
 * The content script picks the matching adapter by inspecting the page, so the
 * extension works seamlessly on either site with no manual toggle.
 *
 * To add a site: implement SiteAdapter and register it in adapters.ts.
 */

export interface DeckContext {
  title: string;
  /** Full-resolution slide image URLs, in page order. */
  pageUrls: string[];
  /**
   * Total slides that should exist (e.g. number of page elements). When the
   * captured pageUrls are fewer than this, the deck is not fully loaded and we
   * must refuse rather than build a partial PDF. Optional; defaults to
   * pageUrls.length when omitted.
   */
  expectedCount?: number;
}

export interface SiteAdapter {
  /** Stable id. */
  id: "docsend" | "papermark";
  /** Human label for status messages; also selects per-site fetch behavior
   *  (e.g. the popup sends a referrer for Papermark). */
  label: string;
  /** True when this adapter handles the current page. */
  matches(): boolean;
  /** Collect the document's ordered page image URLs, or null if none found. */
  collect(): Promise<DeckContext | null>;
}

/** Shared helper: scroll to ms-delay. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared helper: order image URLs by an extracted page number, de-duplicated. */
export function orderedUnique(
  items: { url: string; page: number }[]
): string[] {
  items.sort((a, b) => a.page - b.page);
  const seen = new Set<string>();
  return items.map((x) => x.url).filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

// Note: each adapter owns its own loading strategy (DocSend harvests while the
// window scrolls; Papermark reads the page elements the user has scrolled
// through), because the two sites load very differently. A shared scroller
// proved to be the wrong abstraction. Both fetch image bytes in the background
// worker; Papermark additionally needs a referrer (see background.ts).
