// The open photo's AI masks: computes the map of every AI component in the background, hands
// finished maps to the renderer, and tells the Masking panel how each one is doing. Maps are
// kept by what they select, so undo, redo and switching masks don't recompute anything.
import { specKey, type AiSpec, type PersonInfo, type Progress } from '@immich-raw/ai';
import type { AiMaskMap, Renderer } from '@immich-raw/pipeline';
import { AI_TARGET_LABELS, aiComponents, type AiComponent, type Recipe } from '@immich-raw/recipe';
import { aiClient, aiConsent, componentSpec, preparePhoto, rasterOut, type AiPhoto } from '../ai.svelte.ts';

export type AiState = 'working' | 'ready' | 'empty' | 'failed';

export interface AiStatus {
  state: AiState;
  message?: string;
}

interface Raster extends AiMaskMap {
  empty: boolean;
}

/** Maps kept per photo (by what they select). */
const KEEP = 32;

const NOT_FOUND: Partial<Record<AiComponent['target'], string>> = {
  subject: 'No subject found.',
  background: 'No background found.',
  sky: 'No sky found.',
  people: 'No people found.',
  landscape: 'Nothing of this kind found.',
  object: 'No object found there.',
};

export class AiMasks {
  /** Per component id. */
  status = $state<Record<string, AiStatus>>({});
  /** What the worker is doing (downloading a model, finding the sky…); null when idle. */
  progress = $state<Progress | null>(null);
  /** People found in the photo (for the People picker); null until asked for. */
  people = $state<PersonInfo[] | null>(null);
  peopleError = $state<string | null>(null);

  private photo: AiPhoto | null = null;
  private rasters = new Map<string, Raster>();
  private jobs = new Map<string, Promise<void>>();
  private failed = new Map<string, string>();
  /** What the renderer was last given (component id and map version). */
  private bound = '';
  private seq = 0;

  constructor(private host: { renderer(): Renderer | null; photoKey(): string | null; requestRender(): void }) {
    aiClient.onProgress = (p) => (this.progress = p);
  }

  /** A new photo was opened. */
  reset(): void {
    this.photo = null;
    this.rasters.clear();
    this.failed.clear();
    this.bound = '';
    this.status = {};
    this.people = null;
    this.peopleError = null;
  }

  /** The analysis image of the open photo (rendered on first use). */
  current(): AiPhoto | null {
    const r = this.host.renderer();
    const key = this.host.photoKey();
    if (!r || !key) return null;
    if (!this.photo || !this.photo.key.startsWith(`${key}:`)) {
      this.photo = preparePhoto(r, key);
      this.rasters.clear();
      this.failed.clear();
    }
    if (!aiClient.hasPhoto(this.photo.key)) aiClient.setPhoto(this.photo.key, this.photo.image);
    return this.photo;
  }

  /** Called before every render: binds the ready maps and starts the missing ones. */
  sync(recipe: Recipe): void {
    const r = this.host.renderer();
    if (!r) return;
    const comps = aiComponents(recipe.masks);
    if (!comps.length) {
      if (this.bound) r.setAiMasks(new Map());
      this.bound = '';
      if (Object.keys(this.status).length) this.status = {};
      return;
    }
    const photo = this.current();
    if (!photo) return;
    const maps = new Map<string, AiMaskMap>();
    const status: Record<string, AiStatus> = {};
    for (const c of comps) {
      const spec = componentSpec(c, photo, r, recipe);
      const key = specKey(spec);
      const raster = this.rasters.get(key);
      if (raster) {
        // Touch: most recently used last.
        this.rasters.delete(key);
        this.rasters.set(key, raster);
        maps.set(c.id, raster);
        status[c.id] = raster.empty ? { state: 'empty', message: NOT_FOUND[c.target] } : { state: 'ready' };
        continue;
      }
      const error = this.failed.get(key);
      if (error) {
        status[c.id] = { state: 'failed', message: error };
        continue;
      }
      status[c.id] = { state: 'working' };
      this.start(key, spec, photo, r);
    }
    const bound = [...maps].map(([id, m]) => `${id}:${m.version}`).join('|');
    if (bound !== this.bound) {
      r.setAiMasks(maps);
      this.bound = bound;
    }
    if (JSON.stringify(status) !== JSON.stringify($state.snapshot(this.status))) this.status = status;
  }

  private start(key: string, spec: AiSpec, photo: AiPhoto, renderer: Renderer): void {
    if (this.jobs.has(key)) return;
    const job = (async () => {
      await aiConsent.permit(spec);
      const res = await aiClient.raster(photo.key, spec, rasterOut(photo));
      if (this.photo !== photo || this.host.renderer() !== renderer) return;
      this.rasters.set(key, { width: res.width, height: res.height, data: res.data, version: `${++this.seq}`, empty: res.empty });
      while (this.rasters.size > KEEP) this.rasters.delete(this.rasters.keys().next().value!);
    })()
      .catch((e: unknown) => {
        if (this.photo === photo) this.failed.set(key, e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        this.jobs.delete(key);
        if (!this.jobs.size) this.progress = null;
        this.host.requestRender();
      });
    this.jobs.set(key, job);
  }

  /** Tries the failed maps again (and asks again about downloads). */
  retry(): void {
    aiConsent.again();
    this.failed.clear();
    this.host.requestRender();
  }

  /** Waits until every AI map of `recipe` is ready (before saving or exporting). */
  async ready(recipe: Recipe): Promise<void> {
    for (;;) {
      this.sync(recipe);
      const comps = aiComponents(recipe.masks);
      const bad = comps.find((c) => this.status[c.id]?.state === 'failed');
      if (bad) throw new Error(`${AI_TARGET_LABELS[bad.target]} mask: ${this.status[bad.id]!.message}`);
      if (!this.jobs.size) return;
      await Promise.allSettled([...this.jobs.values()]);
    }
  }

  /** Finds the people in the photo, for the People picker. */
  async findPeople(): Promise<void> {
    if (this.people) return;
    this.peopleError = null;
    try {
      const photo = this.current();
      if (!photo) return;
      await aiConsent.permit({ target: 'people' });
      const people = await aiClient.people(photo.key);
      if (this.photo === photo) this.people = people;
    } catch (e) {
      this.peopleError = e instanceof Error ? e.message : String(e);
    } finally {
      if (!this.jobs.size) this.progress = null;
    }
  }
}
