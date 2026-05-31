// Minimal ZIP reader: locates the central directory and exposes each entry,
// inflating deflate (method 8) entries with the native DecompressionStream.
// Enough to read a Minecraft world save downloaded as a .zip — no dependency.

import { rawInflate } from './decompress.js';

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50;  // Central directory file header
const LOC_SIG = 0x04034b50;  // Local file header

function findEOCD(view) {
  // The EOCD is at the end, after an optional comment of up to 65535 bytes.
  const len = view.byteLength;
  const maxBack = Math.min(len, 65535 + 22);
  for (let i = len - 22; i >= len - maxBack; i -= 1) {
    if (i < 0) break;
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

const decoder = new TextDecoder();

export class ZipArchive {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.entries = new Map(); // name -> { method, compressedSize, size, localOffset }
    this._readCentralDirectory();
  }

  _readCentralDirectory() {
    const eocd = findEOCD(this.view);
    if (eocd < 0) throw new Error('No es un archivo .zip válido (falta el EOCD).');

    const count = this.view.getUint16(eocd + 10, true);
    let offset = this.view.getUint32(eocd + 16, true);
    if (offset === 0xffffffff) throw new Error('ZIP64 no soportado.');

    for (let i = 0; i < count; i += 1) {
      if (this.view.getUint32(offset, true) !== CEN_SIG) break;
      const method = this.view.getUint16(offset + 10, true);
      const compressedSize = this.view.getUint32(offset + 20, true);
      const size = this.view.getUint32(offset + 24, true);
      const nameLen = this.view.getUint16(offset + 28, true);
      const extraLen = this.view.getUint16(offset + 30, true);
      const commentLen = this.view.getUint16(offset + 32, true);
      const localOffset = this.view.getUint32(offset + 42, true);
      const name = decoder.decode(this.bytes.subarray(offset + 46, offset + 46 + nameLen));
      this.entries.set(name, { method, compressedSize, size, localOffset });
      offset += 46 + nameLen + extraLen + commentLen;
    }
  }

  list() {
    return [...this.entries.keys()];
  }

  has(name) {
    return this.entries.has(name);
  }

  // Returns the decompressed bytes of an entry.
  async read(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Entrada no encontrada en el zip: ${name}`);

    // The local header repeats the name/extra lengths (which may differ from the
    // central directory), so the data offset must be computed from it.
    let p = entry.localOffset;
    if (this.view.getUint32(p, true) !== LOC_SIG) throw new Error('Cabecera local de zip corrupta.');
    const nameLen = this.view.getUint16(p + 26, true);
    const extraLen = this.view.getUint16(p + 28, true);
    p += 30 + nameLen + extraLen;

    const data = this.bytes.subarray(p, p + entry.compressedSize);
    if (entry.method === 0) return data.slice(); // stored
    if (entry.method === 8) return rawInflate(data); // deflate
    throw new Error(`Método de compresión de zip no soportado: ${entry.method}`);
  }
}

export default ZipArchive;
