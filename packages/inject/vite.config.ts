// `vite build`                  -> dist/inject.js (minified, loaded by the reverse proxy)
// `vite build --mode userscript` -> dist/immich-raw.user.js (readable, for Violentmonkey/Tampermonkey)
import { defineConfig } from 'vite';

const USERSCRIPT_HEADER = `// ==UserScript==
// @name         immich-raw: Edit RAW button
// @namespace    https://github.com/LorinMuehlebach/immich-raw
// @version      0.1.0
// @description  Adds an "Edit RAW" button to Immich's photo viewer.
// @match        https://immich.example.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==
//
// Change the @match line above to your Immich address (keep the trailing /*).
// RAW_EDITOR_BASE is where the editor is served. The default assumes it runs on the same
// host as Immich at /immich-raw/, which the editor needs to reuse your Immich login.
const RAW_EDITOR_BASE = '/immich-raw/';
`;

export default defineConfig(({ mode }) => {
  const userscript = mode === 'userscript';
  return {
    build: {
      outDir: 'dist',
      emptyOutDir: !userscript,
      minify: !userscript,
      lib: {
        entry: 'src/main.ts',
        name: 'ImmichRawEditorInject',
        formats: ['iife'],
        fileName: () => (userscript ? 'immich-raw.user.js' : 'inject.js'),
      },
      rolldownOptions: {
        output: userscript ? { banner: USERSCRIPT_HEADER } : {},
      },
    },
  };
});
