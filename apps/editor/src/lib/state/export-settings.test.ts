import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_SETTINGS,
  colorChoices,
  exportFilename,
  fillTemplate,
  fillText,
  normalizeExportSettings,
  outputSize,
  formatShort,
  presetSummary,
  qualityShort,
  safeFileName,
  sizeShort,
  sizeSummary,
  validColor,
  withSizeMode,
  withSizeUnit,
  withSizeValue,
} from './export-settings.ts';

describe('normalizeExportSettings', () => {
  it('gives the defaults for nothing stored', () => {
    expect(normalizeExportSettings(null)).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings('junk')).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(DEFAULT_EXPORT_SETTINGS.immichPreset).toBe('medium');
  });

  it('keeps valid stored settings', () => {
    const stored = structuredClone(DEFAULT_EXPORT_SETTINGS);
    stored.presets.low = {
      format: 'webp',
      color: { space: 'display-p3', bits: 8 },
      size: { mode: 'width', value: 20, unit: 'cm' },
      ppi: 240,
      quality: { jpeg: 70, webp: 66, avif: 40, jxl: 91 },
      lossless: true,
      sharpen: { for: 'matte', amount: 'high' },
      watermark: { enabled: true, kind: 'image', text: 'Hi', position: 'top-left', size: 5.5, opacity: 40, color: 'black', imageId: 'logo-abc_1', imageSize: 22.5 },
      metadata: 'copyright',
      naming: '{album}-{seq}',
    };
    stored.immichPreset = 'high';
    stored.copyright = '© Me';
    stored.save = { front: 'raw', favorite: 'always' };
    expect(normalizeExportSettings(stored)).toEqual(stored);
  });

  it('gives the save defaults to settings stored before the save options', () => {
    const s = normalizeExportSettings({ immichPreset: 'low', copyright: 'x' });
    expect(s.save).toEqual({ front: 'edit', favorite: 'copy' });
    expect(normalizeExportSettings({ save: { front: 'camera', favorite: true } }).save).toEqual(DEFAULT_EXPORT_SETTINGS.save);
    expect(normalizeExportSettings({ save: { front: 'raw' } }).save).toEqual({ front: 'raw', favorite: 'copy' });
  });

  it('reads presets stored before the export options (longEdge only)', () => {
    const s = normalizeExportSettings({ presets: { low: { longEdge: 1600, quality: 70 }, medium: { longEdge: null, quality: 88 } }, immichPreset: 'low' });
    expect(s.presets.low.size).toEqual({ mode: 'longEdge', value: 1600, unit: 'px' });
    expect(s.presets.low.quality).toEqual({ ...DEFAULT_EXPORT_SETTINGS.presets.low.quality, jpeg: 70 });
    expect(s.presets.low.format).toBe('jpeg');
    expect(s.presets.low.lossless).toBe(false);
    expect(s.presets.medium.size.mode).toBe('full');
    expect(s.presets.high).toEqual(DEFAULT_EXPORT_SETTINGS.presets.high);
    expect(s.immichPreset).toBe('low');
  });

  it('clamps numbers and rejects unknown choices', () => {
    const s = normalizeExportSettings({
      presets: {
        low: {
          format: 'gif',
          size: { mode: 'diagonal', value: 5, unit: 'px' },
          ppi: 5000,
          quality: 5,
          sharpen: { for: 'canvas', amount: 'max' },
          watermark: { enabled: 'yes', position: 'middle', size: 99, opacity: -3, color: 'red' },
          metadata: 'none',
          naming: '   ',
        },
        medium: { size: { mode: 'megapixels', value: 1000, unit: 'px' } },
      },
      immichPreset: 'huge',
    });
    const low = s.presets.low;
    const def = DEFAULT_EXPORT_SETTINGS.presets.low;
    expect(low.format).toBe('jpeg');
    expect(low.size).toEqual({ mode: 'longEdge', value: 2048, unit: 'px' });
    expect(low.ppi).toBe(1200);
    expect(low.quality).toEqual({ ...def.quality, jpeg: 50 });
    expect(low.sharpen).toEqual(def.sharpen);
    expect(low.watermark).toEqual({ ...def.watermark, size: 20, opacity: 5 });
    expect(low.metadata).toBe(def.metadata);
    expect(low.naming).toBe(def.naming);
    expect(s.presets.medium.size).toEqual({ mode: 'megapixels', value: 12, unit: 'px' });
    expect(s.immichPreset).toBe('medium');
  });

  it('reads text watermarks stored before logos, and checks the logo fields', () => {
    const old = normalizeExportSettings({ presets: { low: { watermark: { enabled: true, text: 'Me', position: 'top', size: 4, opacity: 50, color: 'white' } } } });
    expect(old.presets.low.watermark).toMatchObject({ enabled: true, kind: 'text', text: 'Me', imageId: null, imageSize: 15 });
    const bad = normalizeExportSettings({ presets: { low: { watermark: { kind: 'video', imageId: '../../etc', imageSize: 99 } } } });
    expect(bad.presets.low.watermark).toMatchObject({ kind: 'text', imageId: null, imageSize: 50 });
    expect(normalizeExportSettings({ presets: { low: { watermark: { imageSize: 0.1 } } } }).presets.low.watermark.imageSize).toBe(2);
  });

  it('keeps a quality for each lossy format, in its own range', () => {
    const s = normalizeExportSettings({ presets: { high: { format: 'avif', quality: { jpeg: 120, webp: 'x', avif: 10, jxl: 77.6 }, lossless: 'yes' } } });
    const high = s.presets.high;
    expect(high.format).toBe('avif');
    expect(high.quality).toEqual({ jpeg: 100, webp: DEFAULT_EXPORT_SETTINGS.presets.high.quality.webp, avif: 30, jxl: 78 });
    expect(high.lossless).toBe(false);
    for (const format of ['webp', 'jxl'] as const) expect(normalizeExportSettings({ presets: { low: { format } } }).presets.low.format).toBe(format);
  });

  it('keeps only the colour settings the file type can hold', () => {
    const color = (format: string, space: string, bits: number) => normalizeExportSettings({ presets: { high: { format, color: { space, bits } } } }).presets.high.color;
    expect(color('tiff', 'prophoto', 16)).toEqual({ space: 'prophoto', bits: 16 });
    expect(color('png', 'adobe-rgb', 8)).toEqual({ space: 'adobe-rgb', bits: 8 });
    // ProPhoto needs 16 bits: PNG and TIFF switch to them, JPEG falls back to sRGB.
    expect(color('png', 'prophoto', 8)).toEqual({ space: 'prophoto', bits: 16 });
    expect(color('jpeg', 'prophoto', 16)).toEqual({ space: 'srgb', bits: 8 });
    expect(color('jpeg', 'display-p3', 16)).toEqual({ space: 'display-p3', bits: 8 });
    expect(color('avif', 'adobe-rgb', 8)).toEqual({ space: 'srgb', bits: 8 });
    expect(color('avif', 'display-p3', 8)).toEqual({ space: 'display-p3', bits: 8 });
    expect(color('jxl', 'display-p3', 8)).toEqual({ space: 'srgb', bits: 8 });
    expect(color('tiff', 'rec2020', 12)).toEqual({ space: 'srgb', bits: 8 });
    expect(normalizeExportSettings({ presets: { low: {} } }).presets.low.color).toEqual({ space: 'srgb', bits: 8 });
  });

  it('lists the colour choices of each file type', () => {
    expect(colorChoices('tiff')).toEqual({ spaces: ['srgb', 'display-p3', 'adobe-rgb', 'prophoto'], bits: [8, 16] });
    expect(colorChoices('webp').bits).toEqual([8]);
    expect(validColor('webp', { space: 'adobe-rgb', bits: 16 })).toEqual({ space: 'adobe-rgb', bits: 8 });
  });

  it('does not share objects with the defaults', () => {
    const s = normalizeExportSettings(null);
    s.presets.low.size.value = 100;
    s.presets.low.watermark.text = 'x';
    expect(DEFAULT_EXPORT_SETTINGS.presets.low.size.value).toBe(2048);
    expect(DEFAULT_EXPORT_SETTINGS.presets.low.watermark.text).toBe('© {year} {owner}');
  });
});

