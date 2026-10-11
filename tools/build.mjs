// Builds the browser bundles (public/dist) and the self-contained hub (dist/server.cjs).
import { build } from 'esbuild';

const common = { bundle: true, minify: true, sourcemap: false, logLevel: 'info', legalComments: 'none' };
const browser = { ...common, target: ['safari15', 'chrome100', 'firefox100'], format: 'iife' };

await Promise.all([
  build({ ...browser, entryPoints: ['src/app/main.ts'], outfile: 'public/dist/app.js' }),
  build({ ...browser, entryPoints: ['src/app/worker.ts'], outfile: 'public/dist/engine-worker.js' }),
  build({ ...browser, entryPoints: ['src/app/capture-worklet.ts'], outfile: 'public/dist/capture-worklet.js' }),
  build({ ...browser, entryPoints: ['src/app/soundai-worker.ts'], outfile: 'public/dist/soundai-worker.js' }),
  build({ ...browser, entryPoints: ['src/console/main.ts'], outfile: 'public/dist/console.js' }),
  build({
    ...common,
    minify: false,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    entryPoints: ['src/server/server.ts'],
    outfile: 'dist/server.cjs',
    external: ['bufferutil', 'utf-8-validate', '@agntcy/slim-bindings', 'sherpa-onnx-node'],
  }),
  build({ ...common, minify: false, platform: 'node', target: 'node18', format: 'cjs', entryPoints: ['src/agents/evalCli.ts'], outfile: 'dist/eval.cjs' }),
  build({ ...common, minify: false, platform: 'node', target: 'node18', format: 'cjs', entryPoints: ['tools/redteam/run.ts'], outfile: 'dist/redteam.cjs' }),
  build({ ...common, minify: false, platform: 'node', target: 'node18', format: 'cjs', entryPoints: ['tools/calibrate.ts'], outfile: 'dist/calibrate.cjs' }),
]);
