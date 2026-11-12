import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import BatchExportPage from './lib/ui/BatchExportPage.svelte';
import CullPage from './lib/ui/CullPage.svelte';
import StackPage from './lib/ui/StackPage.svelte';
import { installDoubleTap } from './lib/touch.ts';

installDoubleTap();
// ?export=<key> / ?cull=<key>: the export and auto-stack pages Immich's selection buttons open.
// ?stack=<asset id>: the stack window Immich's "Compare stack" button opens. Otherwise the editor.
const params = new URLSearchParams(location.search);
const Page = params.has('export') ? BatchExportPage : params.has('cull') ? CullPage : params.has('stack') ? StackPage : App;
mount(Page, { target: document.getElementById('app')! });
