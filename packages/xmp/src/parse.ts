// Reads Camera Raw (crs:) settings out of an XMP packet: Lightroom presets and sidecars.
import { elements, parseXml, resolveName, textOf, type XmlElement } from './xml.ts';

export const CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
export const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const TIFF_NS = 'http://ns.adobe.com/tiff/1.0/';
/** Our own namespace, for settings Lightroom has no field for (e.g. the profile id). */
export const IRE_NS = 'https://github.com/LorinMuehlebach/immich-raw/xmp/1.0/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** A nested XMP value: text, a list (rdf:Seq / rdf:Bag) or a struct whose fields are keyed by local name. */
export type XmpValue = string | XmpValue[] | XmpStruct;
export interface XmpStruct {
  [field: string]: XmpValue;
}

export interface CrsSettings {
  /**
   * Simple crs: values by local name ("Exposure2012" -> "+0.50"). Fields of structs are
   * flattened with dots ("Look.Name"); language alternatives give the x-default text.
   */
  values: Record<string, string>;
  /** rdf:Seq / rdf:Bag values ("ToneCurvePV2012" -> ["0, 0", "255, 255"]). */
  lists: Record<string, string[]>;
  /**
   * The same lists kept whole when their items are structs, e.g. the local corrections
   * ("MaskGroupBasedCorrections" -> one struct per mask, with its nested mask lists).
   */
  structs: Record<string, XmpValue[]>;
  /** Preset name (crs:Name), if any. */
  name: string | null;
  /** tiff:Orientation (EXIF orientation 1..8) if the packet has one. */
  orientation: number | null;
  /** Values in our own namespace (IRE_NS) by local name. */
  extra: Record<string, string>;
}

const isRdf = (el: XmlElement, local: string) => {
  const q = resolveName(el, el.name);
  return q.uri === RDF_NS && q.local === local;
};

/** Top-level rdf:Description elements (XMP may split properties across several). */
function topDescriptions(root: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (el: XmlElement, inDescription: boolean) => {
    for (const child of elements(el)) {
      if (isRdf(child, 'Description')) {
        if (!inDescription) out.push(child);
        walk(child, true);
      } else {
        walk(child, inDescription);
      }
    }
  };
  walk(root, false);
  return out;
}

/** Returns null when the packet has no crs: settings at all. */
export function parseXmp(text: string): CrsSettings | null {
  const root = parseXml(text);
  const s: CrsSettings = { values: {}, lists: {}, structs: {}, name: null, orientation: null, extra: {} };

  const readProperty = (el: XmlElement, key: string, target: 'crs' | 'extra') => {
    const kids = elements(el);
    const container = kids.find((k) => isRdf(k, 'Seq') || isRdf(k, 'Bag') || isRdf(k, 'Alt') || isRdf(k, 'Description'));
    if (container && (isRdf(container, 'Seq') || isRdf(container, 'Bag'))) {
      const items = elements(container).filter((k) => isRdf(k, 'li'));
      if (target === 'crs') {
        s.lists[key] = items.map((li) => textOf(li).trim());
        const values = items.map(readNode);
        if (values.some((v) => typeof v !== 'string')) s.structs[key] = values;
      }
      return;
    }
    if (container && isRdf(container, 'Alt')) {
      const items = elements(container).filter((k) => isRdf(k, 'li'));
      const def = items.find((li) => li.attrs['xml:lang'] === 'x-default') ?? items[0];
      const value = def ? textOf(def).trim() : '';
      if (target === 'crs') {
        s.values[key] = value;
        if (key === 'Name') s.name = value || null;
      } else s.extra[key] = value;
      return;
    }
    const isStruct = (container && isRdf(container, 'Description')) || Object.entries(el.attrs).some(([k, v]) => {
      const q = resolveName(el, k, true);
      return (q.uri === RDF_NS && q.local === 'parseType' && v === 'Resource') || q.uri === CRS_NS;
    });
    if (isStruct && target === 'crs') {
      readStruct(container && isRdf(container, 'Description') ? container : el, key);
      return;
    }
    const value = textOf(el).trim();
    if (target === 'crs') {
      s.values[key] = value;
      if (key === 'Name') s.name = value || null;
    } else s.extra[key] = value;
  };

  const readStruct = (el: XmlElement, prefix: string) => {
    for (const [k, v] of Object.entries(el.attrs)) {
      const q = resolveName(el, k, true);
      if (q.uri === CRS_NS) s.values[`${prefix}.${q.local}`] = v;
    }
    for (const child of elements(el)) {
      const q = resolveName(child, child.name);
      if (q.uri === CRS_NS) readProperty(child, `${prefix}.${q.local}`, 'crs');
    }
  };

  for (const desc of topDescriptions(root)) {
    for (const [k, v] of Object.entries(desc.attrs)) {
      const q = resolveName(desc, k, true);
      if (q.uri === CRS_NS) s.values[q.local] = v;
      else if (q.uri === IRE_NS) s.extra[q.local] = v;
      else if (q.uri === TIFF_NS && q.local === 'Orientation') s.orientation = parseOrientation(v);
    }
    for (const child of elements(desc)) {
      const q = resolveName(child, child.name);
      if (q.uri === CRS_NS) readProperty(child, q.local, 'crs');
      else if (q.uri === IRE_NS) readProperty(child, q.local, 'extra');
      else if (q.uri === TIFF_NS && q.local === 'Orientation') s.orientation = parseOrientation(textOf(child));
    }
  }

  const hasCrs = Object.keys(s.values).length > 0 || Object.keys(s.lists).length > 0;
  return hasCrs ? s : null;
}

/** Field namespaces of a struct: anything but RDF and XML's own (xml:lang). */
const isFieldNs = (uri: string) => uri !== '' && uri !== RDF_NS && uri !== XML_NS;

/**
 * Reads a property or list item as a nested value. Adobe writes struct fields both as
 * attributes and as child elements, and a struct either inline (rdf:parseType="Resource",
 * or fields on the element itself) or wrapped in an rdf:Description; all forms read alike.
 */
export function readNode(el: XmlElement): XmpValue {
  const kids = elements(el);
  const container = kids.find((k) => isRdf(k, 'Seq') || isRdf(k, 'Bag') || isRdf(k, 'Alt'));
  if (container) {
    const items = elements(container).filter((k) => isRdf(k, 'li'));
    if (!isRdf(container, 'Alt')) return items.map(readNode);
    const def = items.find((li) => li.attrs['xml:lang'] === 'x-default') ?? items[0];
    return def ? textOf(def).trim() : '';
  }
  const desc = kids.find((k) => isRdf(k, 'Description'));
  const fields: XmpStruct = {};
  let isStruct = desc !== undefined;
  for (const src of desc ? [el, desc] : [el]) {
    for (const [k, v] of Object.entries(src.attrs)) {
      const q = resolveName(src, k, true);
      if (q.uri === RDF_NS && q.local === 'parseType' && v === 'Resource') isStruct = true;
      else if (isFieldNs(q.uri)) {
        fields[q.local] = v;
        isStruct = true;
      }
    }
    for (const child of elements(src)) {
      const q = resolveName(child, child.name);
      if (!isFieldNs(q.uri)) continue;
      fields[q.local] = readNode(child);
      isStruct = true;
    }
  }
  return isStruct ? fields : textOf(el).trim();
}

function parseOrientation(v: string): number | null {
  const n = parseInt(v.trim(), 10);
  return n >= 1 && n <= 8 ? n : null;
}
