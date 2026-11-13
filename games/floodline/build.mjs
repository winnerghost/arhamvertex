// Builds the offline package used by the Android app and the website:
// one bundled script (three.js and PeerJS included) and an index.html with the fonts inlined.
// Usage: node build.mjs <node_modules dir> <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const here = path.dirname(new URL(import.meta.url).pathname);
const nm = path.resolve(process.argv[2]);
const { build } = createRequire(path.join(nm, 'noop.js'))('esbuild');
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(here, 'js/main.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['chrome90', 'safari15', 'firefox100'],
  outfile: path.join(out, 'game.js'),
  nodePaths: [nm],
  legalComments: 'none',
  logLevel: 'warning',
});

// fonts: inline the weights the page uses as base64 woff2
const faces = [
  ['Barlow Condensed', '@fontsource/barlow-condensed', [400, 500, 600, 700]],
  ['Barlow', '@fontsource/barlow', [400, 500, 600]],
  ['Big Shoulders Stencil Display', '@fontsource/big-shoulders-stencil-display', [700, 900]],
];
let css = '';
for (const [family, pkg, weights] of faces) {
  for (const w of weights) {
    const base = path.join(nm, pkg, 'files');
    const file = fs.readdirSync(base).find((f) => f.endsWith(`-latin-${w}-normal.woff2`));
    if (!file) throw new Error(`missing font ${family} ${w}`);
    const data = fs.readFileSync(path.join(base, file)).toString('base64');
    css += `@font-face{font-family:"${family}";font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${data}) format("woff2")}\n`;
  }
}

let html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
html = html.replace(/<link rel="preconnect"[^>]*>\s*/g, '');
html = html.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, `<style>${css}</style>`);
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
html = html.replace('<script type="module" src="js/main.js"></script>', '<script type="module" src="game.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('built', fs.statSync(path.join(out, 'game.js')).size, 'bytes js,', html.length, 'bytes html');
