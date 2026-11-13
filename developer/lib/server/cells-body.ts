/** Bounded control JSON and streaming multipart bytes. Never log request bodies. */
export class CellsBodyLimit extends Error {}
export async function cellsBody(request: Request, streaming: boolean, encodedFunction = false): Promise<{body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | undefined; oversized: () => boolean}> {
  const limit = streaming ? 1024 ** 3 : (encodedFunction ? 2 : 1) * 1024 ** 2;
  let oversized = false;
  if (["GET", "HEAD"].includes(request.method)) return {body: undefined, oversized: () => false};
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) throw new CellsBodyLimit();
  if (streaming) {
    let bytes = 0;
    const body = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > limit) { oversized = true; throw new CellsBodyLimit(); }
        controller.enqueue(chunk);
      },
    }));
    return {body, oversized: () => oversized};
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new CellsBodyLimit(); }
    chunks.push(item.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return {body, oversized: () => false};
}
