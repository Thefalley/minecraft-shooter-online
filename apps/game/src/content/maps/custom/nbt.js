// NBT (Named Binary Tag) parser — the format Minecraft uses for level.dat and
// chunk data. Big-endian. Longs are returned as BigInt, long arrays as BigInt[].
// The input must already be decompressed.

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

const utf8 = new TextDecoder();

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  u8() { return this.view.getUint8(this.pos++); }
  i8() { return this.view.getInt8(this.pos++); }
  i16() { const v = this.view.getInt16(this.pos, false); this.pos += 2; return v; }
  i32() { const v = this.view.getInt32(this.pos, false); this.pos += 4; return v; }
  i64() { const v = this.view.getBigInt64(this.pos, false); this.pos += 8; return v; }
  f32() { const v = this.view.getFloat32(this.pos, false); this.pos += 4; return v; }
  f64() { const v = this.view.getFloat64(this.pos, false); this.pos += 8; return v; }

  string() {
    const len = this.view.getUint16(this.pos, false);
    this.pos += 2;
    const s = utf8.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  payload(type) {
    switch (type) {
      case TAG_BYTE: return this.i8();
      case TAG_SHORT: return this.i16();
      case TAG_INT: return this.i32();
      case TAG_LONG: return this.i64();
      case TAG_FLOAT: return this.f32();
      case TAG_DOUBLE: return this.f64();
      case TAG_BYTE_ARRAY: {
        const len = this.i32();
        const arr = new Int8Array(this.bytes.buffer, this.bytes.byteOffset + this.pos, len).slice();
        this.pos += len;
        return arr;
      }
      case TAG_STRING: return this.string();
      case TAG_LIST: {
        const itemType = this.u8();
        const len = this.i32();
        const list = new Array(len);
        for (let i = 0; i < len; i += 1) list[i] = this.payload(itemType);
        return list;
      }
      case TAG_COMPOUND: {
        const obj = {};
        for (;;) {
          const t = this.u8();
          if (t === TAG_END) break;
          const name = this.string();
          obj[name] = this.payload(t);
        }
        return obj;
      }
      case TAG_INT_ARRAY: {
        const len = this.i32();
        const arr = new Array(len);
        for (let i = 0; i < len; i += 1) arr[i] = this.i32();
        return arr;
      }
      case TAG_LONG_ARRAY: {
        const len = this.i32();
        const arr = new Array(len);
        for (let i = 0; i < len; i += 1) arr[i] = this.i64();
        return arr;
      }
      default:
        throw new Error(`Tipo NBT desconocido: ${type}`);
    }
  }
}

// Parses a decompressed NBT buffer. Returns the root compound value (the root's
// name is discarded — Minecraft's root is typically an empty-named compound).
export function parseNBT(bytes) {
  const reader = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const type = reader.u8();
  if (type !== TAG_COMPOUND) throw new Error('NBT no empieza por un compound.');
  reader.string(); // root name
  return reader.payload(TAG_COMPOUND);
}

export default parseNBT;
