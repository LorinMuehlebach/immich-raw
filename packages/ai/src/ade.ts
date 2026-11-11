// ADE20K classes (0-based, as the scene model outputs them) behind each Lightroom landscape
// category. ADE20K has no snow: compose.ts finds it by colour instead.
import type { SceneClass } from './types.ts';

export const ADE_CLASSES = 150;

export const ADE_GROUPS: Record<Exclude<SceneClass, 'snow'>, number[]> = {
  sky: [2],
  // water, sea, river, lake, waterfall, swimming pool, fountain
  water: [21, 26, 60, 128, 113, 109, 104],
  // tree, grass, plant, flower, palm, field
  vegetation: [4, 9, 17, 66, 72, 29],
  // mountain, hill
  mountains: [16, 68],
  // building, house, skyscraper, hovel, tower, bridge, fence, column, railing, awning,
  // canopy, tent, grandstand, windowpane, door, pier. Not "wall": indoors it is every room.
  architecture: [1, 25, 48, 79, 84, 61, 32, 42, 38, 86, 106, 114, 51, 8, 14, 140],
  // earth, sand, land, dirt track, rock
  naturalGround: [13, 46, 94, 91, 34],
  // road, sidewalk, floor, path, stairs, runway, stairway, step
  artificialGround: [6, 11, 3, 52, 53, 54, 59, 121],
  person: [12],
};
