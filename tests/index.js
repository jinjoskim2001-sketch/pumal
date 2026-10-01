// Entry point for `node --test tests/`. Node 26 resolves a directory argument as a module
// instead of searching it, so without this file that command fails before running anything.
// `node --test` (no argument) still discovers the *.test.js files by itself and skips this one.
import './art.test.js';
import './audio.test.js';
import './engine.test.js';
import './install.test.js';
import './integration.test.js';
import './lcd.test.js';
import './scenes.test.js';
import './sw.test.js';
import './ui.test.js';
