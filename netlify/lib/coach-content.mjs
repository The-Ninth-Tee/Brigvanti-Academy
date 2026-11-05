// Loads the same content files the app uses. The files assign to window,
// so the shims give them a window and keep each language apart.
import './content-window-en.mjs';
import '../../content/brigvanti-content.js';
import './content-window-nl.mjs';
import '../../content/brigvanti-content.nl.js';

export const CONTENT = { en: globalThis.__brigContent.en, nl: globalThis.window.BRIG_CONTENT };
