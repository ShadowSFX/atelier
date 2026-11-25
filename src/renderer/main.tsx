import '@fontsource-variable/inter/index.css';
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadApp } from './state/app';
import { initRuntimeEvents } from './state/runtime';
import { loadWorkspace } from './state/workspace';
import { startSnapshotTimer } from './terminal/registry';

async function boot(): Promise<void> {
  initRuntimeEvents();
  await loadApp();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await loadWorkspace();
  startSnapshotTimer();
}

void boot();
