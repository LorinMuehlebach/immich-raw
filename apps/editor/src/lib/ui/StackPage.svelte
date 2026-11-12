<script lang="ts">
  // The page Immich's "Compare stack" button opens (?stack=<asset id>&ctx=…&return=…): the stack
  // window for the stack that photo is in, filling the page.
  import { getAssetInfo } from '@immich/sdk';
  import { editorUrl, isSafeReturnPath } from '@immich-raw/inject/routes';
  import { onMount } from 'svelte';
  import { getSession, initApi } from '../immich/api.ts';
  import { canEdit } from '../immich/save.ts';
  import type { StackFrame } from '../immich/stack-view.ts';
  import StackViewer from './StackViewer.svelte';

  const params = new URLSearchParams(location.search);
  const assetId = params.get('stack') ?? '';
  const ctx = params.get('ctx') ?? 'timeline';
  const ret = params.get('return');
  const backUrl = ret && isSafeReturnPath(ret) ? ret : assetId ? `/photos/${assetId}` : '/photos';

  let status = $state<'loading' | 'auth' | 'ready' | 'error' | 'done'>('loading');
  let canCull = $state(false);
  let error = $state('');
  let doneBack = $state(backUrl);

  onMount(async () => {
    document.title = 'Stack · immich-raw';
    initApi();
    try {
      const me = await getSession();
      if (!me) {
        status = 'auth';
        return;
      }
      if (!assetId) {
        error = 'No photo given. Open a stacked photo in Immich and click the stack button again.';
        status = 'error';
        return;
      }
      canCull = canEdit(await getAssetInfo({ id: assetId }), me);
      status = 'ready';
    } catch (e) {
      error = `Can't reach Immich: ${e instanceof Error ? e.message : String(e)}`;
      status = 'error';
    }
  });

  function openInEditor(rawId: string) {
    location.assign(editorUrl(import.meta.env.BASE_URL, rawId, ctx, backUrl));
  }

  /** Back to Immich, on the kept shot when the photo the page was opened on is in the trash now. */
  function afterDelete(trashed: string[], kept: StackFrame, warning: string | null) {
    const target = trashed.includes(assetId) ? (backUrl.includes(assetId) ? backUrl.replaceAll(assetId, kept.face.id) : `/photos/${kept.face.id}`) : backUrl;
    if (!warning) {
      location.assign(target);
      return;
    }
    error = `The other shots are in Immich's trash. ${warning}`;
    doneBack = target;
    status = 'done';
  }
</script>

<div class="page">
  <header>
    <a class="back" href={backUrl} title="Back to Immich">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
    </a>
    <span class="name">immich-raw</span>
    <span class="dim">Stack</span>
  </header>
  <main>
    {#if status === 'loading'}
      <p class="dim pad">Loading…</p>
    {:else if status === 'auth'}
      <div class="card">
        <h2>Log in to Immich first</h2>
        <p><a href="/auth/login">Open Immich</a>, log in, then open the stack again.</p>
      </div>
    {:else if status === 'error' || status === 'done'}
      <div class="card">
        <h2>{status === 'done' ? 'Done' : "Can't show the stack"}</h2>
        <p>{error}</p>
        <a class="button" href={status === 'done' ? doneBack : backUrl}>Back to Immich</a>
      </div>
    {:else}
      <StackViewer
        page
        {assetId}
        {canCull}
        onClose={() => location.assign(backUrl)}
        onOpenInEditor={openInEditor}
        onDeleted={({ trashed, kept, warning }) => afterDelete(trashed, kept, warning)}
      />
    {/if}
  </main>
</div>

<style>
  .page {
    height: 100%;
    display: grid;
    grid-template-rows: 48px minmax(0, 1fr);
    background: var(--bg-view);
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    background: var(--panel);
    border-bottom: 1px solid #111;
  }
  .back {
    display: inline-flex;
    padding: 6px;
    border-radius: 4px;
    color: var(--text);
  }
  .back:hover {
    background: var(--panel-2);
  }
  .name {
    color: var(--text-bright);
    font-weight: 600;
  }
  .dim {
    color: var(--text-dim);
  }
  main {
    min-height: 0;
  }
  .pad {
    padding: 32px 16px;
    text-align: center;
  }
  .card {
    width: 460px;
    max-width: calc(100% - 32px);
    margin: 32px auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
  }
  .card h2 {
    margin: 0 0 8px;
    font-size: 14px;
    color: var(--text-bright);
  }
  .card p {
    line-height: 1.45;
  }
  a {
    color: var(--accent);
  }
  .button {
    display: inline-block;
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--panel-2);
    color: var(--text);
    text-decoration: none;
  }
</style>
