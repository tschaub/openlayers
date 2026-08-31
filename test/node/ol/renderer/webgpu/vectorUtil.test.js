import {assert} from 'chai';
import {
  LABEL_COLLISION_MARGIN,
  labelsToScreen,
} from '../../../../../src/ol/renderer/webgpu/vectorUtil.js';

/**
 * @param {number} pixelRatio Pixel ratio.
 * @return {import('../../../../../src/ol/Map.js').FrameState} Frame.
 */
function frameState(pixelRatio = 2) {
  return /** @type {import('../../../../../src/ol/Map.js').FrameState} */ ({
    pixelRatio,
    size: [400, 300],
    coordinateToPixelTransform: [1, 0, 0, 1, 0, 0],
  });
}

describe('ol/renderer/webgpu/vectorUtil', () => {
  it('maps glyph collision boxes in CSS pixels, ignoring pixelRatio', () => {
    const glyph = {
      x: 100,
      y: 50,
      offsetX: -10,
      offsetY: -5,
      width: 20,
      height: 12,
    };
    const buffers = {
      glyphs: [glyph],
      labels: [
        {
          minX: 0,
          minY: 0,
          maxX: 1,
          maxY: 1,
          glyphStart: 0,
          glyphCount: 1,
        },
      ],
    };
    const retina = labelsToScreen(
      /** @type {any} */ (buffers),
      frameState(2),
    )[0];
    const css = labelsToScreen(/** @type {any} */ (buffers), frameState(1))[0];
    const margin = LABEL_COLLISION_MARGIN;
    assert.strictEqual(retina.minX, 100 - 10 - margin);
    assert.strictEqual(retina.minY, 50 - 5 - margin);
    assert.strictEqual(retina.maxX, 100 - 10 + 20 + margin);
    assert.strictEqual(retina.maxY, 50 - 5 + 12 + margin);
    assert.deepEqual(
      [retina.minX, retina.minY, retina.maxX, retina.maxY],
      [css.minX, css.minY, css.maxX, css.maxY],
    );
  });

  it('unions glyph quads and inflates with text padding plus margin', () => {
    const buffers = {
      glyphs: [
        {x: 0, y: 0, offsetX: 0, offsetY: 0, width: 10, height: 8},
        {x: 0, y: 0, offsetX: 8, offsetY: -2, width: 10, height: 10},
      ],
      labels: [
        {
          minX: 0,
          minY: 0,
          maxX: 1,
          maxY: 1,
          padding: [1, 2, 3, 4],
          glyphStart: 0,
          glyphCount: 2,
        },
      ],
    };
    const box = labelsToScreen(/** @type {any} */ (buffers), frameState())[0];
    const margin = LABEL_COLLISION_MARGIN;
    assert.strictEqual(box.minX, 0 - 4 - margin);
    assert.strictEqual(box.minY, -2 - 1 - margin);
    assert.strictEqual(box.maxX, 18 + 2 + margin);
    assert.strictEqual(box.maxY, 8 + 3 + margin);
  });

  it('inflates symbol boxes with the collision margin only', () => {
    const buffers = {
      glyphs: [],
      labels: [
        {
          minX: -5,
          minY: -4,
          maxX: 5,
          maxY: 4,
          glyphCount: 0,
          _anchor: [10, 20],
        },
      ],
    };
    const box = labelsToScreen(/** @type {any} */ (buffers), frameState(2))[0];
    const margin = LABEL_COLLISION_MARGIN;
    assert.strictEqual(box.minX, 10 - 5 - margin);
    assert.strictEqual(box.minY, 20 - 4 - margin);
    assert.strictEqual(box.maxX, 10 + 5 + margin);
    assert.strictEqual(box.maxY, 20 + 4 + margin);
  });
});
