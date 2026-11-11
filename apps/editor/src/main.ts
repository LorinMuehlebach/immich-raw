import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import BatchExportPage from './lib/ui/BatchExportPage.svelte';
import { installDoubleTap } from './lib/touch.ts';

installDoubleTap();
// ?export=<key>: the export page Immich's selection button opens; otherwise the editor.
const exportPage = new URLSearchParams(location.search).has('export');
mount(exportPage ? BatchExportPage : App, { target: document.getElementById('app')! });
