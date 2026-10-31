/// <reference types="vite/client" />

declare global {
  interface Window {
    peep: import('@peep/shared').IpcApi;
  }
}

