import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { THEME } from './theme';
import './ui/styles.css';

// Farben zentral aus dem Theme als CSS-Variablen bereitstellen
for (const [name, wert] of Object.entries(THEME.ui)) document.documentElement.style.setProperty(`--${name}`, wert);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
