/**
 * Minimal growable byte stream replacing System.IO.MemoryStream.
 * Reads and writes share one `position` like a .NET MemoryStream.
 */
export class ByteStream {
  private buf: Uint8Array;
  private len: number;
  position = 0;

  constructor(init?: Uint8Array | number[] | number) {
    if (init === undefined) {
      this.buf = new Uint8Array(256);
      this.len = 0;
    } else if (typeof init === "number") {
      this.buf = new Uint8Array(Math.max(init, 16));
      this.len = 0;
    } else {
      this.buf = Uint8Array.from(init);
      this.len = this.buf.length;
    }
  }

  get length(): number {
    return this.len;
  }

  setLength(n: number): void {
    this.ensure(n);
    if (n > this.len) this.buf.fill(0, this.len, n);
    this.len = n;
    if (this.position > n) this.position = n;
  }

  private ensure(n: number): void {
    if (n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  writeByte(b: number): void {
    this.ensure(this.position + 1);
    this.buf[this.position++] = b & 0xff;
    if (this.position > this.len) this.len = this.position;
  }

  write(data: Uint8Array | number[], offset = 0, count = data.length - offset): void {
    this.ensure(this.position + count);
    for (let i = 0; i < count; i++) this.buf[this.position + i] = data[offset + i] & 0xff;
    this.position += count;
    if (this.position > this.len) this.len = this.position;
  }

  /** Returns -1 at end of stream (like Stream.ReadByte). */
  readByte(): number {
    if (this.position >= this.len) return -1;
    return this.buf[this.position++];
  }

  /** Copies up to `count` bytes into `dest`; returns number of bytes read. */
  read(dest: Uint8Array, offset = 0, count = dest.length - offset): number {
    const n = Math.max(0, Math.min(count, this.len - this.position));
    dest.set(this.buf.subarray(this.position, this.position + n), offset);
    this.position += n;
    return n;
  }

  /** Bytes remaining from position to end. */
  get remaining(): number {
    return this.len - this.position;
  }

  /** Copy of the written content (like MemoryStream.ToArray). */
  toArray(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
