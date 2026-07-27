/**
 * Generic-mode collector. Injected into the active tab by the popup via
 * chrome.scripting.executeScript under the activeTab grant; never declared
 * in manifest content_scripts.
 *
 * Two jobs, both driven by popup messages:
 *   genericCollect  - snapshot the page's <img> elements, run the pure
 *                     heuristic (core/generic.ts), return slides + thumbs.
 *   genericConvert  - fetch the confirmed slides IN PAGE CONTEXT (first-party
 *                     cookies and Referer ride along, zero host-permission
 *                     assumptions), convert non-PNG/JPEG bytes to PNG via
 *                     canvas, and stream base64 chunks to the worker, which
 *                     assembles and downloads the PDF.
 *
 * Input hardening (the page is attacker-controlled):
 *   - only URLs this collector itself found in its LAST scan are fetchable;
 *   - same-origin + http(s) re-checked at fetch time, redirect: "error";
 *   - 200-image / 200MB caps abort the run.
 */

import { MAX_IMAGES, MAX_TOTAL_BYTES, type DeckAnalysis } from "./core/generic";
import { analyzeDocument } from "./core/generic-dom";
import { blobToB64 } from "./core/b64";
import { CHUNK_CHARS, SESSION_ID_RE, type StoredSlide } from "./core/generic-flow";

(() => {
  const flagged = window as unknown as { __deckToPdfCollector?: boolean };
  if (flagged.__deckToPdfCollector) return;
  flagged.__deckToPdfCollector = true;

  /** Trust boundary for convert: url -> scan index from the last scan only. */
  let lastCollected = new Map<string, number>();
  let converting = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "genericCollect") {
      try {
        sendResponse(collect());
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return false;
    }
    if (msg?.type === "genericConvert") {
      sendResponse(startConvert(msg));
      return false;
    }
    return false;
  });

  function collect(): {
    ok: true;
    title: string;
    analysis: DeckAnalysis;
    slides: StoredSlide[];
  } {
    const { analysis, imgs } = analyzeDocument(window, document);

    lastCollected = new Map();
    let slides: StoredSlide[] = [];
    if (analysis.status === "ok") {
      for (const s of analysis.slides) lastCollected.set(s.url, s.index);
      slides = analysis.slides.map((s) => ({
        ...s,
        thumb: drawThumb(imgs[s.index]),
        selected: true,
      }));
    }
    return { ok: true, title: document.title || location.hostname, analysis, slides };
  }

  function drawThumb(el: HTMLImageElement | undefined): string {
    if (!el || el.naturalWidth === 0) return "";
    try {
      const w = 120;
      const h = Math.max(1, Math.round((el.naturalHeight / el.naturalWidth) * w));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      ctx.drawImage(el, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.6);
    } catch {
      return "";
    }
  }

  function startConvert(msg: {
    urls?: unknown;
    title?: unknown;
    sessionId?: unknown;
  }): { ok: boolean; error?: string } {
    if (converting) return { ok: false, error: "A conversion is already running in this tab." };
    const { urls, title, sessionId } = msg;
    if (
      !Array.isArray(urls) ||
      urls.length === 0 ||
      urls.length > MAX_IMAGES ||
      !urls.every((u) => typeof u === "string" && lastCollected.has(u))
    ) {
      return { ok: false, error: "Scan the page again, then convert." };
    }
    if (typeof title !== "string" || typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      return { ok: false, error: "Bad convert request." };
    }
    void runConvert(urls as string[], title, sessionId);
    return { ok: true };
  }

  /** Per-image fetch timeout: a stalled request must not strand the flow in
   *  "converting" forever (the popup has no cancel). */
  const FETCH_TIMEOUT_MS = 30_000;

  async function runConvert(urls: string[], title: string, sessionId: string): Promise<void> {
    converting = true;
    let totalBytes = 0;
    let done = 0;
    // Keepalive: the MV3 worker's ~30s idle clock runs while we fetch and
    // decode with no message in flight. A slow slide would otherwise tear the
    // worker down and lose the chunk buffer, making retries fail the same
    // way. A periodic progress ping keeps it alive; failures are harmless.
    const keepalive = setInterval(() => {
      void chrome.runtime
        .sendMessage({ type: "genericProgress", sessionId, done, total: urls.length })
        .catch(() => {});
    }, 10_000);
    try {
      for (let i = 0; i < urls.length; i++) {
        done = i;
        await send({ type: "genericProgress", sessionId, done: i, total: urls.length });
        const url = new URL(urls[i]);
        if (url.origin !== location.origin || (url.protocol !== "https:" && url.protocol !== "http:")) {
          throw new Error("Blocked a URL that is not same-origin.");
        }
        const res = await fetch(url.href, {
          redirect: "error",
          credentials: "same-origin",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Page ${i + 1}: the site answered HTTP ${res.status}.`);
        const blob = await res.blob();
        totalBytes += blob.size;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error("This deck is over the 200MB limit.");
        }
        if (!blob.type.startsWith("image/")) {
          throw new Error(`Page ${i + 1} did not come back as an image.`);
        }
        const { mime, data } = await toPdfImage(blob, i);
        await sendChunks(sessionId, i, mime, data);
      }
      await send({ type: "genericAssemble", sessionId, title, count: urls.length });
    } catch (err) {
      try {
        await send({
          type: "genericFail",
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Worker unreachable; nothing left to report to.
      }
    } finally {
      clearInterval(keepalive);
      converting = false;
    }
  }

  /** pdf-lib embeds only PNG/JPEG; decode anything else (webp) to PNG here.
   *  Same-origin bytes fetched directly, so the canvas is never tainted. */
  async function toPdfImage(
    blob: Blob,
    index: number
  ): Promise<{ mime: "image/png" | "image/jpeg"; data: string }> {
    if (blob.type === "image/png" || blob.type === "image/jpeg") {
      return { mime: blob.type, data: await blobToB64(blob) };
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      // createImageBitmap rejects SVG (and other undecodables); a raw
      // InvalidStateError would be gibberish to the user.
      throw new Error(
        `Page ${index + 1} uses an image format (${blob.type || "unknown"}) this version can't convert.`
      );
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get a canvas context.");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const png = await canvas.convertToBlob({ type: "image/png" });
    return { mime: "image/png", data: await blobToB64(png) };
  }

  async function sendChunks(
    sessionId: string,
    index: number,
    mime: "image/png" | "image/jpeg",
    data: string
  ): Promise<void> {
    const parts = Math.max(1, Math.ceil(data.length / CHUNK_CHARS));
    for (let seq = 0; seq < parts; seq++) {
      // Await each chunk: the worker's ack is the backpressure.
      await send({
        type: "genericImageChunk",
        sessionId,
        index,
        mime,
        seq,
        parts,
        data: data.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS),
      });
    }
  }

  /** The worker acks every message; a rejection aborts the run right away. */
  async function send(message: unknown): Promise<void> {
    const resp = (await chrome.runtime.sendMessage(message)) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (resp && resp.ok === false) {
      throw new Error(resp.error || "The extension rejected the transfer.");
    }
  }
})();
