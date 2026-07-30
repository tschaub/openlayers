import {assert} from 'chai';
import FontAtlas from '../../../../../src/ol/webgl/FontAtlas.js';

describe('ol/webgl/FontAtlas', () => {
  it('rasterizes and caches glyphs', () => {
    const atlas = new FontAtlas(256);
    const a1 = atlas.getGlyph('12px sans-serif', 'A');
    const a2 = atlas.getGlyph('12px sans-serif', 'A');
    assert.strictEqual(a1, a2);
    assert.isAbove(a1.width, 0);
    assert.isAbove(a1.height, 0);
    assert.isAbove(a1.advance, 0);
    assert.isAtMost(a1.u1, 1);
    assert.isAtMost(a1.v1, 1);
  });

  it('measures text width', () => {
    const atlas = new FontAtlas(256);
    const w = atlas.measureWidth('12px sans-serif', 'Hello');
    assert.isAbove(w, 0);
  });

  it('packs multiple glyphs without overlap in UV', () => {
    const atlas = new FontAtlas(256);
    const glyphs = 'ABCDE'
      .split('')
      .map((ch) => atlas.getGlyph('10px monospace', ch));
    for (let i = 0; i < glyphs.length; ++i) {
      for (let j = i + 1; j < glyphs.length; ++j) {
        const a = glyphs[i];
        const b = glyphs[j];
        const overlapX = a.u0 < b.u1 && a.u1 > b.u0;
        const overlapY = a.v0 < b.v1 && a.v1 > b.v0;
        assert.isFalse(overlapX && overlapY);
      }
    }
  });
});
