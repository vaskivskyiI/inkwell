import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { applyTheme } from './theme.js';
import { store } from './store.js';
import './styles.css';

applyTheme();
// Phones start with the page, not the sidebar.
if (window.innerWidth < 800) store.set({ sidebar: false });
// Shown beside another app of the suite (SidePane.jsx): no second left menu.
if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embedded');
createRoot(document.getElementById('root')).render(<App />);
// Installable and opens offline; needs https (or localhost).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
