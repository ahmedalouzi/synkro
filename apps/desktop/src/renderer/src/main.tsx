import { StandaloneSettingsWindow } from './features/settings/StandaloneSettingsWindow';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import * as Sentry from '@sentry/electron/renderer';
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@peep/shared';

let rendererTelemetryEnabled = false;
let sentryInitialized = false;

function syncRendererSentry(enabled: boolean): void {
  rendererTelemetryEnabled = enabled;
  if (enabled && !sentryInitialized) {
    sentryInitialized = true;
    Sentry.init({
      enabled: true,
      beforeSend(event: any) {
        if (!rendererTelemetryEnabled) {
          return null;
        }
        return scrubSentryEvent(event);
      },
      beforeBreadcrumb(breadcrumb: any) {
        if (!rendererTelemetryEnabled) {
          return null;
        }
        return scrubSentryBreadcrumb(breadcrumb);
      },
    });
    return;
  }
  const client = Sentry.getClient();
  if (client) {
    (client.getOptions() as any).enabled = enabled;
  }
}

// Initialize Sentry only if telemetry is opted-in, and stay synced live when toggled in Settings
window.peep.getTelemetryEnabled().then((enabled: unknown) => {
  syncRendererSentry(enabled === true);
}).catch(() => {
  syncRendererSentry(false);
});

window.peep.onSettingsUpdated?.((partial) => {
  if (typeof partial.telemetryEnabled === 'boolean') {
    syncRendererSentry(partial.telemetryEnabled);
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
