<script lang="ts">
  // Asked before the Fujifilm film looks are downloaded (picking one, or saving an edit that uses one).
  import { FUJI_LOOKS_SOURCE } from '@immich-raw/pipeline';
  import { FUJI_LOOKS_MB, fujiLooks } from '../fuji-looks.svelte.ts';

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      fujiLooks.answer(false);
    }
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }
</script>

{#if fujiLooks.asking}
  <div class="backdrop" role="presentation" onclick={() => fujiLooks.answer(false)} onkeydown={onKey}>
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="fuji-title" aria-describedby="fuji-text" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey}>
      <h2 id="fuji-title">Download the Fujifilm film looks?</h2>
      <div id="fuji-text">
        <p>
          The film looks (Provia, Velvia, Classic Chrome, Classic Neg. and others) are community-made look tables by
          <a href={FUJI_LOOKS_SOURCE.repo} target="_blank" rel="noreferrer">{FUJI_LOOKS_SOURCE.author}</a>, modelled on Fujifilm's film
          simulations. They are not part of immich-raw: about {FUJI_LOOKS_MB} MB are downloaded once from raw.githubusercontent.com and
          then kept in this browser.
        </p>
        <p>
          They are licensed <a href={FUJI_LOOKS_SOURCE.licenceUrl} target="_blank" rel="noreferrer">{FUJI_LOOKS_SOURCE.licence}</a>
          (non-commercial). Your photos stay your own work, and your photo is not uploaded anywhere.
        </p>
      </div>
      <div class="buttons">
        <button onclick={() => fujiLooks.answer(false)}>Not now</button>
        <span class="spacer"></span>
        <button class="primary" onclick={() => fujiLooks.answer(true)} use:autofocus>Download</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 110;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .dialog {
    width: 420px;
    max-width: calc(100vw - 32px);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    outline: none;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 14px;
    color: var(--text-bright);
  }
  p {
    margin: 0 0 10px;
    line-height: 1.45;
  }
  .buttons {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 4px;
  }
  .spacer {
    flex: 1;
  }
</style>
