<script lang="ts">
  // Asked once, before the first AI mask downloads its models.
  import { ALL_MODEL_BYTES, aiConsent } from '../ai.svelte.ts';

  const MB = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      aiConsent.answer(false);
    }
  }

  function autofocus(node: HTMLElement) {
    queueMicrotask(() => node.focus());
  }
</script>

{#if aiConsent.asking}
  <div class="backdrop" role="presentation" onclick={() => aiConsent.answer(false)} onkeydown={onKey}>
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="ai-title" aria-describedby="ai-text" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey}>
      <h2 id="ai-title">Download the AI models?</h2>
      <div id="ai-text">
        <p>
          AI masks run in this browser. Their models are downloaded once from huggingface.co and
          storage.googleapis.com and then kept in the browser: {MB(aiConsent.asking.bytes)} now, up to {MB(ALL_MODEL_BYTES)} for all
          kinds of AI masks.
        </p>
        <p>Your photo is not uploaded anywhere.</p>
      </div>
      <div class="buttons">
        <button onclick={() => aiConsent.answer(false)}>Not now</button>
        <span class="spacer"></span>
        <button class="primary" onclick={() => aiConsent.answer(true)} use:autofocus>Download</button>
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
    width: 400px;
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
