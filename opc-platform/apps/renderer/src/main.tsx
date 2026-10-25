import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import '@/shared/i18n';
import { App } from '@/app/App';
import { bootstrap } from '@/app/bootstrap';

// Electron-only: the bridge is the product's data layer, not an optional extra.
if (window.opc) bootstrap();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
