// Lossless JPEG (ITU-T T.81 process 14: SOF3, Huffman coded differences) as used in DNG.
//
// Encoder: predictor 1 (left neighbour), one optimal Huffman table per component.
// Readers this has to satisfy:
// - LibRaw (decoders_dcraw.cpp ljpeg_start/ljpeg_row) ignores the table selectors in SOS and
//   decodes component c with Huffman table c, so component c must use table c.
// - LibRaw and the DNG SDK return -32768 for difference category 16 without reading extra
//   bits (T.81 H.1.2.2; DNG 1.1 and later), which is what we write.
// - libjpeg-derived decoders treat an all-ones code word as padding, so no code may be all
//   ones (T.81 Annex K.2: build the code with a reserved pseudo-symbol).

const SOI = 0xffd8;
const EOI = 0xffd9;
const SOF3 = 0xffc3;
const DHT = 0xffc4;
const SOS = 0xffda;
const DRI = 0xffdd;

/** 17 difference categories (SSSS 0..16). */
const NSYM = 17;

// Scratch buffers, reused by every call (each worker has its own module instance).
let catBuf = new Uint8Array(0);
let bitsBuf = new Uint16Array(0);
let outBuf = new Uint8Array(0);

export interface LosslessJpegImage {
  /** Frame columns. */
  width: number;
  /** Frame rows. */
  height: number;
  components: number;
  precision: number;
  /** Interleaved samples: row by row, `components` samples per frame column. */
  data: Uint16Array;
}

/**
 * Code lengths for the symbols of `freq` (T.81 Annex K.2, as in libjpeg's
 * jpeg_gen_optimal_table): Huffman merge with a pseudo-symbol that takes the all-ones code,
 * then lengths over 16 are folded back.
 * Returns the BITS list (bits[l] = number of codes of length l, 1..16) and HUFFVAL.
 */
export function optimalHuffman(freq: ArrayLike<number>): { bits: number[]; values: number[] } {
  const n = freq.length;
  const f = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) f[i] = freq[i]!;
  f[n] = 1;
  const size = new Int32Array(n + 1);
  const others = new Int32Array(n + 1).fill(-1);
  for (;;) {
    // The two smallest non-zero frequencies; ties go to the larger symbol, so the
    // pseudo-symbol ends up with the longest code.
    let c1 = -1;
    let v = Infinity;
    for (let i = 0; i <= n; i++) if (f[i]! > 0 && f[i]! <= v) (v = f[i]!), (c1 = i);
    let c2 = -1;
    v = Infinity;
    for (let i = 0; i <= n; i++) if (f[i]! > 0 && f[i]! <= v && i !== c1) (v = f[i]!), (c2 = i);
    if (c2 < 0) break;
    f[c1]! += f[c2]!;
    f[c2] = 0;
    size[c1]!++;
    while (others[c1]! >= 0) size[(c1 = others[c1]!)]!++;
    others[c1] = c2;
    size[c2]!++;
    while (others[c2]! >= 0) size[(c2 = others[c2]!)]!++;
  }
  const bits = new Array<number>(n + 2).fill(0);
  for (let i = 0; i <= n; i++) if (size[i]) bits[size[i]!]!++;
  let i = bits.length - 1;
  for (; i > 16; i--) {
    while (bits[i]! > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i]! -= 2;
      bits[i - 1]!++;
      bits[j + 1]! += 2;
      bits[j]!--;
    }
  }
  while (bits[i] === 0) i--;
  bits[i]!--;
  const values: number[] = [];
  for (let len = 1; len <= n + 1; len++) for (let s = 0; s < n; s++) if (size[s] === len) values.push(s);
  return { bits: bits.slice(0, 17), values };
}

/** Canonical codes (T.81 Annex C) for a BITS/HUFFVAL pair, indexed by symbol. */
function canonicalCodes(bits: number[], values: number[], codes: Int32Array, lens: Int32Array, base: number): void {
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len]!; i++) {
      const s = values[k++]!;
      codes[base + s] = code++;
      lens[base + s] = len;
    }
    code <<= 1;
  }
}

/**
 * Encodes one lossless JPEG frame of `width` columns x `height` rows with `components`
 * interleaved samples per column (`samples.length` = width * height * components), predictor 1.
 * Differences are taken modulo 2^16 (T.81 H.1.2.1), so any 16-bit data round-trips at
 * precision 16.
 */
