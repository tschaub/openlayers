import {createRequire} from 'module';
import path from 'path';
import {fileURLToPath} from 'url';

const require = createRequire(import.meta.url);
const {build} = require('../../tasks/serialize-workers.cjs');

const dir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(dir, '../../src/ol/worker');

// Vite counterpart of examples/webpack/worker-loader.cjs: serialize each
// src/ol/worker/*.js into a module that exports a working create().
export default function olWorker() {
  return {
    name: 'ol-worker-serialize',
    enforce: 'pre',
    async transform(code, id) {
      // Vite ids use forward slashes; normalize so path checks match on Windows.
      const file = path.normalize(id.split('?')[0]);
      if (!file.startsWith(workerDir + path.sep) || !file.endsWith('.js')) {
        return null;
      }
      const chunk = await build(file, {minify: false});
      // Rollup inlines imports (e.g. bufferUtil). Watch those files so edits
      // invalidate this transform; otherwise the worker blob stays stale while
      // the main thread picks up new buffer layouts (fills disappear).
      if (chunk.modules) {
        for (const moduleId of Object.keys(chunk.modules)) {
          if (path.isAbsolute(moduleId)) {
            this.addWatchFile(moduleId);
          }
        }
      }
      return {code: chunk.code, map: null};
    },
  };
}
