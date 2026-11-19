import React from 'react';
import ReactDOM from 'react-dom/client';
import { FrameLab } from './FrameLab';

// Dev-only page (frame-lab.html): no window.peep, no app shell, just the device frames.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FrameLab />
  </React.StrictMode>,
);