describe('outputSize', () => {
  const px = (mode: 'longEdge' | 'shortEdge' | 'width' | 'height', value: number) => ({ mode, value, unit: 'px' as const });

  it('sets the chosen side', () => {
    expect(outputSize(6000, 4000, px('longEdge', 3000), 72)).toEqual({ width: 3000, height: 2000 });
    expect(outputSize(6000, 4000, px('shortEdge', 1000), 72)).toEqual({ width: 1500, height: 1000 });
    expect(outputSize(4000, 6000, px('width', 2000), 72)).toEqual({ width: 2000, height: 3000 });
    expect(outputSize(6000, 4000, px('height', 1000), 72)).toEqual({ width: 1500, height: 1000 });
  });

  it('converts inches and centimetres with the resolution', () => {
    expect(outputSize(6000, 4000, { mode: 'longEdge', value: 10, unit: 'in' }, 300)).toEqual({ width: 3000, height: 2000 });
    expect(outputSize(6000, 4000, { mode: 'longEdge', value: 25.4, unit: 'cm' }, 200)).toEqual({ width: 2000, height: 1333 });
  });

  it('fits a pixel count', () => {
    const s = outputSize(6000, 4000, { mode: 'megapixels', value: 6, unit: 'px' }, 72);
    expect(s).toEqual({ width: 3000, height: 2000 });
  });

  it('never upscales and keeps full size', () => {
    expect(outputSize(1600, 1200, px('longEdge', 3840), 72)).toEqual({ width: 1600, height: 1200 });
    expect(outputSize(1600, 1200, { mode: 'full', value: 1, unit: 'px' }, 72)).toEqual({ width: 1600, height: 1200 });
  });
});