export function encodeLosslessJpeg(samples: Uint16Array, width: number, height: number, components: number, precision = 16): Uint8Array {
  if (components < 1 || components > 4) throw new Error(`Lossless JPEG: ${components} components (1..4 supported)`);
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error(`Lossless JPEG: bad frame size ${width}x${height}`);
  if (precision < 2 || precision > 16) throw new Error(`Lossless JPEG: precision ${precision}`);
  const rowLen = width * components;
  const n = rowLen * height;
  if (samples.length < n) throw new Error('Lossless JPEG: not enough samples');
  if (catBuf.length < n) {
    catBuf = new Uint8Array(n);
    bitsBuf = new Uint16Array(n);
  }
  const cats = catBuf;
  const extra = bitsBuf;
  const hist = new Int32Array(components * NSYM);
  const initial = 1 << (precision - 1);

  // Pass 1: differences -> category + extra bits, histogram per component.
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0, c = 0; x < rowLen; x++, i++) {
      const pred = x >= components ? samples[i - components]! : y > 0 ? samples[i - rowLen]! : initial;
      const d = ((samples[i]! - pred) << 16) >> 16;
      let cat: number;
      if (d > 0) {
        cat = 32 - Math.clz32(d);
        extra[i] = d;
      } else if (d === 0) {
        cat = 0;
        extra[i] = 0;
      } else if (d === -32768) {
        cat = 16;
        extra[i] = 0;
      } else {
        cat = 32 - Math.clz32(-d);
        extra[i] = (d - 1) & ((1 << cat) - 1);
      }
      cats[i] = cat;
      hist[c * NSYM + cat]!++;
      if (++c === components) c = 0;
    }
  }

  // Huffman tables.
  const codes = new Int32Array(components * NSYM);
  const lens = new Int32Array(components * NSYM);
  const tables: { bits: number[]; values: number[] }[] = [];
  for (let c = 0; c < components; c++) {
    const t = optimalHuffman(hist.subarray(c * NSYM, (c + 1) * NSYM));
    tables.push(t);
    canonicalCodes(t.bits, t.values, codes, lens, c * NSYM);
  }

  // Worst case: 31 bits per sample, every byte stuffed.
  const headerSize = 2 + (2 + 8 + 3 * components) + (2 + 2 + components * (17 + NSYM)) + (2 + 6 + 2 * components) + 2;
  const need = headerSize + n * 8 + 16;
  if (outBuf.length < need) outBuf = new Uint8Array(need);
  const out = outBuf;
  let p = 0;
  const u16 = (v: number) => {
    out[p++] = v >> 8;
    out[p++] = v & 255;
  };
  u16(SOI);
  u16(SOF3);
  u16(8 + 3 * components);
  out[p++] = precision;
  u16(height);
  u16(width);
  out[p++] = components;
  for (let c = 0; c < components; c++) {
    out[p++] = c;
    out[p++] = 0x11;
    out[p++] = 0;
  }
  u16(DHT);
  u16(2 + tables.reduce((s, t) => s + 17 + t.values.length, 0));
  tables.forEach((t, c) => {
    out[p++] = c; // class 0, table c
    for (let l = 1; l <= 16; l++) out[p++] = t.bits[l]!;
    for (const v of t.values) out[p++] = v;
  });
  u16(SOS);
  u16(6 + 2 * components);
  out[p++] = components;
  for (let c = 0; c < components; c++) {
    out[p++] = c;
    out[p++] = c << 4;
  }
  out[p++] = 1; // predictor
  out[p++] = 0;
  out[p++] = 0; // point transform

  // Pass 2: entropy-coded data. acc holds nb (< 8 between symbols) pending bits in its low
  // bits; bits above them are stale and get shifted out.
  let acc = 0;
  let nb = 0;
  for (let i = 0, c = 0; i < n; i++) {
    const cat = cats[i]!;
    const t = c + cat;
    const len = lens[t]!;
    const xl = cat & 15; // category 16 has no extra bits
    if (len + xl <= 24) {
      acc = (acc << (len + xl)) | (codes[t]! << xl) | extra[i]!;
      nb += len + xl;
    } else {
      acc = (acc << len) | codes[t]!;
      nb += len;
      while (nb >= 8) {
        nb -= 8;
        const b = (acc >>> nb) & 255;
        out[p++] = b;
        if (b === 255) out[p++] = 0;
      }
      acc = (acc << xl) | extra[i]!;
      nb += xl;
    }
    while (nb >= 8) {
      nb -= 8;
      const b = (acc >>> nb) & 255;
      out[p++] = b;
      if (b === 255) out[p++] = 0;
    }
    c += NSYM;
    if (c === components * NSYM) c = 0;
  }
  if (nb > 0) {
    // Pad with one bits (T.81 F.1.2.3).
    const b = ((acc << (8 - nb)) | ((1 << (8 - nb)) - 1)) & 255;
    out[p++] = b;
    if (b === 255) out[p++] = 0;
  }
  u16(EOI);
  return out.slice(0, p);
}

