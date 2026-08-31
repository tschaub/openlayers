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

  it('wraps point labels at word boundaries and preserves newlines', () => {
    const atlas = new FontAtlas();
    const glyphs = [];
    layoutPointLabel(
      glyphs,
      new Text({
        text: 'aa aa\nbb bb',
        font: '20px sans-serif',
        maxWidth: 30,
      }),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );

    assert.strictEqual(glyphs.length, 8);
    assert.isBelow(glyphs[0].offsetY, glyphs[2].offsetY);
    assert.isBelow(glyphs[2].offsetY, glyphs[4].offsetY);
    assert.isBelow(glyphs[4].offsetY, glyphs[6].offsetY);
  });

  it('wraps scripts without spaces at word or ideographic boundaries', () => {
    const atlas = new FontAtlas();
    const glyphs = [];
    layoutPointLabel(
      glyphs,
      new Text({
        text: '日本日本',
        font: '20px sans-serif',
        maxWidth: 25,
      }),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );

    assert.strictEqual(glyphs.length, 4);
    assert.isBelow(glyphs[0].offsetY, glyphs[1].offsetY);
    assert.isBelow(glyphs[1].offsetY, glyphs[2].offsetY);
    assert.isBelow(glyphs[2].offsetY, glyphs[3].offsetY);
  });

  it('leaves an unbreakable word on one line', () => {
    const atlas = new FontAtlas();
    const glyphs = [];
    layoutPointLabel(
      glyphs,
      new Text({
        text: 'aaaaaaaa',
        font: '20px sans-serif',
        maxWidth: 10,
      }),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );

    assert.strictEqual(glyphs.length, 8);
    for (let i = 1; i < glyphs.length; ++i) {
      assert.strictEqual(glyphs[i].offsetY, glyphs[0].offsetY);
    }
  });

  it('applies maximum width after horizontal scale', () => {
    const atlas = new FontAtlas();
    const unscaled = [];
    const scaled = [];
    layoutPointLabel(
      unscaled,
      new Text({
        text: 'aa aa',
        font: '12px sans-serif',
        maxWidth: 60,
      }),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );
    layoutPointLabel(
      scaled,
      new Text({
        text: 'aa aa',
        font: '12px sans-serif',
        maxWidth: 60,
        scale: [2, 1],
      }),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );

    assert.strictEqual(unscaled.length, 5);
    assert.strictEqual(scaled.length, 4);
    assert.isBelow(scaled[0].offsetY, scaled[2].offsetY);
  });

  it('does not wrap line-placement text', () => {
    const atlas = new FontAtlas();
    const glyphs = [];
    layoutPointLabel(
      glyphs,
      new Text({
        text: 'aa aa',
        font: '20px sans-serif',
        maxWidth: 10,
        placement: 'line',
      }),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );

    assert.strictEqual(glyphs.length, 5);
    assert.strictEqual(glyphs[1].offsetY, glyphs[0].offsetY);
    assert.strictEqual(glyphs[3].offsetY, glyphs[0].offsetY);
    assert.strictEqual(glyphs[4].offsetY, glyphs[0].offsetY);
  });

  it('justifies wrapped lines within the text block', () => {
    const atlas = new FontAtlas();
    const left = [];
    const right = [];
    const options = {
      text: 'aaaa aa',
      font: '20px sans-serif',
      maxWidth: 50,
      textAlign: 'center',
    };
    layoutPointLabel(
      left,
      new Text({...options, justify: 'left'}),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );
    layoutPointLabel(
      right,
      new Text({...options, justify: 'right'}),
      [0, 0],
      atlas,
      [1, 0, 0, 1],
    );

    assert.approximately(left[0].offsetX, left[4].offsetX, 0.01);
    assert.isAbove(right[4].offsetX, right[0].offsetX);
  });
});