describe('size editing', () => {
  it('converts units keeping the pixel size', () => {
    const px = { mode: 'longEdge' as const, value: 3000, unit: 'px' as const };
    expect(withSizeUnit(px, 'in', 300)).toEqual({ mode: 'longEdge', value: 10, unit: 'in' });
    expect(withSizeUnit(px, 'cm', 300)).toEqual({ mode: 'longEdge', value: 25.4, unit: 'cm' });
    expect(withSizeUnit({ mode: 'width', value: 10, unit: 'in' }, 'px', 240)).toEqual({ mode: 'width', value: 2400, unit: 'px' });
  });

  it('clamps typed values and picks values when switching mode', () => {
    expect(withSizeValue({ mode: 'longEdge', value: 2048, unit: 'px' }, 99999).value).toBe(20000);
    expect(withSizeValue({ mode: 'megapixels', value: 12, unit: 'px' }, 0).value).toBe(0.1);
    expect(withSizeMode({ mode: 'longEdge', value: 3000, unit: 'px' }, 'width')).toEqual({ mode: 'width', value: 3000, unit: 'px' });
    expect(withSizeMode({ mode: 'longEdge', value: 3000, unit: 'px' }, 'megapixels')).toEqual({ mode: 'megapixels', value: 12, unit: 'px' });
    expect(withSizeMode({ mode: 'megapixels', value: 12, unit: 'cm' }, 'longEdge')).toEqual({ mode: 'longEdge', value: 25, unit: 'cm' });
    expect(withSizeMode({ mode: 'full', value: 30, unit: 'cm' }, 'longEdge')).toEqual({ mode: 'longEdge', value: 30, unit: 'cm' });
  });
});

