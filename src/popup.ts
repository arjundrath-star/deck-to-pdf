/**
 * Popup — the UI and orchestrator. Two branches:
 *
 * Known site (DocSend/Papermark): unchanged flow. Ask the content script for
 * the ordered page URLs, have the worker fetch the bytes, assemble here,
 * download. All-or-nothing completeness gate.
 *
 * Generic mode (v0.4, everything else): inject the collector under the
 * activeTab grant, show what it found as an ordered thumbnail strip with
 * per-image deselect, then hand the confirmed list back to the collector,
 * which fetches in page context and streams to the worker for assembly.
 * Flow state lives in chrome.storage.session keyed by tab id, so reopening
 * the popup mid-conversion shows live progress instead of a blank slate.
 */

import { assemblePdf, sanitizeFilename, type SlideImage } from "./core/pdf";
import type { FetchedImage } from "./core/image-fetch";
import { b64ToBytes } from "./core/b64";
import type { DeckAnalysis } from "./core/generic";
import { stateKey, type GenericFlowState, type StoredSlide } from "./core/generic-flow";

function isKnownSite(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return /(^|\.)docsend\.com$|(^|\.)papermark\.(com|io)$/.test(u.hostname);
  } catch {
    return false;
  }
}

void (async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null && !isKnownSite(tab.url || "")) {
    (document.getElementById("generic") as HTMLDivElement).hidden = false;
    genericInit(tab.id, tab.url || "");
  } else {
    (document.getElementById("classic") as HTMLDivElement).hidden = false;
  }
})();

/* ---------------- Classic DocSend/Papermark flow (unchanged) ---------------- */

const btn = document.getElementById("go") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

function setStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/(docsend\.com|papermark\.(com|io))/.test(tab.url || "")) {
      setStatus("Open a DocSend or Papermark document in this tab first.", "err");
      return;
    }

    setStatus("Scanning pages…");
    let res: {
      ok: boolean;
      site?: string;
      error?: string;
      deck?: { title: string; pageUrls: string[]; expectedCount?: number };
    };
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: "extractDeck" });
    } catch {
      setStatus("Couldn't reach the page. Reload the deck tab and try again.", "err");
      return;
    }
    if (!res?.ok) {
      setStatus(res?.error ? "Error: " + res.error : "No pages found. Let the document finish loading, then retry.", "err");
      return;
    }

    const where = res.site ? ` (${res.site})` : "";
    if (!res.deck) {
      setStatus("No document found on this page.", "err");
      return;
    }

    const title = res.deck.title;
    const expected = res.deck.expectedCount ?? res.deck.pageUrls.length;
    // All-or-nothing: never build a document that is missing pages.
    if (res.deck.pageUrls.length === 0 || res.deck.pageUrls.length < expected) {
      setStatus(
        `Loaded ${res.deck.pageUrls.length} of ${expected} pages. Scroll through the whole document so every page loads, then click Download again.`,
        "err"
      );
      return;
    }

    setStatus(`Fetching ${res.deck.pageUrls.length} pages${where}…`);
    // Papermark hotlink-protects its CDN; tell the worker to send its referrer.
    const referrer = res.site === "Papermark" ? "https://www.papermark.com/" : undefined;
    const fetchRes = (await chrome.runtime.sendMessage({
      type: "fetchImages",
      urls: res.deck.pageUrls,
      referrer,
    })) as { images?: FetchedImage[]; error?: string };
    if (fetchRes?.error) throw new Error(fetchRes.error);
    if (fetchRes.images?.length !== res.deck.pageUrls.length) {
      throw new Error("Some pages failed to download. Try again.");
    }
    const images: FetchedImage[] = fetchRes.images;

    const slides: SlideImage[] = images.map((im) => ({
      type: im.type,
      bytes: b64ToBytes(im.b64),
    }));

    // Let the user name the file; fall back to the auto title when left blank.
    const override = (document.getElementById("fname") as HTMLInputElement)?.value.trim();
    const finalTitle = override || title;

    setStatus(`Building PDF (${slides.length} pages)…`);
    const result = await assemblePdf(finalTitle, slides);
    triggerDownload(result.bytes, result.title);
    setStatus(`Done. Saved ${result.pageCount} pages.`, "ok");
  } catch (err) {
    setStatus("Error: " + String(err), "err");
  } finally {
    btn.disabled = false;
  }
});

function triggerDownload(bytes: Uint8Array, title: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: sanitizeFilename(title) + ".pdf" }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

/* ---------------------------- Generic mode (v0.4) --------------------------- */

interface CollectResponse {
  ok: boolean;
  error?: string;
  title?: string;
  analysis?: DeckAnalysis;
  slides?: StoredSlide[];
}

