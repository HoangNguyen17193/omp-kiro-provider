/**
 * Incremental decoder for the AWS `application/vnd.amazon.eventstream` binary
 * framing that Kiro's runtime streams back.
 *
 * Frame layout (all integers big-endian):
 *   total length u32 · headers length u32 · prelude CRC32 u32
 *   headers · payload · message CRC32 u32
 * Both CRCs are IEEE CRC32. A frame that fails either check is rejected: the
 * byte stream has lost sync and nothing after it can be trusted.
 */

export type EventStreamHeaderValue = string | number | bigint | boolean | Uint8Array;

export interface EventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>;
  payload: Uint8Array;
}

const PRELUDE_BYTES = 12;
const CRC_BYTES = 4;
const MIN_FRAME_BYTES = PRELUDE_BYTES + CRC_BYTES;
/** Upper bound from the AWS spec; guards against allocating on a corrupt length. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export class EventStreamError extends Error {
  override name = "EventStreamError";
}

const textDecoder = new TextDecoder();

function decodeHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: Record<string, EventStreamHeaderValue> = {};
  let offset = 0;
  const need = (count: number) => {
    if (offset + count > bytes.byteLength) throw new EventStreamError("Truncated event-stream header");
  };
  while (offset < bytes.byteLength) {
    need(1);
    const nameLength = view.getUint8(offset);
    offset += 1;
    need(nameLength + 1);
    const name = textDecoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = view.getUint8(offset);
    offset += 1;
    switch (type) {
      case 0: headers[name] = true; break;
      case 1: headers[name] = false; break;
      case 2: need(1); headers[name] = view.getInt8(offset); offset += 1; break;
      case 3: need(2); headers[name] = view.getInt16(offset); offset += 2; break;
      case 4: need(4); headers[name] = view.getInt32(offset); offset += 4; break;
      case 5: need(8); headers[name] = view.getBigInt64(offset); offset += 8; break;
      case 6:
      case 7: {
        need(2);
        const length = view.getUint16(offset);
        offset += 2;
        need(length);
        const value = bytes.subarray(offset, offset + length);
        headers[name] = type === 7 ? textDecoder.decode(value) : value.slice();
        offset += length;
        break;
      }
      case 8: need(8); headers[name] = view.getBigInt64(offset); offset += 8; break;
      case 9: need(16); headers[name] = bytes.slice(offset, offset + 16); offset += 16; break;
      default: throw new EventStreamError(`Unknown event-stream header type ${type}`);
    }
  }
  return headers;
}

/** Decode one complete, CRC-verified frame. */
export function decodeFrame(frame: Uint8Array): EventStreamMessage {
  if (frame.byteLength < MIN_FRAME_BYTES) throw new EventStreamError("Event-stream frame too short");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const totalLength = view.getUint32(0);
  const headersLength = view.getUint32(4);
  if (totalLength !== frame.byteLength) throw new EventStreamError("Event-stream frame length mismatch");
  if (view.getUint32(8) !== crc32(frame.subarray(0, 8))) throw new EventStreamError("Event-stream prelude CRC mismatch");
  if (view.getUint32(totalLength - CRC_BYTES) !== crc32(frame.subarray(0, totalLength - CRC_BYTES))) {
    throw new EventStreamError("Event-stream message CRC mismatch");
  }
  const headersEnd = PRELUDE_BYTES + headersLength;
  if (headersEnd > totalLength - CRC_BYTES) throw new EventStreamError("Event-stream headers overrun frame");
  return {
    headers: decodeHeaders(frame.subarray(PRELUDE_BYTES, headersEnd)),
    payload: frame.slice(headersEnd, totalLength - CRC_BYTES),
  };
}

/**
 * Accumulates arbitrary network chunks and yields every complete frame.
 * Chunks may split a frame anywhere, including inside the prelude.
 */
export class EventStreamDecoder {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): EventStreamMessage[] {
    const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.byteLength);
    const messages: EventStreamMessage[] = [];
    let offset = 0;
    while (merged.byteLength - offset >= PRELUDE_BYTES) {
      const prelude = new DataView(merged.buffer, merged.byteOffset + offset, PRELUDE_BYTES);
      const totalLength = prelude.getUint32(0);
      // Verify the prelude before waiting on its length, so a corrupt length cannot stall the stream.
      if (prelude.getUint32(8) !== crc32(merged.subarray(offset, offset + 8))) {
        throw new EventStreamError("Event-stream prelude CRC mismatch");
      }
      if (totalLength < MIN_FRAME_BYTES || totalLength > MAX_FRAME_BYTES) {
        throw new EventStreamError(`Invalid event-stream frame length ${totalLength}`);
      }
      if (merged.byteLength - offset < totalLength) break;
      messages.push(decodeFrame(merged.subarray(offset, offset + totalLength)));
      offset += totalLength;
    }
    this.#buffer = merged.slice(offset);
    return messages;
  }

  /** Bytes left over after the stream ended; non-zero means a truncated frame. */
  get pendingBytes(): number {
    return this.#buffer.byteLength;
  }
}

/** Test/fixture helper: encode string-valued headers and a payload into one frame. */
export function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const headerParts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    const part = new Uint8Array(1 + nameBytes.byteLength + 1 + 2 + valueBytes.byteLength);
    const view = new DataView(part.buffer);
    part[0] = nameBytes.byteLength;
    part.set(nameBytes, 1);
    part[1 + nameBytes.byteLength] = 7;
    view.setUint16(2 + nameBytes.byteLength, valueBytes.byteLength);
    part.set(valueBytes, 4 + nameBytes.byteLength);
    headerParts.push(part);
  }
  const headersLength = headerParts.reduce((sum, part) => sum + part.byteLength, 0);
  const totalLength = PRELUDE_BYTES + headersLength + payload.byteLength + CRC_BYTES;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength);
  view.setUint32(4, headersLength);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  let offset = PRELUDE_BYTES;
  for (const part of headerParts) {
    frame.set(part, offset);
    offset += part.byteLength;
  }
  frame.set(payload, offset);
  view.setUint32(totalLength - CRC_BYTES, crc32(frame.subarray(0, totalLength - CRC_BYTES)));
  return frame;
}
