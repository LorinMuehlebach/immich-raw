<script lang="ts">
  // What a culler run takes into account: the checkboxes of the Auto-stack panel and page. A
  // choice whose model the service doesn't have is shown off and greyed out.
  import type { CullerStatus, CullOptions } from '../immich/culler.ts';

  interface Props {
    options: CullOptions;
    status: CullerStatus | null;
    disabled?: boolean;
    onChange: (options: CullOptions) => void;
  }

  let { options, status, disabled = false, onChange }: Props = $props();

  const CHOICES: { key: keyof CullOptions; label: string; title: string }[] = [
    { key: 'peopleFirst', label: "People's exposure counts most", title: 'Judge the exposure on the faces, or else on the people, before the rest of the photo' },
    { key: 'people', label: 'Find people without a visible face', title: 'Also people seen from the side, from behind or far away' },
    { key: 'smiles', label: 'Prefer the most smiles', title: 'Among the good shots, the one with the most smiling faces is the best' },
    { key: 'eyes', label: 'Set aside closed eyes', title: 'Shots with more closed eyes than the best one, or clearly less open eyes (a half-blink), are rejected' },
    { key: 'brackets', label: 'Keep exposure brackets together', title: 'Shots seconds apart whose exposure steps (for example −2, 0, +2 EV) get a stack of their own, none of them set aside' },
    { key: 'moments', label: 'One stack per moment', title: 'A new pose after a pause gets a stack of its own instead of joining the scene; a re-take of the same pose stays' },
  ];
  const unavailable = (key: keyof CullOptions) =>
    (key === 'people' && status?.people === false) || ((key === 'eyes' || key === 'smiles') && status?.eyes === false);
</script>

<fieldset class="choices" {disabled}>
  {#each CHOICES as c (c.key)}
    <label title={c.title} class:off={unavailable(c.key)}>
      <input
        type="checkbox"
        checked={options[c.key] && !unavailable(c.key)}
        disabled={unavailable(c.key)}
        onchange={(e) => onChange({ ...options, [c.key]: e.currentTarget.checked })}
      />
      {c.label}
    </label>
  {/each}
</fieldset>

<style>
  .choices {
    border: none;
    margin: 6px 0;
    padding: 0;
    display: grid;
    gap: 3px;
  }
  .choices label {
    display: flex;
    gap: 6px;
    align-items: center;
    cursor: pointer;
  }
  .choices label.off {
    color: var(--text-dim);
    cursor: default;
  }
  .choices input {
    accent-color: var(--accent);
    margin: 0;
  }
  @media (pointer: coarse) {
    .choices label {
      min-height: 32px;
    }
  }
</style>
