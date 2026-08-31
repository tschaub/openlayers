import {assert} from 'chai';
import {
  FrameUniformPool,
  placementKey,
} from '../../../../../src/ol/renderer/webgpu/vectorUtil.js';

describe('ol/renderer/webgpu/vectorUtil', () => {
  it('gives each world offset its own uniform buffer', () => {
    // Uniforms written with queue.writeBuffer all land before the encoded pass
    // runs, so tiles drawn at different world offsets need separate buffers.
    globalThis.GPUBufferUsage = /** @type {any} */ ({UNIFORM: 64, COPY_DST: 8});
    /** @type {Array<{buffer: Object, matrix: Float32Array}>} */
    const writes = [];
    const helper = /** @type {any} */ ({
      getDevice: () => ({createBuffer: () => ({destroy() {}})}),
      writeBuffer(buffer, data) {
        writes.push({buffer, matrix: Float32Array.from(data.subarray(0, 16))});
      },
    });
    const frame = /** @type {any} */ ({
      size: [200, 100],
      coordinateToPixelTransform: [1, 0, 0, 1, 0, 0],
      layerStatesArray: [{opacity: 1}],
      layerIndex: 0,
    });
    const pool = new FrameUniformPool(helper);
    pool.begin();
    const canonical = pool.get(frame, 0);
    const wrapped = pool.get(frame, -40075016.68557849);

    assert.notStrictEqual(canonical, wrapped);
    assert.notStrictEqual(canonical.buffer, wrapped.buffer);
    assert.strictEqual(writes.length, 2);
    assert.strictEqual(writes[0].matrix[12], -1);
    assert.isBelow(writes[1].matrix[12], writes[0].matrix[12]);

    // The same offset within a frame reuses its slot instead of rewriting it.
    assert.strictEqual(pool.get(frame, 0), canonical);
    assert.strictEqual(writes.length, 2);

    pool.dispose();
    delete globalThis.GPUBufferUsage;
  });

  it('uses every linear transform component but ignores translation', () => {
    const frame = /** @type {any} */ ({
      coordinateToPixelTransform: [1, 2, 3, 4, 5, 6],
    });
    const key = placementKey(7, frame);
    frame.coordinateToPixelTransform[4] = 500;
    assert.strictEqual(placementKey(7, frame), key);
    frame.coordinateToPixelTransform[3] = 4.5;
    assert.notStrictEqual(placementKey(7, frame), key);
  });
});
