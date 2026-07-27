/**
 * Background service worker.
 *
 * DocSend/Papermark path (unchanged): fetches slide images with host
 * permissions, because those sites' CDNs block page-context reads via CORS.
 * Papermark additionally needs a Referer header, set through a temporary
 * declarativeNetRequest session rule.
 *
 * Generic mode (v0.4): the injected collector fetches same-origin images in
 * page context and streams them here as base64 chunks; this worker buffers
 * them per session, assembles the PDF with the shared core/pdf.ts, and
 * triggers the download. Flow state lives in chrome.storage.session keyed by
 * tab id so a reopened popup can show progress; image bytes stay in worker
 * memory only for the seconds a conversion runs.
 *
 * Trust model for generic messages: they must come from a tab's content
 * script (sender.tab present). A session is bound to the first sender's tab
 * id; chunks from any other tab are rejected. Chunk shape, mime, counts, and
 * cumulative size are validated against the same caps the collector honors.
 */

import { fetchAndEncode, type FetchedImage } from "./core/image-fetch";
import { assemblePdf, sanitizeFilename, type SlideImage } from "./core/pdf";
import { b64ToBytes, bytesToB64 } from "./core/b64";
import { MAX_IMAGES, MAX_TOTAL_BYTES } from "./core/generic";
import {
  CHUNK_CHARS,
  MAX_PARTS,
  SESSION_ID_RE,
  stateKey,
  type GenericFlowState,
} from "./core/generic-flow";

interface FetchResponse {
  images?: FetchedImage[];
  error?: string;
}

const REFERRER_RULE_ID = 1001;

interface BufferedImage {
  mime: "image/png" | "image/jpeg";
  parts: (string | null)[];
}

interface GenericSession {
  tabId: number;
  images: (BufferedImage | undefined)[];
  receivedChars: number;
  lastActivity: number;
}

const sessions = new Map<string, GenericSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "fetchImages" && Array.isArray(msg.urls)) {
    // Popup-only path. Content scripts (which now run on arbitrary pages via
    // the generic collector) have sender.tab set; the popup does not. Keeps
    // page-adjacent code away from the host-permission fetch path.
    if (sender.tab) {
      sendResponse({ error: "fetchImages is popup-only." } as FetchResponse);
      return false;
    }
    fetchAll(msg.urls, typeof msg.referrer === "string" ? msg.referrer : undefined)
      .then((images) => sendResponse({ images } as FetchResponse))
      .catch((err) => sendResponse({ error: String(err) } as FetchResponse));
    return true; // keep the message channel open for the async response
  }

  if (typeof msg?.type === "string" && msg.type.startsWith("generic")) {
    sweepStaleSessions();
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
      // Generic ingestion only accepts content-script senders.
      sendResponse({ ok: false, error: "Not a tab message." });
      return false;
    }
    handleGeneric(msg, tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true;
  }

  return false;
});

async function handleGeneric(msg: Record<string, unknown>, tabId: number): Promise<void> {
  switch (msg.type) {
    case "genericProgress": {
      const { done, total } = msg;
      if (!isCount(done, 0) || !isCount(total, 1) || (done as number) > (total as number)) return;
      await mergeState(tabId, {
        phase: "converting",
        progress: { done: done as number, total: total as number, stage: "fetch" },
        error: undefined,
      });
      return;
    }
    case "genericImageChunk":
      ingestChunk(msg, tabId);
      return;
    case "genericAssemble": {
      const { sessionId, title, count } = msg;
      if (typeof sessionId !== "string" || typeof title !== "string" || !isCount(count, 1)) {
        throw new Error("Bad assemble request.");
      }
      await assembleGeneric(sessionId, title, count as number, tabId);
      return;
    }
    case "genericFail": {
      dropSessionsForTab(tabId);
      const error = typeof msg.error === "string" ? msg.error : "Conversion failed.";
      await mergeState(tabId, { phase: "error", error });
      return;
    }
    default:
      throw new Error("Unknown generic message.");
  }
}

function ingestChunk(msg: Record<string, unknown>, tabId: number): void {
  const { sessionId, index, mime, seq, parts, data } = msg;
  if (
    typeof sessionId !== "string" ||
    !SESSION_ID_RE.test(sessionId) ||
    !isCount(index, 0) ||
    (index as number) >= MAX_IMAGES ||
    (mime !== "image/png" && mime !== "image/jpeg") ||
    !isCount(seq, 0) ||
    !isCount(parts, 1) ||
    (parts as number) > MAX_PARTS ||
    (seq as number) >= (parts as number) ||
    typeof data !== "string" ||
    data.length > CHUNK_CHARS
  ) {
    throw new Error("Bad image chunk.");
  }

  let session = sessions.get(sessionId);
  if (!session) {
    if (index !== 0 || seq !== 0) {
      // The worker restarted mid-stream and the buffer is gone.
      throw new Error("The conversion was interrupted. Try again.");
    }
    session = { tabId, images: [], receivedChars: 0, lastActivity: Date.now() };
    sessions.set(sessionId, session);
  }
  if (session.tabId !== tabId) throw new Error("Session belongs to another tab.");

  let image = session.images[index as number];
  if (!image) {
    image = { mime, parts: new Array(parts as number).fill(null) };
    session.images[index as number] = image;
  }
  if (image.mime !== mime || image.parts.length !== parts || image.parts[seq as number] !== null) {
    throw new Error("Inconsistent image chunk.");
  }
  session.receivedChars += data.length;
  if (session.receivedChars * 0.75 > MAX_TOTAL_BYTES * 1.1) {
    sessions.delete(sessionId);
    throw new Error("This deck is over the 200MB limit.");
  }
  image.parts[seq as number] = data;
  session.lastActivity = Date.now();
}

