import {assert} from 'chai';
import {
  GLYPH_INSTANCE_STRIDE,
  layoutLineLabel,
  layoutPointLabel,
  polygonLabelAnchor,
} from '../../../../../../src/ol/render/webgl/glyphLayout.js';
import Fill from '../../../../../../src/ol/style/Fill.js';
import Text from '../../../../../../src/ol/style/Text.js';
import FontAtlas from '../../../../../../src/ol/webgl/FontAtlas.js';

describe('ol/render/webgl/glyphLayout', () => {
  /** @type {FontAtlas} */
  let atlas;
  /** @type {import('../../../../../../src/ol/render/webgl/glyphLayout.js').LayoutContext} */
  let context;

  beforeEach(() => {
    atlas = new FontAtlas(256);
    context = {atlas, resolution: 1};
  });

  it('layoutPointLabel emits one instance per glyph', () => {
    /** @type {Array<number>} */
    const out = [];
    const textStyle = new Text({
      text: 'Hi',
      font: '12px sans-serif',
      fill: new Fill({color: '#000'}),
    });
    layoutPointLabel(out, textStyle, [10, 20], context);
    assert.strictEqual(out.length % GLYPH_INSTANCE_STRIDE, 0);
    assert.strictEqual(out.length / GLYPH_INSTANCE_STRIDE, 2);
    assert.strictEqual(out[0], 10);
    assert.strictEqual(out[1], 20);
  });

  it('layoutPointLabel skips empty text', () => {
    /** @type {Array<number>} */
    const out = [];
    layoutPointLabel(out, new Text({text: ''}), [0, 0], context);
    assert.strictEqual(out.length, 0);
  });

  it('layoutLineLabel places glyphs along a path', () => {
    /** @type {Array<number>} */
    const out = [];
    const textStyle = new Text({
      text: 'AB',
      font: '12px sans-serif',
      placement: 'line',
      overflow: true,
      fill: new Fill({color: '#000'}),
    });
    layoutLineLabel(out, textStyle, [0, 0, 100, 0], 2, context);
    assert.isAtLeast(out.length / GLYPH_INSTANCE_STRIDE, 1);
  });

  it('polygonLabelAnchor returns an interior point', () => {
    const flat = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];
    const anchor = polygonLabelAnchor(flat, [flat.length]);
    assert.isNotNull(anchor);
    assert.isAtLeast(/** @type {number[]} */ (anchor)[0], 0);
    assert.isAtMost(/** @type {number[]} */ (anchor)[0], 10);
  });
});
