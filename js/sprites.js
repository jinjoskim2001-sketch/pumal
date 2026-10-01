// Single import point for all pixel art. Scenes and UI never import js/art/* directly.
import { YOUNG } from './art/young.js';
import { ADULTS } from './art/adults.js';

export { ICONS, ITEMS, FONT_SMALL, FONT_BIG } from './art/ui.js';
export const SPECIES_ART = { ...YOUNG, ...ADULTS };
