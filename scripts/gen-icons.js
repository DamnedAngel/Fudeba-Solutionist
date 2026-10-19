'use strict';
// Generates the built-in icon set (original artwork, 16x16, light and dark variants) into media/icons/.
//   node scripts/gen-icons.js
// Each icon is drawn once as a function of a palette; light/dark only differ in colours.
const fs = require('fs');
const path = require('path');

const PAL = {
  light: { floppy: '#1f6fc5', romBody: '#c2331b', mdoBody: '#2f8a34', binBody: '#7a2d92', funnel: '#0a4f9e', purple: '#68217a', blue: '#1f6fb5', green: '#2f7d32', yellow: '#b8860b', folder: '#c09553', grey: '#5a5a5a', red: '#c2331b', teal: '#0a7e8c', page: '#ffffff', edge: '#6b6b6b' },
  dark: { floppy: '#3f93e8', romBody: '#e5533a', mdoBody: '#4cb552', binBody: '#a65fc4', funnel: '#9bd0ff', purple: '#c59ce0', blue: '#75beff', green: '#89d185', yellow: '#e8c76a', folder: '#dcb67a', grey: '#c5c5c5', red: '#f48771', teal: '#4ec9d4', page: '#2d2d2d', edge: '#a8a8a8' },
};

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>\n`;
// the sheet fills the 16 px box (VS Code draws tree icons at a fixed 16 px, so the artwork has to use all of it)
const page = (p, extra = '') => `<path d="M2.5 .5h7.5l3.5 3.5v11.5h-11z" fill="${p.page}" stroke="${p.edge}"/><path d="M10 .5v3.5h3.5" fill="none" stroke="${p.edge}"/>${extra}`;
const sheet = (text, color, size) => `<path d="M2.5 .5h7.5l3.5 3.5v11.5h-11z" fill="#ffffff" stroke="#6b6b6b"/><path d="M10 .5v3.5h3.5" fill="none" stroke="#6b6b6b"/><text x="8" y="${size > 7 ? 14 : 12.6}" text-anchor="middle" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="800" font-size="${size}" fill="${color}"${size > 7 ? '' : ' textLength="9.6" lengthAdjust="spacingAndGlyphs"'}>${text}</text>`;
const folderShape = (p) => `<path d="M1.5 4.5v8.5h13V5.5H8L6.7 4H2z" fill="${p.folder}" stroke="${p.folder}" stroke-linejoin="round"/>`;

const ICONS = {
  // the solution: the player ship of the MSX game Aleste (16x16 sprite, from scripts/art/aleste-ship.svg) on a dark tile.
  // An original pixel-art ship and the earlier purple bars are kept in scripts/icon-backups/.
  solution: () => fs.readFileSync(path.join(__dirname, 'art', 'aleste-ship.svg'), 'utf8'),
  solutionFolder: (p) => `${folderShape(p)}<rect x="6" y="7.5" width="6" height="1.6" fill="${p.purple}"/><rect x="6" y="10.3" width="6" height="1.6" fill="${p.purple}" opacity=".6"/>`,
  // projects, by kind
  'project.cpp': (p) => `<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="${p.page}" stroke="${p.blue}"/><path d="M4 8h3M5.5 6.5v3M9 8h3M10.5 6.5v3" stroke="${p.blue}" stroke-width="1.2" fill="none"/>`,
  'project.makefile': (p) => `<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="${p.page}" stroke="${p.teal}"/><circle cx="8" cy="8" r="2.3" fill="none" stroke="${p.teal}" stroke-width="1.3"/><path d="M8 3.8v1.4M8 10.8v1.4M3.8 8h1.4M10.8 8h1.4" stroke="${p.teal}" stroke-width="1.3"/>`,
  // MSX application kinds (PROJECT_TYPE in ApplicationSettings.txt), drawn as what they are:
  // COM = a 3.5" floppy disk (metal shutter on top, label below, cut corner)
  // "glass" look as the cartridge: dark body, lighter outline, white label with dark writing.
  // The previous solid version (saturated body, navy outline) is kept in scripts/icon-backups/project.com.solid.*.svg
  'project.com': () => `<path d="M1 1h11.6L15 3.4V15H1z" fill="#17497f" stroke="#5aa9f0" stroke-width="1" stroke-linejoin="round"/><rect x="4.2" y="1" width="7.2" height="4.8" fill="#e8f2fd" stroke="#9cc9f6" stroke-width=".7"/><rect x="8.9" y="2.1" width="1.9" height="2.7" fill="#17497f"/><rect x="3" y="8.4" width="10" height="5.8" rx=".4" fill="#ffffff" stroke="#9cc9f6" stroke-width=".8"/><path d="M4.5 10.4h7M4.5 12.2h7" stroke="#17497f" stroke-width=".9" fill="none"/>`,
  // ROM = an MSX cartridge (chamfered top, label, gold connector edge with contacts)
  'project.rom': () => `<path d="M2.6 1.6h10.8L15 3.2V11.6H1V3.2z" fill="#8a190b" stroke="#ee6a52" stroke-width="1" stroke-linejoin="round"/><rect x="3" y="3.9" width="10" height="5.2" rx=".4" fill="#ffffff" stroke="#f4b0a2" stroke-width=".8"/><path d="M4.4 5.7h7.2M4.4 7.5h4.4" stroke="#7a1409" stroke-width=".9" fill="none"/><rect x="2.5" y="11.6" width="11" height="3.1" fill="#3b0a05" stroke="#ee6a52" stroke-width=".8"/><path d="M4.1 12.2v2M6.2 12.2v2M8.3 12.2v2M10.4 12.2v2M12.5 12.2v2" stroke="#f0c14b" stroke-width="1.2" fill="none"/>`,
  // MDO = an overlay module (like a DLL, something that snaps into the application): a puzzle piece, "glass" look as the others.
  // (the earlier wrench is kept in scripts/icon-backups/project.mdo.wrench.*.svg)
  'project.mdo': () => `<path transform="translate(8 8) scale(1.1) translate(-8.6 -7.4)" d="M2.5 4.5H5.6A1.9 1.9 0 1 1 8.4 4.5H11.5V7.6A1.9 1.9 0 1 1 11.5 10.4V13.5H2.5V10.4A1.9 1.9 0 1 0 2.5 7.6z" fill="#1c5a26" stroke="#6fd67a" stroke-width=".9" stroke-linejoin="round"/>`,
  // BIN = a Z80-style DIP chip lying on its side (pins up and down, notch on the left), same "glass" look as the cartridge
  'project.bin': () => { const pins = [3, 5.6, 8.2, 10.8, 13.4].map((x) => `M${x} 1.5v2M${x} 12.5v2`).join(''); return `<path d="${pins}" stroke="#c98ae6" stroke-width="1.3" fill="none"/><rect x="1" y="3.2" width="14" height="9.6" rx="1.2" fill="#5a1a78" stroke="#c98ae6" stroke-width="1"/><path d="M1.5 6.4a1.6 1.6 0 0 1 0 3.2z" fill="#2a0b36" stroke="#c98ae6" stroke-width=".7"/><text x=\"4.1\" y=\"10.7\" textLength=\"4.4\" lengthAdjust=\"spacingAndGlyphs\" font-family=\"Consolas, Menlo, monospace\" font-weight=\"700\" font-size=\"9.4\" fill=\"#c98ae6\">0</text><text x=\"9.1\" y=\"10.7\" textLength=\"4.4\" lengthAdjust=\"spacingAndGlyphs\" font-family=\"Consolas, Menlo, monospace\" font-weight=\"700\" font-size=\"9.4\" fill=\"#c98ae6\">1</text>`; },
  'project.dotnet': (p) => `<path d="M8 1.8l5.6 3.2v6L8 14.2 2.4 11V5z" fill="${p.page}" stroke="${p.purple}" stroke-linejoin="round"/><path d="M5.6 9.6V6.4l2.4 3.2V6.4" stroke="${p.purple}" fill="none" stroke-width="1.1"/><circle cx="10.6" cy="9.4" r=".6" fill="${p.purple}"/>`,
  'project.shared': (p) => `<rect x="2" y="2" width="8" height="8" rx="1" fill="${p.page}" stroke="${p.blue}"/><rect x="6" y="6" width="8" height="8" rx="1" fill="${p.page}" stroke="${p.blue}"/>`,
  'project.unknown': (p) => `<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="${p.page}" stroke="${p.grey}"/><path d="M6.2 6.4a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.8.6-.8 1.2M8 11.3v.2" stroke="${p.grey}" fill="none" stroke-width="1.2" stroke-linecap="round"/>`,
  'project.missing': (p) => `<path d="M8 2l6.5 11.5h-13z" fill="${p.page}" stroke="${p.red}" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.4v.3" stroke="${p.red}" stroke-width="1.3" stroke-linecap="round"/>`,
  // folders and files
  folder: (p) => folderShape(p),
  // the funnel is big, saturated and ringed in the page colour so it stays readable on the folder at 16 px
  filter: (p) => { const f = 'M4.2 6.2h8.6L9.4 10.3v3.9l-2.8-1.6v-2.3z'; return `${folderShape(p)}<path d="${f}" fill="${p.blue}" stroke="${p.page}" stroke-width="2" stroke-linejoin="round"/><path d="${f}" fill="${p.funnel}"/>`; },
  file: (p) => page(p),
  // source files: always a white sheet (both themes) with the language badge over it
  'file.c': () => sheet('C', '#0b5cad', 11),
  'file.h': () => sheet('H', '#7a2a8c', 11),
  // ZOO class files (.zml): upright letters laid out on the diagonal, as in the Zoo logo (white Z top left, orange O
  // in the centre and bottom right), black outline, no sheet
  'file.zoo': () => `<g font-family="Arial Black, Segoe UI, Arial, Helvetica, sans-serif" font-weight="900" font-size="9.6" stroke="#000" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke" text-anchor="middle"><text x="4.6" y="8.1" fill="#ffffff">Z</text><text x="8.2" y="11.6" fill="#f5a01a">O</text><text x="11.6" y="15" fill="#f5a01a">O</text></g>`,
  'file.asm': () => sheet('A', '#b3260e', 11),
  'file.inc': () => sheet('I', '#1b7a2e', 11),
  'file.missing': (p) => page(p, `<path d="M8 6.6v3.2M8 11.3v.3" stroke="${p.red}" stroke-width="1.3" stroke-linecap="round"/>`),
  // build actions and dependencies
  buildActions: (p) => `<circle cx="8" cy="8" r="2.4" fill="none" stroke="${p.grey}" stroke-width="1.4"/><path d="M8 1.8v2.2M8 12v2.2M1.8 8H4M12 8h2.2M3.6 3.6l1.6 1.6M10.8 10.8l1.6 1.6M12.4 3.6l-1.6 1.6M5.2 10.8l-1.6 1.6" stroke="${p.grey}" stroke-width="1.5" stroke-linecap="round"/>`,
  'action.build': (p) => `<path d="M4.5 2.8v10.4L13 8z" fill="${p.green}"/>`,
  'action.rebuild': (p) => `<path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="${p.green}" stroke-width="1.6" stroke-linecap="round"/><path d="M13.4 1.8v3.6H9.8z" fill="${p.green}"/>`,
  'action.clean': (p) => `<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="${p.red}" stroke-width="1.3" stroke-linejoin="round"/><path d="M7 7v4M9 7v4" stroke="${p.red}" stroke-width="1.1"/>`,
  dependencies: (p) => `<rect x="1.5" y="2" width="5" height="4" rx=".8" fill="${p.page}" stroke="${p.blue}"/><rect x="9.5" y="10" width="5" height="4" rx=".8" fill="${p.page}" stroke="${p.blue}"/><path d="M4 6v3.5a1 1 0 0 0 1 1h4" fill="none" stroke="${p.blue}"/><path d="M8.4 8.9l1.4 1.6-1.4 1.6" fill="none" stroke="${p.blue}"/>`,
};

const GROW = 1.15;
const FULL = new Set(['solution', 'project.rom', 'project.bin', 'project.com', 'project.mdo', 'file', 'file.c', 'file.h', 'file.asm', 'file.inc', 'file.zoo', 'file.missing']);
const out = path.join(__dirname, '..', 'media', 'icons');
let n = 0;
for (const theme of Object.keys(PAL)) {
  fs.mkdirSync(path.join(out, theme), { recursive: true });
  for (const [key, draw] of Object.entries(ICONS)) {
    // the other icons are drawn inside a 13 px area; scale them up to use the whole box (sheets already do)
    const body = draw(PAL[theme]);
    fs.writeFileSync(path.join(out, theme, `${key}.svg`), body.startsWith('<svg') ? body : svg(FULL.has(key) ? body : `<g transform="translate(8 8) scale(${GROW}) translate(-8 -8)">${body}</g>`));
    n++;
  }
}
console.log(`${n} icons -> ${out}`);
module.exports = { ICON_KEYS: Object.keys(ICONS) };