// ---------------------------------------------------------------------------------------
// Decoder

interface DecodeTable {
  maxLen: number;
  /** Indexed by the next maxLen bits: (code length << 8) | symbol; 0 = invalid code. */
  lookup: Uint16Array;
}

function buildDecodeTable(bits: Uint8Array, values: Uint8Array): DecodeTable {
  let maxLen = 16;
  while (maxLen > 0 && bits[maxLen - 1] === 0) maxLen--;
  if (maxLen === 0) throw new Error('Lossless JPEG: empty Huffman table');
  const lookup = new Uint16Array(1 << maxLen);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= maxLen; len++) {
    for (let i = 0; i < bits[len - 1]!; i++) {
      if (k >= values.length) throw new Error('Lossless JPEG: bad Huffman table');
      const fill = 1 << (maxLen - len);
      const start = code << (maxLen - len);
      if (start + fill > lookup.length) throw new Error('Lossless JPEG: bad Huffman table');
      lookup.fill((len << 8) | values[k++]!, start, start + fill);
      code++;
    }
    code <<= 1;
  }
  return { maxLen, lookup };
}

/** Decodes a lossless (SOF3) JPEG: Huffman tables, predictors 1..7, point transform, restart intervals at row boundaries. */
export function decodeLosslessJpeg(bytes: Uint8Array): LosslessJpegImage {
  const len = bytes.length;
  if (len < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Lossless JPEG: missing SOI');
  let p = 2;
  let width = 0;
  let height = 0;
  let precision = 0;
  let frameIds: number[] = [];
  const tables: (DecodeTable | undefined)[] = [];
  let restart = 0;
  for (;;) {
    while (p < len && bytes[p] !== 0xff) p++;
    while (p < len && bytes[p] === 0xff) p++;
    if (p >= len) throw new Error('Lossless JPEG: no SOS');
    const marker = 0xff00 | bytes[p++]!;
    if (marker === SOI || (marker >= 0xffd0 && marker <= 0xffd7)) continue;
    if (marker === EOI) throw new Error('Lossless JPEG: no SOS');
    const segLen = (bytes[p]! << 8) | bytes[p + 1]!;
    const seg = bytes.subarray(p + 2, p + segLen);
    if (seg.length !== segLen - 2) throw new Error('Lossless JPEG: truncated segment');
    p += segLen;
    if (marker === SOF3) {
      precision = seg[0]!;
      height = (seg[1]! << 8) | seg[2]!;
      width = (seg[3]! << 8) | seg[4]!;
      const nf = seg[5]!;
      frameIds = [];
      for (let c = 0; c < nf; c++) {
        frameIds.push(seg[6 + 3 * c]!);
        if (seg[7 + 3 * c] !== 0x11) throw new Error('Lossless JPEG: subsampled components are not supported');
      }
    } else if (marker >= 0xffc0 && marker <= 0xffcf && marker !== DHT && marker !== 0xffc8 && marker !== 0xffcc) {
      throw new Error(`Lossless JPEG: unsupported frame type ${marker.toString(16)}`);
    } else if (marker === DHT) {
      let q = 0;
      while (q < seg.length) {
        const id = seg[q]! & 15;
        const counts = seg.subarray(q + 1, q + 17);
        const total = counts.reduce((s, v) => s + v, 0);
        tables[id] = buildDecodeTable(counts, seg.subarray(q + 17, q + 17 + total));
        q += 17 + total;
      }
    } else if (marker === DRI) {
      restart = (seg[0]! << 8) | seg[1]!;
    } else if (marker === SOS) {
      if (!width || !height) throw new Error('Lossless JPEG: SOS before SOF3');
      const ns = seg[0]!;
      if (ns !== frameIds.length) throw new Error('Lossless JPEG: scans with a subset of the components are not supported');
      const compTables: DecodeTable[] = [];
      for (let c = 0; c < ns; c++) {
        const id = seg[1 + 2 * c]!;
        if (id !== frameIds[c]) throw new Error('Lossless JPEG: component order differs from the frame');
        const t = tables[seg[2 + 2 * c]! >> 4];
        if (!t) throw new Error('Lossless JPEG: missing Huffman table');
        compTables.push(t);
      }
      const psv = seg[1 + 2 * ns]!;
      const pt = seg[3 + 2 * ns]! & 15;
      return decodeScan(bytes, p, width, height, ns, precision, psv, pt, restart, compTables);
    }
  }
}

function decodeScan(
  bytes: Uint8Array,
  start: number,
  width: number,
  height: number,
  comps: number,
  precision: number,
  psv: number,
  pt: number,
  restart: number,
  tables: DecodeTable[],
): LosslessJpegImage {
  if (psv < 1 || psv > 7) throw new Error(`Lossless JPEG: predictor ${psv}`);
  if (restart && restart % width !== 0) throw new Error('Lossless JPEG: restart interval is not a whole number of rows');
  const rowsPerRestart = restart ? restart / width : 0;
  const rowLen = width * comps;
  const data = new Uint16Array(rowLen * height);
  const initial = 1 << (precision - pt - 1);
  const end = bytes.length;
  let pos = start;
  let acc = 0;
  let nb = 0;
  let atMarker = false;

  const fill = () => {
    while (nb <= 24) {
      let b = 0;
      if (!atMarker && pos < end) {
        b = bytes[pos]!;
        if (b === 0xff) {
          if (bytes[pos + 1] === 0) pos += 2;
          else {
            atMarker = true;
            b = 0;
          }
        } else pos++;
      }
      acc = (acc << 8) | b;
      nb += 8;
    }
  };
  const decodeDiff = (t: DecodeTable): number => {
    if (nb < 16) fill();
    const e = t.lookup[(acc >>> (nb - t.maxLen)) & ((1 << t.maxLen) - 1)]!;
    const l = e >> 8;
    if (l === 0) throw new Error('Lossless JPEG: invalid Huffman code');
    nb -= l;
    const s = e & 255;
    if (s === 0) return 0;
    if (s >= 16) return -32768;
    if (nb < s) fill();
    nb -= s;
    const v = (acc >>> nb) & ((1 << s) - 1);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  };

  let rowInInterval = 0;
  for (let y = 0, i = 0; y < height; y++) {
    if (rowsPerRestart && y > 0 && y % rowsPerRestart === 0) {
      // Skip to the RSTn marker and restart prediction as at the start of the scan.
      nb = 0;
      atMarker = false;
      while (pos < end && !(bytes[pos] === 0xff && bytes[pos + 1]! >= 0xd0 && bytes[pos + 1]! <= 0xd7)) pos++;
      pos += 2;
      rowInInterval = 0;
    }
    const firstRow = rowInInterval === 0;
    for (let x = 0, c = 0; x < rowLen; x++, i++) {
      const diff = decodeDiff(tables[c]!);
      let pred: number;
      if (x < comps) pred = firstRow ? initial : data[i - rowLen]! >> pt;
      else if (firstRow || psv === 1) pred = data[i - comps]! >> pt;
      else {
        const ra = data[i - comps]! >> pt;
        const rb = data[i - rowLen]! >> pt;
        const rc = data[i - rowLen - comps]! >> pt;
        pred = psv === 2 ? rb : psv === 3 ? rc : psv === 4 ? ra + rb - rc : psv === 5 ? ra + ((rb - rc) >> 1) : psv === 6 ? rb + ((ra - rc) >> 1) : (ra + rb) >> 1;
      }
      data[i] = ((pred + diff) & 0xffff) << pt;
      if (++c === comps) c = 0;
    }
    rowInInterval++;
  }
  return { width, height, components: comps, precision, data };
}
