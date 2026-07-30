import {assert} from 'chai';
import {
  clipFlatPolygonToExtent,
  clipFlatRingToExtent,
  clipFlatTriangleToExtent,
} from '../../../../../../src/ol/geom/flat/clip.js';

describe('ol/geom/flat/clip', () => {
  describe('clipFlatRingToExtent', () => {
    it('clips a ring that extends past one side of the extent', () => {
      // Unit square extending below y=0.5
      const ring = [0, 0, 1, 0, 1, 1, 0, 1];
      const clipped = clipFlatRingToExtent(ring, [0, 0.5, 1, 1]);
      assert.isAtLeast(clipped.length / 2, 3);
      for (let i = 0; i < clipped.length; i += 2) {
        assert.isAtLeast(clipped[i + 1], 0.5);
      }
    });

    it('returns empty when the ring is outside the extent', () => {
      const ring = [0, 0, 1, 0, 1, 1, 0, 1];
      assert.deepEqual(clipFlatRingToExtent(ring, [2, 2, 3, 3]), []);
    });
  });

  describe('clipFlatTriangleToExtent', () => {
    it('fan-triangulates the clipped convex polygon', () => {
      const tris = clipFlatTriangleToExtent(0, 0, 10, 0, 5, 10, [0, 2, 10, 10]);
      assert.isAbove(tris.length, 0);
      assert.strictEqual(tris.length % 6, 0);
      for (let i = 0; i < tris.length; i += 2) {
        assert.isAtLeast(tris[i + 1], 2);
      }
    });

    it('returns empty when the triangle is outside', () => {
      assert.deepEqual(
        clipFlatTriangleToExtent(0, 0, 1, 0, 0, 1, [5, 5, 6, 6]),
        [],
      );
    });
  });

  describe('clipFlatPolygonToExtent', () => {
    it('preserves holes that remain fully inside the clip', () => {
      const flat = [
        0,
        0,
        4,
        0,
        4,
        4,
        0,
        4, // outer
        1,
        1,
        2,
        1,
        2,
        2,
        1,
        2, // hole
      ];
      const clipped = clipFlatPolygonToExtent(flat, [4], [-1, -1, 5, 5]);
      assert.isNotNull(clipped);
      assert.lengthOf(clipped.holes, 1);
      assert.isAbove(clipped.flatCoordinates.length, 8);
    });

    it('drops holes that cross the clip boundary', () => {
      const flat = [
        0,
        0,
        10,
        0,
        10,
        10,
        0,
        10, // outer
        1,
        4,
        4,
        4,
        4,
        6,
        1,
        6, // hole straddling x=2
      ];
      const clipped = clipFlatPolygonToExtent(flat, [4], [2, 0, 10, 10]);
      assert.isNotNull(clipped);
      assert.lengthOf(clipped.holes, 0);
    });

    it('returns null when the outer ring misses the extent', () => {
      const flat = [0, 0, 1, 0, 1, 1, 0, 1];
      assert.isNull(clipFlatPolygonToExtent(flat, [], [2, 2, 3, 3]));
    });
  });
});