async function assembleGeneric(
  sessionId: string,
  title: string,
  count: number,
  tabId: number
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.tabId !== tabId) {
    throw new Error("The conversion was interrupted. Try again.");
  }
  sessions.delete(sessionId);
  if (count > MAX_IMAGES || count > session.images.length) {
    throw new Error("Bad assemble request.");
  }

  const slides: SlideImage[] = [];
  for (let i = 0; i < count; i++) {
    const image = session.images[i];
    if (!image || image.parts.some((p) => p === null)) {
      throw new Error(`Page ${i + 1} went missing in transfer. Try again.`);
    }
    slides.push({ type: image.mime, bytes: b64ToBytes(image.parts.join("")) });
  }

  await mergeState(tabId, {
    phase: "converting",
    progress: { done: count, total: count, stage: "assemble" },
  });

  // strict: a page the user confirmed in the strip must never be dropped
  // silently (the classic path's skip-and-warn is wrong for generic mode).
  const result = await assemblePdf(title, slides, { strict: true });
  // MV3 workers have no URL.createObjectURL; a data URL is the supported path.
  const url = "data:application/pdf;base64," + bytesToB64(result.bytes);
  await chrome.downloads.download({
    url,
    filename: sanitizeFilename(result.title) + ".pdf",
  });
  // slides emptied: the thumbnails are confidential deck content and have no
  // job left once the PDF is on disk. storage.session should not hold them
  // for the rest of the tab's life.
  await mergeState(tabId, {
    phase: "done",
    pageCount: result.pageCount,
    progress: undefined,
    slides: [],
  });
}

function dropSessionsForTab(tabId: number): void {
  for (const [id, s] of sessions) {
    if (s.tabId === tabId) sessions.delete(id);
  }
}

function sweepStaleSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) sessions.delete(id);
  }
}

function isCount(v: unknown, min: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= 1_000_000;
}

async function mergeState(tabId: number, patch: Partial<GenericFlowState>): Promise<void> {
  const key = stateKey(tabId);
  const current = (await chrome.storage.session.get(key))[key] as GenericFlowState | undefined;
  const base: GenericFlowState = current ?? {
    phase: "converting",
    status: "ok",
    title: "",
    slides: [],
    lazyCount: 0,
    unsizedLazyCount: 0,
    lowCountWarning: false,
    droppedDuplicates: 0,
    updatedAt: 0,
  };
  await chrome.storage.session.set({ [key]: { ...base, ...patch, updatedAt: Date.now() } });
}

// A closed tab takes its flow state and any in-flight buffers with it.
chrome.tabs.onRemoved.addListener((tabId) => {
  dropSessionsForTab(tabId);
  void chrome.storage.session.remove(stateKey(tabId));
});

// Navigation kills the activeTab grant and the collector. Fail loudly when a
// conversion was running; otherwise just drop the stale scan.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const hadSession = [...sessions.values()].some((s) => s.tabId === tabId);
  dropSessionsForTab(tabId);
  if (hadSession) {
    void mergeState(tabId, {
      phase: "error",
      error: "The page navigated before the PDF finished. Reopen the deck and try again.",
    });
  } else {
    void chrome.storage.session.remove(stateKey(tabId));
  }
});

async function fetchAll(urls: string[], referrer?: string): Promise<FetchedImage[]> {
  if (referrer) await setReferrerRule(referrer);
  try {
    const out: FetchedImage[] = [];
    for (const url of urls) {
      out.push(await fetchAndEncode(url));
    }
    return out;
  } finally {
    if (referrer) await clearReferrerRule();
  }
}

/** Temporarily force a Referer header on CDN image requests (Papermark
 *  hotlink). Known narrow bleed: the rule is global while active, so a
 *  generic-mode conversion running on a *.cloudfront.net-origin page during
 *  a concurrent Papermark fetch would get its Referer rewritten too.
 *  Accepted: the overlap is exotic and the effect cosmetic. */
async function setReferrerRule(referrer: string): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERRER_RULE_ID],
    addRules: [
      {
        id: REFERRER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [
            {
              header: "referer",
              operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
              value: referrer,
            },
          ],
        },
        condition: {
          urlFilter: "||cloudfront.net",
          resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType],
        },
      },
    ],
  });
}

async function clearReferrerRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [REFERRER_RULE_ID] });
}
