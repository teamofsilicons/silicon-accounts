// Tiny but well-formed images for photo uploads in tests (the service checks the header chunks,
// not the pixels).

/** A PNG whose header says `width`×`height` (signature, IHDR, IEND). */
export function pngBytes(width = 64, height = 64): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const ihdr = [...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89];
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  return Uint8Array.from([...header, ...ihdr, ...iend]);
}
