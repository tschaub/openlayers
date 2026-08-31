import {assert} from 'chai';
import {
  GLYPH_INSTANCE_STRIDE,
  layoutPointLabel,
  packGlyphInstances,
} from '../../../../../../src/ol/render/webgpu/glyphLayout.js';
import Fill from '../../../../../../src/ol/style/Fill.js';
import Stroke from '../../../../../../src/ol/style/Stroke.js';
import Text from '../../../../../../src/ol/style/Text.js';
import FontAtlas from '../../../../../../src/ol/webgpu/FontAtlas.js';

describe('ol/render/webgpu/glyphLayout', () => {
  it('layouts a point label around the anchor', () => {
    const atlas = new FontAtlas();
    const glyphs = [];
    const text = new Text({
      text: 'Hi',
      font: '12px sans-serif',
      fill: new Fill({color: '#000'}),
      stroke: new Stroke({color: '#fff', width: 3}),
    });
    const box = layoutPointLabel(glyphs, text, [10, 20], atlas, [1, 0, 0, 1]);
    assert.isNotNull(box);
    assert.isAbove(glyphs.length, 0);
    assert.strictEqual(glyphs[0].x, 10);
    assert.strictEqual(glyphs[0].y, 20);
    assert.strictEqual(glyphs[0].r, 0);
    assert.strictEqual(glyphs[0].strokeR, 1);
    assert.strictEqual(glyphs[0].strokeA, 1);
    const packed = packGlyphInstances(glyphs);
    assert.strictEqual(packed.length, glyphs.length * GLYPH_INSTANCE_STRIDE);
  });

  it('sizes the declutter box from glyph quads and padding', () => {
    const atlas = new FontAtlas();
    const glyphs = [];
    const box = layoutPointLabel(
      glyphs,
      new Text({
        text: 'Hi',
        font: '24px sans-serif',
        fill: new Fill({color: '#000'}),
        padding: [1, 2, 3, 4],
      }),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );
    assert.isNotNull(box);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const glyph of glyphs) {
      minX = Math.min(minX, glyph.offsetX);
      minY = Math.min(minY, glyph.offsetY);
      maxX = Math.max(maxX, glyph.offsetX + glyph.width);
      maxY = Math.max(maxY, glyph.offsetY + glyph.height);
    }
    assert.strictEqual(box.minX, minX - 4);
    assert.strictEqual(box.minY, minY - 1);
    assert.strictEqual(box.maxX, maxX + 2);
    assert.strictEqual(box.maxY, maxY + 3);
  });

  it('aligns mixed-case glyphs on the alphabetic baseline', () => {
    const atlas = new FontAtlas();
    const glyphs = [];
    const font = '24px sans-serif';
    layoutPointLabel(
      glyphs,
      new Text({
        text: 'Aa',
        font,
        fill: new Fill({color: '#000'}),
      }),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );
    assert.strictEqual(glyphs.length, 2);
    const metricsA = atlas.getGlyph(font, 'A');
    const metricsa = atlas.getGlyph(font, 'a');
    assert.isAbove(metricsA.ascent, metricsa.ascent);
    assert.isAbove(glyphs[1].offsetY, glyphs[0].offsetY);
    assert.approximately(
      glyphs[0].offsetY + metricsA.ascent,
      glyphs[1].offsetY + metricsa.ascent,
      0.01,
    );
  });
});
