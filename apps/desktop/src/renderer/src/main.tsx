import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import * as Sentry from '@sentry/electron/renderer';


// Initialize Sentry only if telemetry is opted-in
window.peep.getTelemetryEnabled().then((enabled: unknown) => {
  if (enabled) {
    Sentry.init({
      beforeSend(event: any) {
        if (event.request && event.request.data) {
          delete event.request.data;
        }
        const tokenRegex = /(Bearer\s+|session_token=)([a-zA-Z0-9\-_]+)/g;
        const apiKeyRegex = /AIza[0-9A-Za-z\-_]{35}|sk-[a-zA-Z0-9]{48}|sk-ant-[a-zA-Z0-9\-_]{90,}/g;

        const scrubString = (str: string) => {
          if (!str) return str;
          let res = str.replace(tokenRegex, '$1[REDACTED]');
          res = res.replace(apiKeyRegex, '[REDACTED_API_KEY]');
          res = res.replace(/(?:[A-Z]:\\[^\s]+|\/[^\s]+)[\\/]([^\s\\/]+)/g, '[REDACTED]/$1');
          return res;
        };

        if (event.breadcrumbs) {
          event.breadcrumbs.forEach((bc: any) => {
            if (bc.message) bc.message = scrubString(bc.message);
            if (bc.data) {
              for (const key in bc.data) {
                if (typeof bc.data[key] === 'string') {
                  bc.data[key] = scrubString(bc.data[key]);
                }
              }
            }
          });
        }

        if (event.exception && event.exception.values) {
          event.exception.values.forEach((val: any) => {
            if (val.value) val.value = scrubString(val.value);
          });
        }
        return event;
      }
    });
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
