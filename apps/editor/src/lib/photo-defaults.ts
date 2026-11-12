// A photo's starting settings: the defaults, except that a Fujifilm RAW starts with the film
// simulation chosen in the camera (once the Fujifilm film looks are in this browser).
import type { FujiFilmSim, FujiFilter, FujiSim } from '@immich-raw/decoder';
import { defaultRecipe, profileInfo, type Band, type FujiProfileId, type Recipe } from '@immich-raw/recipe';

type ColorSim = Exclude<FujiSim, 'monochrome' | 'acros' | 'sepia'>;

const SIM_PROFILES: Record<ColorSim, FujiProfileId> = {
  provia: 'fuji-provia',
  velvia: 'fuji-velvia',
  astia: 'fuji-astia',
  'classic-chrome': 'fuji-classic-chrome',
  'pro-neg-std': 'fuji-pro-neg-std',
  'pro-neg-hi': 'fuji-pro-neg-hi',
  eterna: 'fuji-eterna',
  'bleach-bypass': 'fuji-bleach-bypass',
  'classic-neg': 'fuji-classic-neg',
  'nostalgic-neg': 'fuji-nostalgic-neg',
  'reala-ace': 'fuji-reala-ace',
};

const MONO_LABELS: Record<'monochrome' | 'acros' | 'sepia', string> = { monochrome: 'Monochrome', acros: 'Acros', sepia: 'Sepia' };
const FILTER_LABELS: Record<FujiFilter, string> = { red: 'R', yellow: 'Ye', green: 'G' };

/** B&W mix that stands in for the camera's colour filter (Acros+R, Monochrome+Ye, ...). */
export const FUJI_BW_FILTERS: Record<FujiFilter, Partial<Record<Band, number>>> = {
  red: { red: 30, orange: 20, yellow: 10, green: -15, aqua: -25, blue: -40 },
  yellow: { orange: 15, yellow: 20, aqua: -10, blue: -25, purple: -10 },
  green: { red: -20, orange: -5, yellow: 15, green: 30, magenta: -15 },
};

export const isFujifilm = (make: string): boolean => /fuji/i.test(make);

/** Name of the in-camera simulation as Fujifilm writes it, e.g. "Classic Chrome", "Acros+R". */
export function fujiSimLabel(sim: Pick<FujiFilmSim, 'sim' | 'filter'>): string {
  if (sim.sim === 'monochrome' || sim.sim === 'acros' || sim.sim === 'sepia') {
    return MONO_LABELS[sim.sim] + (sim.filter ? `+${FILTER_LABELS[sim.filter]}` : '');
  }
  return profileInfo(SIM_PROFILES[sim.sim]).label;
}

export interface PhotoDefaults {
  /** The photo's starting settings. */
  recipe: Recipe;
  /** The Fujifilm film look the photo starts with once the looks are downloaded (not yet in `recipe`). */
  wanted: FujiProfileId | null;
  /** The in-camera film simulation, for messages ("Shot with Classic Chrome"). */
  simLabel: string | null;
}

export function photoDefaults(i: { make: string; sim: Pick<FujiFilmSim, 'sim' | 'filter'> | null; looksReady: boolean }): PhotoDefaults {
  const recipe = defaultRecipe();
  if (!isFujifilm(i.make)) return { recipe, wanted: null, simLabel: null };
  // No simulation in the file (e.g. a DNG without the maker note): Provia is Fujifilm's standard.
  const sim = i.sim ?? { sim: 'provia', filter: null };
  const simLabel = i.sim ? fujiSimLabel(i.sim) : null;
  if (sim.sim === 'monochrome' || sim.sim === 'acros' || sim.sim === 'sepia') {
    recipe.profile = 'monochrome';
    for (const [band, v] of Object.entries(sim.filter ? FUJI_BW_FILTERS[sim.filter] : {})) recipe.bwMix[band as Band] = v;
    return { recipe, wanted: null, simLabel };
  }
  const id = SIM_PROFILES[sim.sim];
  if (i.looksReady) {
    recipe.profile = id;
    return { recipe, wanted: null, simLabel };
  }
  return { recipe, wanted: id, simLabel };
}
