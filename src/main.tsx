import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/source-serif-4';
import 'katex/dist/katex.min.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/doc.css';
import './styles/editor.css';
import './styles/components.css';
import './styles/ai.css';
import './styles/school.css';
import './styles/review.css';
import './styles/print.css';
import { App } from './App';
import { useReview } from './state/review';
import { useVault } from './state/vault';
import { scheduler } from './lib/ai/engine';

// Dev server only: lets the end-to-end tests read app state (never in a build).
if (import.meta.env.DEV) Object.assign(window, { __nib: { review: useReview, vault: useVault, scheduler } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
