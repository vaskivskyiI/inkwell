import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { applyTheme } from './theme.js';
import { store } from './store.js';
import './styles.css';

applyTheme();
// Phones start with the page, not the sidebar.
if (window.innerWidth < 800) store.set({ sidebar: false });
createRoot(document.getElementById('root')).render(<App />);
