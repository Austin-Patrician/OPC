import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@/styles/index.css';
import './buddy.css';
import '@/shared/i18n';
import { DesktopBuddyOverlay } from '@/widgets/buddy-companion/DesktopBuddyOverlay';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from buddy.html');

createRoot(container).render(
  <StrictMode>
    <DesktopBuddyOverlay />
  </StrictMode>,
);
