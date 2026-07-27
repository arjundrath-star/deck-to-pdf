/**
 * Adapter registry. The content script asks pickAdapter() which site it is on;
 * the first adapter whose matches() returns true handles the deck. This is the
 * seamless auto-detection: no manual toggle.
 */

import type { SiteAdapter } from "./site-adapter";
import { docsendAdapter } from "./docsend";
import { papermarkAdapter } from "./papermark";

export const adapters: SiteAdapter[] = [docsendAdapter, papermarkAdapter];

export function pickAdapter(): SiteAdapter | null {
  return adapters.find((a) => a.matches()) ?? null;
}