describe('file names', () => {
  const values = { originalFileName: 'DSC_0001.NEF', preset: 'medium' as const, date: new Date(2024, 4, 3, 10, 0), seq: 7, album: 'Trip: Rome', owner: 'Ana' };

  it('fills the template', () => {
    expect(fillTemplate('{name}', values)).toBe('DSC_0001');
    expect(fillTemplate('{name}-{preset}', values)).toBe('DSC_0001-medium');
    expect(fillTemplate('{date}_{name}', values)).toBe('2024-05-03_DSC_0001');
    expect(fillTemplate('{album}-{seq}', values)).toBe('Trip: Rome-007');
    expect(fillTemplate('{seq}', { ...values, seq: 12, seqDigits: 4 })).toBe('0012');
    expect(fillTemplate('{unknown}-{name}', values)).toBe('{unknown}-DSC_0001');
  });

  it('makes a safe name with the format extension', () => {
    expect(exportFilename({ naming: '{album}-{seq}', format: 'jpeg' }, values)).toBe('Trip_ Rome-007.jpg');
    expect(exportFilename({ naming: '{name}', format: 'tiff' }, values)).toBe('DSC_0001.tif');
    expect(exportFilename({ naming: '{name}', format: 'png' }, { originalFileName: 'trip.2024.cr3' })).toBe('trip.2024.png');
    expect(exportFilename({ naming: '{album}', format: 'jpeg' }, {})).toBe('photo.jpg');
    expect(['webp', 'avif', 'jxl'].map((format) => exportFilename({ naming: '{name}', format: format as 'webp' }, values))).toEqual(['DSC_0001.webp', 'DSC_0001.avif', 'DSC_0001.jxl']);
    expect(safeFileName(' a/b\\c?.. ')).toBe('a_b_c_');
  });

  it('fills copyright text', () => {
    expect(fillText('© {year} {owner}', { owner: 'Ana', date: new Date(2021, 0, 1) })).toBe('© 2021 Ana');
    expect(fillText('© {year} {owner}', { owner: '', year: 2020 })).toBe('© 2020');
  });
});

describe('summaries', () => {
  it('describes presets', () => {
    const d = DEFAULT_EXPORT_SETTINGS.presets;
    expect(sizeShort(d.low)).toBe('2048 px');
    expect(sizeShort(d.high)).toBe('Full size');
    expect(sizeSummary({ size: { mode: 'width', value: 20, unit: 'cm' }, ppi: 300 })).toBe('Width 20 cm at 300 ppi');
    expect(presetSummary(d.low)).toBe('JPEG · Long edge 2048 px · quality 80 · sharpened for screen');
    expect(presetSummary({ ...d.high, format: 'tiff', watermark: { ...d.high.watermark, enabled: true } })).toBe('TIFF · Full size · watermark');
    expect(presetSummary({ ...d.medium, format: 'avif' })).toBe('AVIF · Long edge 3840 px · quality 63');
    expect(presetSummary({ ...d.medium, format: 'jxl', lossless: true })).toBe('JPEG XL · Long edge 3840 px · lossless');
    expect(presetSummary({ ...d.high, watermark: { ...d.high.watermark, enabled: true, kind: 'image' } })).toBe('JPEG · Full size · quality 95 · logo watermark');
    expect(presetSummary({ ...d.high, format: 'tiff', color: { space: 'prophoto', bits: 16 } })).toBe('TIFF · Full size · 16-bit · ProPhoto RGB');
    expect(formatShort({ ...d.high, format: 'png', color: { space: 'srgb', bits: 16 } })).toBe('PNG 16-bit');
  });

  it('gives each preset button its format line', () => {
    const d = DEFAULT_EXPORT_SETTINGS.presets;
    expect(formatShort(d.medium)).toBe('quality 90');
    expect(formatShort({ ...d.medium, format: 'webp' })).toBe('WebP 85');
    expect(formatShort({ ...d.medium, format: 'webp', lossless: true })).toBe('WebP lossless');
    // AVIF has no lossless choice here: the flag set for another format doesn't apply.
    expect(formatShort({ ...d.medium, format: 'avif', lossless: true })).toBe('AVIF 63');
    expect(formatShort({ ...d.medium, format: 'png' })).toBe('PNG');
    expect(qualityShort({ ...d.medium, format: 'tiff' })).toBe('');
  });
});
