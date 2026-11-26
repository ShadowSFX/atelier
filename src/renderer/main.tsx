import '@fontsource-variable/inter/index.css';
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadApp } from './state/app';
import { initNotifications } from './state/notifications';
import { initRuntimeEvents } from './state/runtime';
import { loadLibrary, openLibrary } from './state/library';
import { loadWorkspace, useWorkspace } from './state/workspace';
import { startSnapshotTimer } from './terminal/registry';

async function boot(): Promise<void> {
  initRuntimeEvents();
  initNotifications();
  await loadApp();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await loadLibrary();
  await loadWorkspace();
  // Nothing open: start on the library.
  if (useWorkspace.getState().projects.length === 0) openLibrary();
  startSnapshotTimer();
}

void boot();
