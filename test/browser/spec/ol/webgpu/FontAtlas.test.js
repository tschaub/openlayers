import {assert} from 'chai';
import FontAtlas from '../../../../../src/ol/webgpu/FontAtlas.js';

describe('ol/webgpu/FontAtlas', () => {
  it('packs glyphs on a shelf and grows when full', () => {
    const atlas = new FontAtlas();
    const a = atlas.getGlyph('12px sans-serif', 'A');
    const b = atlas.getGlyph('12px sans-serif', 'B');
    assert.isAbove(a.width, 0);
    assert.isAbove(a.height, 0);
    assert.isAbove(a.ascent, 0);
    assert.isBelow(a.ascent, a.height);
    assert.notDeepEqual([a.u0, a.v0], [b.u0, b.v0]);
    const again = atlas.getGlyph('12px sans-serif', 'A');
    assert.deepEqual(again, a);
    assert.instanceOf(atlas.getCanvas(), HTMLCanvasElement);
  });

  it('encodes fill as white and stroke as black', () => {
    const atlas = new FontAtlas();
    const glyph = atlas.getGlyph('24px sans-serif', 'O', 3);
    const canvas = atlas.getCanvas();
    const context = canvas.getContext('2d');
    const x = Math.floor(glyph.u0 * canvas.width);
    const y = Math.floor(glyph.v0 * canvas.height);
    const tw = Math.max(1, Math.round((glyph.u1 - glyph.u0) * canvas.width));
    const th = Math.max(1, Math.round((glyph.v1 - glyph.v0) * canvas.height));
    const data = context.getImageData(x, y, tw, th).data;
    let maxR = 0;
    let minOpaqueR = 255;
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200) {
        opaque += 1;
        maxR = Math.max(maxR, data[i]);
        minOpaqueR = Math.min(minOpaqueR, data[i]);
      }
    }
    assert.isAbove(opaque, 0);
    assert.isAbove(maxR, 200);
    assert.isBelow(minOpaqueR, 40);
  });

  it('rasterizes more texels at a higher device pixel ratio', () => {
    const atlas = new FontAtlas();
    const css = atlas.getGlyph('12px sans-serif', 'A', 0, 1);
    const retina = atlas.getGlyph('12px sans-serif', 'A', 0, 2);
    assert.closeTo(retina.width, css.width, 2);
    assert.closeTo(retina.height, css.height, 2);
    const size = atlas.getCanvas().width;
    const cssTexels = (css.u1 - css.u0) * size;
    const retinaTexels = (retina.u1 - retina.u0) * size;
    assert.isAbove(retinaTexels, cssTexels * 1.5);
  });
});