function genericInit(tabId: number, tabUrl: string): void {
  const subEl = document.getElementById("g-sub") as HTMLParagraphElement;
  const stripEl = document.getElementById("g-strip") as HTMLDivElement;
  const warnEl = document.getElementById("g-warn") as HTMLDivElement;
  const titleEl = document.getElementById("g-title") as HTMLInputElement;
  const convertBtn = document.getElementById("g-convert") as HTMLButtonElement;
  const scanBtn = document.getElementById("g-scan") as HTMLButtonElement;
  const gStatusEl = document.getElementById("g-status") as HTMLDivElement;

  const say = (text: string, kind: "" | "ok" | "err" = ""): void => {
    gStatusEl.textContent = text;
    gStatusEl.className = "status" + (kind ? " " + kind : "");
  };

  if (!/^https?:\/\//.test(tabUrl)) {
    scanBtn.disabled = true;
    say("This page can't be scanned. Open the deck site in a normal tab.", "err");
    return;
  }

  let state: GenericFlowState | null = null;
  const key = stateKey(tabId);

  const save = async (): Promise<void> => {
    if (state) await chrome.storage.session.set({ [key]: state });
  };

  // Restore whatever a previous popup lifetime left behind, and follow the
  // worker's progress writes while a conversion runs.
  void chrome.storage.session.get(key).then((found) => {
    const st = found[key] as GenericFlowState | undefined;
    if (st) {
      state = st;
      render();
    }
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    const change = changes[key];
    if (!change) return;
    if (change.newValue) {
      state = change.newValue as GenericFlowState;
    } else {
      // The worker removed the state (navigation, tab teardown). Rendering
      // the stale strip would offer a Convert into a page that is gone.
      state = null;
    }
    render();
  });

  scanBtn.addEventListener("click", () => void scan());
  convertBtn.addEventListener("click", () => void convert());

  // Re-render once a running conversion crosses the staleness threshold, so
  // the escape hatch appears without the user reopening the popup.
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleStaleCheck(inMs: number): void {
    clearTimeout(staleTimer);
    if (inMs > 0) staleTimer = setTimeout(render, inMs);
  }

  async function scan(): Promise<void> {
    scanBtn.disabled = true;
    say("Scanning…");
    try {
      // Idempotent: the collector guards against double injection.
      await chrome.scripting.executeScript({ target: { tabId }, files: ["generic-collector.js"] });
      const res = (await chrome.tabs.sendMessage(tabId, { type: "genericCollect" })) as CollectResponse;
      if (!res?.ok || !res.analysis) throw new Error(res?.error || "The scan failed.");
      const a = res.analysis;
      state = {
        phase: "collected",
        status: a.status,
        reason: a.status === "no-deck" ? a.reason : undefined,
        title: res.title || "deck",
        slides: res.slides ?? [],
        lazyCount: a.status === "ok" || a.status === "no-deck" ? a.lazyCount : 0,
        unsizedLazyCount: a.status === "ok" || a.status === "no-deck" ? a.unsizedLazyCount : 0,
        lowCountWarning: a.status === "ok" ? a.lowCountWarning : false,
        droppedDuplicates: a.status === "ok" ? a.droppedDuplicates : 0,
        sampleHost: a.status === "cross-origin" ? a.sampleHost : undefined,
        updatedAt: Date.now(),
      };
      await save();
      say("");
      render();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/cannot access|cannot be scripted|extensions gallery/i.test(text)) {
        say("Chrome doesn't allow the extension on this page.", "err");
      } else if (/receiving end/i.test(text)) {
        say("Couldn't reach the page. Reload the tab and try again.", "err");
      } else {
        say("Error: " + text, "err");
      }
    } finally {
      scanBtn.disabled = false;
    }
  }

  async function convert(): Promise<void> {
    if (!state || state.phase !== "collected" || state.status !== "ok") return;
    const selected = state.slides.filter((s) => s.selected);
    if (selected.length === 0) {
      say("Every page is skipped. Click a thumbnail to include it.", "err");
      return;
    }
    const title = titleEl.value.trim() || state.title || "deck";
    state = {
      ...state,
      phase: "converting",
      title,
      progress: { done: 0, total: selected.length, stage: "fetch" },
      error: undefined,
    };
    await save();
    render();
    try {
      const res = (await chrome.tabs.sendMessage(tabId, {
        type: "genericConvert",
        urls: selected.map((s) => s.url),
        title,
        sessionId: crypto.randomUUID(),
      })) as { ok: boolean; error?: string };
      if (!res?.ok) throw new Error(res?.error || "Could not start the conversion.");
    } catch (err) {
      state = { ...state, phase: "collected", progress: undefined };
      await save();
      render();
      say("Error: " + (err instanceof Error ? err.message : String(err)), "err");
    }
  }

  function render(): void {
    const st = state;
    stripEl.hidden = true;
    warnEl.hidden = true;
    titleEl.hidden = true;
    convertBtn.hidden = true;
    scanBtn.hidden = false;
    scanBtn.textContent = st ? "Scan again" : "Scan this page";
    if (!st) return;

    if (st.phase === "converting") {
      // The collector pings progress at least every 10s while alive; a state
      // this stale means the conversion died without reporting (tab
      // discarded, collector gone). Offer the way out.
      const stale = Date.now() - st.updatedAt > 45_000;
      scanBtn.hidden = stale ? false : true;
      if (stale) {
        say("The conversion stopped responding. Reload the deck tab, then scan again.", "err");
        scheduleStaleCheck(0);
        return;
      }
      const p = st.progress;
      if (p && p.stage === "assemble") say("Building the PDF…");
      else if (p) say(`Fetching page ${Math.min(p.done + 1, p.total)} of ${p.total}…`);
      else say("Converting…");
      scheduleStaleCheck(46_000 - (Date.now() - st.updatedAt));
      return;
    }
    if (st.phase === "done") {
      say(`Done. Saved ${st.pageCount ?? 0} pages.`, "ok");
      return;
    }
    if (st.phase === "error") {
      say("Error: " + (st.error || "The conversion failed."), "err");
      return;
    }

    // phase "collected"
    if (st.status === "cross-origin") {
      warnEl.hidden = false;
      warnEl.textContent =
        `This deck loads its slides from ${st.sampleHost || "another domain"}, not from the ` +
        "page's own site. This version only converts same-site decks.";
      say("");
      return;
    }
    if (st.status === "too-many") {
      say("Over 200 matching images on this page. Not supported.", "err");
      return;
    }
    if (st.status === "no-deck") {
      if (st.reason === "lazy" || st.lazyCount > 0) {
        say("The slides have not loaded yet. Scroll through the whole page, then scan again.", "err");
      } else {
        say("No deck found. The scan looks for at least three large, same-shaped images.", "err");
      }
      return;
    }

    // status "ok": the confirm strip
    renderStrip(st.slides);
    const selectedCount = st.slides.filter((s) => s.selected).length;
    const notes: string[] = [];
    if (st.lazyCount > 0) {
      notes.push(
        `${st.lazyCount} more slide${st.lazyCount === 1 ? " has" : "s have"} not loaded yet. ` +
          "Scroll through the whole page, then scan again."
      );
    }
    if (st.unsizedLazyCount > 0) {
      notes.push(
        `${st.unsizedLazyCount} image${st.unsizedLazyCount === 1 ? "" : "s"} on this page ` +
          "haven't loaded and can't be identified. If slides are missing below, scroll " +
          "through the whole page and scan again."
      );
    }
    if (st.lowCountWarning) {
      notes.push(
        "This page scrolls a lot further than the slides found. If pages are missing, " +
          "scroll through them and scan again."
      );
    }
    if (st.droppedDuplicates > 0) {
      notes.push(`Removed ${st.droppedDuplicates} duplicate image${st.droppedDuplicates === 1 ? "" : "s"}.`);
    }
    if (notes.length > 0) {
      warnEl.hidden = false;
      warnEl.textContent = notes.join(" ");
    }
    subEl.textContent = "Check the pages below. Click a thumbnail to skip it.";
    titleEl.hidden = false;
    if (!titleEl.value) titleEl.value = st.title;
    convertBtn.hidden = false;
    convertBtn.textContent = `Convert ${selectedCount} page${selectedCount === 1 ? "" : "s"}`;
    convertBtn.disabled = st.lazyCount > 0 || selectedCount === 0;
  }

  function renderStrip(slides: StoredSlide[]): void {
    stripEl.textContent = "";
    slides.forEach((slide, position) => {
      const cell = document.createElement("div");
      cell.className = "page" + (slide.selected ? "" : " off");
      cell.title = slide.selected ? "Click to skip this page" : "Click to include this page";
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(position + 1);
      if (slide.thumb) {
        const img = document.createElement("img");
        img.src = slide.thumb;
        cell.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "ph";
        ph.textContent = "no preview";
        cell.appendChild(ph);
      }
      cell.appendChild(num);
      cell.addEventListener("click", () => {
        slide.selected = !slide.selected;
        void save().then(render);
      });
      stripEl.appendChild(cell);
    });
    stripEl.hidden = false;
  }
}
