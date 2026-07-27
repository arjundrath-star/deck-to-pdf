/**
 * Base64 helpers shared by the popup, worker, and injected collector.
 * Chunked conversion: String.fromCharCode(...) on a whole multi-MB array
 * blows the argument limit, and byte-at-a-time string building is quadratic.
 */

export async function blobToB64(blob: Blob): Promise<string> {
  return bytesToB64(new Uint8Array(await blob.arrayBuffer()));
}

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
