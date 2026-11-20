import { StandaloneSettingsWindow } from './features/settings/StandaloneSettingsWindow';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import * as Sentry from '@sentry/electron/renderer';
import { scrubEvent } from '@peep/shared';


// Error reports from this window go through the main process (which drops them when reports are off) and the shared
// scrubber, here too.
window.peep.getTelemetryEnabled().then((enabled: unknown) => {
  if (enabled) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Sentry.init({ beforeSend: (event: any) => scrubEvent(event) });
  }
});

const isStandaloneSettings =
  window.location.search.includes('window=settings') ||
  window.location.search.includes('windowType=settings') ||
  window.location.hash === '#settings' ||
  window.location.hash.startsWith('#settings');

const RootComponent = isStandaloneSettings
  ? () => {
      const query = new URLSearchParams(window.location.search);
      return <StandaloneSettingsWindow initialSection={query.get('section') || undefined} />;
    }
  : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>,
);
