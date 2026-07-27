/**
 * Generic-mode flow state and message contracts, shared by popup, worker,
 * and the injected collector.
 *
 * All flow state lives in chrome.storage.session keyed by tab id (the MV3
 * worker can be torn down and the popup closes on focus loss; neither may
 * hold the only copy). Only trusted contexts (popup, worker) touch storage;
 * the collector reports through messages so storage.session never has to be
 * exposed to content-script contexts via setAccessLevel.
 */

export interface StoredSlide {
  /** Document-order index from the scan, for labeling and duplicate spotting. */
  index: number;
  url: string;
  width: number;
  height: number;
  /** Small JPEG data URL for the confirm strip; empty when undrawable. */
  thumb: string;
  selected: boolean;
}

export type ScanStatus = "ok" | "no-deck" | "cross-origin" | "too-many";

export interface GenericFlowState {
  phase: "collected" | "converting" | "done" | "error";
  status: ScanStatus;
  reason?: "no-group" | "lazy";
  title: string;
  slides: StoredSlide[];
  lazyCount: number;
  unsizedLazyCount: number;
  lowCountWarning: boolean;
  droppedDuplicates: number;
  sampleHost?: string;
  progress?: { done: number; total: number; stage: "fetch" | "assemble" };
  pageCount?: number;
  error?: string;
  updatedAt: number;
}

export function stateKey(tabId: number): string {
  return "generic:" + tabId;
}

/** Collector -> worker: one base64 piece of one converted image. */
export interface GenericImageChunk {
  type: "genericImageChunk";
  sessionId: string;
  index: number;
  mime: "image/png" | "image/jpeg";
  seq: number;
  parts: number;
  data: string;
}

/** Base64 characters per chunk message; keeps far under the 64MB message cap. */
export const CHUNK_CHARS = 8 * 1024 * 1024;
/** Upper bound on chunks per image (caps a single image near 512MB b64). */
export const MAX_PARTS = 64;

export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
