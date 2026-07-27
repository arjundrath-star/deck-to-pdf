/**
 * Fetch a slide image and return it as base64 JPEG/PNG, ready for pdf-lib.
 *
 * Runs in either context:
 *   - Background worker (DocSend): host_permissions bypass CORS.
 *   - Content script (Papermark): runs in the page origin, so the request
 *     carries the papermark.com referrer and passes Papermark's CloudFront
 *     hotlink protection (the worker gets 403 without the referrer).
 *
 * Small JPEG/PNG pass through. Larger images are decoded and downscaled to
 * MAX_EDGE JPEG to keep payloads and the PDF small (Papermark serves ~3776px
 * PNGs). If decoding fails but the bytes are a real JPEG/PNG, we pass them
 * through full-size rather than dropping the page.
 */

export interface FetchedImage {
  type: "image/jpeg" | "image/png";
  b64: string;
}

const ALLOWED_HOST =
  /(^|\.)docsend\.com$|(^|\.)cloudfront\.net$|(^|\.)papermark\.(com|io)$/i;

export function isAllowedImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && ALLOWED_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

const MAX_PASSTHROUGH_BYTES = 1_200_000;
const MAX_EDGE = 2048;

export async function fetchAndEncode(url: string): Promise<FetchedImage> {
  if (!isAllowedImageUrl(url)) {
    throw new Error("Refusing to fetch a URL that is not DocSend/Papermark or its image CDN.");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const type = blob.type;
  const isJpegPng = type === "image/jpeg" || type === "image/png";

  // Small JPEG/PNG: pass straight through.
  if (isJpegPng && blob.size <= MAX_PASSTHROUGH_BYTES) {
    return { type: type as "image/jpeg" | "image/png", b64: await blobToB64(blob) };
  }

  // Otherwise try to decode + downscale to JPEG.
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    return { type: "image/jpeg", b64: await blobToB64(jpeg) };
  } catch (e) {
    // Decode failed. If the bytes are still a real JPEG/PNG, embed full-size.
    if (isJpegPng) {
      return { type: type as "image/jpeg" | "image/png", b64: await blobToB64(blob) };
    }
    throw new Error(
      `decode failed (type=${type || "?"} bytes=${blob.size}): ${e instanceof Error ? e.name : String(e)}`
    );
  }
}

async function blobToB64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
