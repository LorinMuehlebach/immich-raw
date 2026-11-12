import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_SETTINGS,
  exportFilename,
  fillTemplate,
  fillText,
  normalizeExportSettings,
  outputSize,
  presetSummary,
  safeFileName,
  sizeShort,
  sizeSummary,
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
      format: 'png',
      size: { mode: 'width', value: 20, unit: 'cm' },
      ppi: 240,
      quality: 70,
      sharpen: { for: 'matte', amount: 'high' },
      watermark: { enabled: true, text: 'Hi', position: 'top-left', size: 5.5, opacity: 40, color: 'black' },
      metadata: 'copyright',
      naming: '{album}-{seq}',
    };
    stored.immichPreset = 'high';
    stored.copyright = '© Me';
    expect(normalizeExportSettings(stored)).toEqual(stored);
  });

  it('reads presets stored before the export options (longEdge only)', () => {
    const s = normalizeExportSettings({ presets: { low: { longEdge: 1600, quality: 70 }, medium: { longEdge: null, quality: 88 } }, immichPreset: 'low' });
    expect(s.presets.low.size).toEqual({ mode: 'longEdge', value: 1600, unit: 'px' });
    expect(s.presets.low.quality).toBe(70);
    expect(s.presets.low.format).toBe('jpeg');
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
    expect(low.quality).toBe(50);
    expect(low.sharpen).toEqual(def.sharpen);
    expect(low.watermark).toEqual({ ...def.watermark, size: 20, opacity: 5 });
    expect(low.metadata).toBe(def.metadata);
    expect(low.naming).toBe(def.naming);
    expect(s.presets.medium.size).toEqual({ mode: 'megapixels', value: 12, unit: 'px' });
    expect(s.immichPreset).toBe('medium');
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
  });
});
