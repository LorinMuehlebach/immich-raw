// Lightroom-style history: a list of named steps (e.g. "Exposure +0.50"); undo/redo move
// through it, clicking a step jumps there. A slider drag is one step: the recipe changes
// live, and commit() records the step once the user lets go.
import { canonicalJson, type Recipe } from '@immich-raw/recipe';

/** The recipe fields the user edits (everything except bookkeeping like render/pending). */
export const EDITABLE_KEYS = ['profile', 'wb', 'basic', 'toneCurve', 'colorMixer', 'bwMix', 'colorGrading', 'detail', 'lens', 'transform', 'effects', 'calibration', 'crop', 'masks'] as const;

export type Editable = Pick<Recipe, (typeof EDITABLE_KEYS)[number]>;

export const editable = (r: Recipe): Editable => Object.fromEntries(EDITABLE_KEYS.map((k) => [k, r[k]])) as unknown as Editable;

export const editableJson = (r: Recipe): string => canonicalJson(editable(r));

export interface HistoryStep {
  label: string;
  at: string;
}

interface Step extends HistoryStep {
  state: string;
}

export class History {
  private steps: Step[] = [];
  private index = 0;
  private readonly limit = 200;

  /** Starts a fresh history with the given state as the first step. */
  reset(current: Recipe, label = 'Open'): void {
    this.steps = [{ label, at: new Date().toISOString(), state: editableJson(current) }];
    this.index = 0;
  }

  /** Records the current state as a new step, if it differs from the current step. */
  commit(current: Recipe, label: string): boolean {
    if (this.steps.length === 0) this.reset(current);
    const state = editableJson(current);
    if (state === this.steps[this.index]!.state) return false;
    this.steps = this.steps.slice(0, this.index + 1);
    this.steps.push({ label, at: new Date().toISOString(), state });
    if (this.steps.length > this.limit) this.steps.splice(1, this.steps.length - this.limit);
    this.index = this.steps.length - 1;
    return true;
  }

  /**
   * Replaces the latest step instead of adding one (re-tuning the step just made, e.g. Auto
   * with new settings). Falls back to commit() when the latest step isn't the current one.
   */
  amend(current: Recipe, label: string): void {
    if (this.index === 0 || this.index !== this.steps.length - 1) {
      this.commit(current, label);
      return;
    }
    this.steps[this.index] = { label, at: new Date().toISOString(), state: editableJson(current) };
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.steps.length - 1;
  }

  /** Editable fields to apply, or null. Uncommitted live changes are committed first. */
  undo(current: Recipe, pendingLabel = 'Edit'): Editable | null {
    this.commit(current, pendingLabel);
    if (!this.canUndo) return null;
    this.index--;
    return JSON.parse(this.steps[this.index]!.state) as Editable;
  }

  redo(): Editable | null {
    if (!this.canRedo) return null;
    this.index++;
    return JSON.parse(this.steps[this.index]!.state) as Editable;
  }

  jump(i: number): Editable | null {
    if (i < 0 || i >= this.steps.length) return null;
    this.index = i;
    return JSON.parse(this.steps[i]!.state) as Editable;
  }

  list(): { steps: HistoryStep[]; index: number } {
    return { steps: this.steps.map(({ label, at }) => ({ label, at })), index: this.index };
  }
}
