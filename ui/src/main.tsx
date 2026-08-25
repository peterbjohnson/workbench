import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './style.css';

const root = document.getElementById('root');
if (root === null) throw new Error('no #root to draw the board in');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
