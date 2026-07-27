/**
 * Content script — runs on DocSend and Papermark deck/document pages.
 *
 * On request from the popup, it picks the matching site adapter, collects the
 * document title + ordered page image URLs (the user must have scrolled through
 * so every page has loaded), and returns them. The popup has the background
 * worker fetch the bytes and assembles the PDF. The completeness gate lives in
 * the popup so a partial document is never built.
 */

import { pickAdapter } from "./core/adapters";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "extractDeck") return false;

  (async () => {
    const adapter = pickAdapter();
    if (!adapter) {
      sendResponse({ ok: false, error: "No DocSend or Papermark document found on this page." });
      return;
    }

    const deck = await adapter.collect();
    if (!deck) {
      sendResponse({ ok: false, error: "No DocSend or Papermark document found on this page." });
      return;
    }
    sendResponse({ ok: true, site: adapter.label, deck });
  })();

  return true; // async response
});
