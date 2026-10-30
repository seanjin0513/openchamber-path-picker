import { build } from 'esbuild';

await build({
  entryPoints: ['src/panel.ts'],
  outfile: 'panel/main.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

console.log('build ok: panel/main.js');
