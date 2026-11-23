<script lang="ts">
  // What the camera wrote about the shot (a Fujifilm RAF's maker note): film simulation, dynamic
  // range, white balance, sharpness, tones, grain, ... Read only; the editor uses some of it already.
  import { editor } from '../state/editor.svelte.ts';
  import Section from './Section.svelte';

  let open = $state(false);
  const others = $derived(Math.max(0, editor.cameraTags.size - editor.cameraSettings.length));
</script>

{#if editor.cameraSettings.length}
  <Section title="Camera" bind:open>
    <dl>
      {#each editor.cameraSettings as s (s.tag)}
        <dt>{s.label}</dt>
        <dd>{s.value}</dd>
      {/each}
    </dl>
    <p class="note">{editor.cameraTags.size} values in the file's maker note{others ? `, ${others} of them without a name here` : ''}.</p>
  </Section>
{/if}

<style>
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 12px;
    margin: 0;
    font-size: 12px;
  }
  dt {
    color: var(--text-dim);
  }
  dd {
    margin: 0;
    text-align: right;
    color: var(--text-bright);
  }
  .note {
    margin: 8px 0 0;
    color: var(--text-dim);
    font-size: 11px;
  }
</style>
