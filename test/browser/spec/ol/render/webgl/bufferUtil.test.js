import {assert} from 'chai';
import {
  filterTrianglesByTargetEdge,
  unwrapFlatCoordinatesX,
  writeLineSegmentToBuffers,
  writePointFeatureToBuffers,
  writePolygonTrianglesToBuffers,
} from '../../../../../../src/ol/render/webgl/bufferUtil.js';
import {
  compose as composeTransform,
  create as createTransform,
  makeInverse as makeInverseTransform,
} from '../../../../../../src/ol/transform.js';

describe('webgl buffer generation utils', function () {
  describe('writePointFeatureToBuffers', function () {
    let instanceAttributesBuffer, instructions;

    beforeEach(function () {
      instanceAttributesBuffer = new Float32Array(100);
      instructions = new Float32Array(100);

      instructions.set([0, 0, 0, 0, 10, 11]);
    });

    it('writes correctly to the buffers (without custom attributes)', function () {
      const stride = 2;
      const positions = writePointFeatureToBuffers(
        instructions,
        4,
        instanceAttributesBuffer,
        0,
      );

      assert.deepEqual(instanceAttributesBuffer[0], 10);
      assert.deepEqual(instanceAttributesBuffer[1], 11);

      assert.deepEqual(positions.instanceAttributesPosition, stride);
    });

    it('writes correctly to the buffers (with 2 custom attributes)', function () {
      instructions.set([0, 0, 0, 0, 0, 0, 0, 0, 10, 11, 12, 13]);
      const stride = 4;
      const positions = writePointFeatureToBuffers(
        instructions,
        8,
        instanceAttributesBuffer,
        2,
      );

      assert.deepEqual(instanceAttributesBuffer[0], 10);
      assert.deepEqual(instanceAttributesBuffer[1], 11);
      assert.deepEqual(instanceAttributesBuffer[2], 12);
      assert.deepEqual(instanceAttributesBuffer[3], 13);

      assert.deepEqual(positions.instanceAttributesPosition, stride);
    });

    it('correctly chains buffer writes', function () {
      instructions.set([10, 11, 20, 21, 30, 31]);
      const stride = 2;
      let positions = writePointFeatureToBuffers(
        instructions,
        0,
        instanceAttributesBuffer,
        0,
      );
      positions = writePointFeatureToBuffers(
        instructions,
        2,
        instanceAttributesBuffer,
        0,
        positions,
      );
      positions = writePointFeatureToBuffers(
        instructions,
        4,
        instanceAttributesBuffer,
        0,
        positions,
      );

      assert.deepEqual(instanceAttributesBuffer[0], 10);
      assert.deepEqual(instanceAttributesBuffer[1], 11);

      assert.deepEqual(instanceAttributesBuffer[stride + 0], 20);
      assert.deepEqual(instanceAttributesBuffer[stride + 1], 21);

      assert.deepEqual(instanceAttributesBuffer[stride * 2 + 0], 30);
      assert.deepEqual(instanceAttributesBuffer[stride * 2 + 1], 31);

      assert.deepEqual(positions.instanceAttributesPosition, stride * 3);
    });
  });

  describe('writeLineSegmentToBuffers', function () {
    let instanceAttributesArray, instructions;
    let instructionsTransform, invertInstructionsTransform;
    let currentLength, currentAngleTangentSum;

    beforeEach(function () {
      instanceAttributesArray = [];
      instructions = new Float32Array(100);

      instructionsTransform = createTransform();
      invertInstructionsTransform = createTransform();
      composeTransform(instructionsTransform, 0, 0, 10, 10, 0, -50, 200);
      makeInverseTransform(invertInstructionsTransform, instructionsTransform);
    });

    describe('isolated segment', function () {
      beforeEach(function () {
        instructions.set([0, 0, 10, 0, 2, 20, 5, 5, 30, 25, 5, 40]);
        const result = writeLineSegmentToBuffers(
          instructions,
          6,
          9,
          null,
          null,
          instanceAttributesArray,
          [],
          invertInstructionsTransform,
          100,
          100,
        );
        currentLength = result.length;
        currentAngleTangentSum = result.angle;
      });
      // we expect one quad with 10 attributes each:
      // Xstart, Ystart, Mstart, Xend, Yend, Mend, joinAngleStart, joinAngleEnd, distance (low part), distance (high part) angle tangent sum
      it('generates a quad for the segment', function () {
        assert.deepEqual(
          instanceAttributesArray,
          [5, 5, 30, 25, 5, 40, -1, -1, 100, 0, 100],
        );
      });
      it('computes the new current length', () => {
        assert.deepEqual(currentLength, 102);
      });
      it('angle tangent sum stays the same', () => {
        assert.deepEqual(currentAngleTangentSum, 100);
      });
    });

    describe('isolated segment with custom attributes', function () {
      beforeEach(function () {
        instructions.set([888, 999, 2, 5, 5, 30, 25, 5, 40]);
        const result = writeLineSegmentToBuffers(
          instructions,
          3,
          6,
          null,
          null,
          instanceAttributesArray,
          [888, 999],
          invertInstructionsTransform,
          100,
          100,
        );
        currentLength = result.length;
        currentAngleTangentSum = result.angle;
      });
      // we expect 4 vertices (one quad) with 10 attributes each:
      // Xstart, Ystart, Xend, Yend, joinAngleStart, joinAngleEnd, distance (low part), distance (high part), vertex number (0..3), + 2 custom attributes
      it('adds custom attributes in the vertices buffer', function () {
        assert.deepEqual(
          instanceAttributesArray,
          [5, 5, 30, 25, 5, 40, -1, -1, 100, 0, 100, 888, 999],
        );
      });
      it('computes the new current length', () => {
        assert.deepEqual(currentLength, 102);
      });
      it('angle tangent sum stays the same', () => {
        assert.deepEqual(currentAngleTangentSum, 100);
      });
    });

    describe('segment with a point coming before it, join angle < PI', function () {
      beforeEach(function () {
        instructions.set([2, 5, 5, 0, 25, 5, 0, 5, 20, 0]);
        const result = writeLineSegmentToBuffers(
          instructions,
          1,
          4,
          7,
          null,
          instanceAttributesArray,
          [],
          invertInstructionsTransform,
          0,
          10,
        );
        currentAngleTangentSum = result.angle;
      });
      it('generate the correct amount of vertices', () => {
        assert.lengthOf(instanceAttributesArray, 11);
      });
      it('correctly encodes the join angles', () => {
        assert.deepEqual(instanceAttributesArray.slice(6, 8), [
          Math.PI / 2,
          -1,
        ]);
      });
      it('angle tangent sum decreases by one', () => {
        assert.approximately(currentAngleTangentSum, 9, 1e-9);
      });
    });

    describe('segment with a point coming before it, join angle > PI', function () {
      beforeEach(function () {
        instructions.set([2, 5, 5, 25, 5, 5, -10]);
        const result = writeLineSegmentToBuffers(
          instructions,
          1,
          3,
          5,
          null,
          instanceAttributesArray,
          [],
          invertInstructionsTransform,
          0,
          10,
        );
        currentAngleTangentSum = result.angle;
      });
      it('generate the correct amount of vertices', () => {
        assert.lengthOf(instanceAttributesArray, 11);
      });
      it('correctly encodes the join angle', () => {
        assert.deepEqual(instanceAttributesArray.slice(6, 8), [
          (Math.PI * 3) / 2,
          -1,
        ]);
      });
      it('angle tangent sum increases by one', () => {
        assert.approximately(currentAngleTangentSum, 11, 1e-9);
      });
    });

    describe('segment with a point coming after it, join angle > PI', function () {
      beforeEach(function () {
        instructions.set([2, 5, 5, 25, 5, 5, 25]);
        const result = writeLineSegmentToBuffers(
          instructions,
          1,
          3,
          null,
          5,
          instanceAttributesArray,
          [],
          invertInstructionsTransform,
          0,
          10,
        );
        currentAngleTangentSum = result.angle;
      });
      it('generate the correct amount of vertices', () => {
        assert.lengthOf(instanceAttributesArray, 11);
      });
      it('correctly encodes the join angle', () => {
        assert.deepEqual(instanceAttributesArray.slice(6, 8), [
          -1,
          (Math.PI * 7) / 4,
        ]);
      });
      it('angle tangent sum decreases', () => {
        assert.approximately(
          currentAngleTangentSum,
          10 - (1 + Math.sqrt(2)),
          1e-9,
        );
      });
    });

    describe('segment with a point coming after it, join angle < PI', function () {
      beforeEach(function () {
        instructions.set([2, 5, 5, 25, 5, 25, -10]);
        const result = writeLineSegmentToBuffers(
          instructions,
          1,
          3,
          null,
          5,
          instanceAttributesArray,
          [],
          invertInstructionsTransform,
          0,
          10,
        );
        currentAngleTangentSum = result.angle;
      });
      it('generate the correct amount of vertices', () => {
        assert.lengthOf(instanceAttributesArray, 11);
      });
      it('correctly encodes join angles', () => {
        assert.deepEqual(instanceAttributesArray.slice(6, 8), [
          -1,
          Math.PI / 2,
        ]);
      });
      it('angle tangent sum increases', () => {
        assert.approximately(currentAngleTangentSum, 11, 1e-9);
      });
    });

    describe('segment with zero length', function () {
      beforeEach(function () {
        instructions.set([-10, -10, 5, 5, 5, 5, 10, 10]);
        const result = writeLineSegmentToBuffers(
          instructions,
          2,
          4,
          0,
          6,
          instanceAttributesArray,
          [],
          invertInstructionsTransform,
          0,
          10,
        );
        currentAngleTangentSum = result.angle;
      });
      it('generate the correct amount of vertices', () => {
        assert.lengthOf(instanceAttributesArray, 11);
      });
      it('do not use zero or 2PI for both angles', () => {
        assert.notDeepEqual(instanceAttributesArray.slice(6, 8), [
          Math.PI * 2,
          Math.PI * 2,
        ]);
        assert.notDeepEqual(instanceAttributesArray.slice(6, 8), [0, 0]);
      });
    });

    describe('colinear segment', function () {
      beforeEach(function () {
        instructions.set([-10, -10, 5, 5, -5, -5, -15, 5]);
        const result = writeLineSegmentToBuffers(
          instructions,
          2,
          4,
          0,
          6,
          instanceAttributesArray,
          [],
          invertInstructionsTransform,
          0,
          10,
        );
        currentAngleTangentSum = result.angle;
      });
      it('generate the correct amount of vertices', () => {
        assert.lengthOf(instanceAttributesArray, 11);
      });
      it('do not use zero or 2PI for the first angle', () => {
        assert.notDeepEqual(instanceAttributesArray[6], Math.PI * 2);
        assert.notDeepEqual(instanceAttributesArray[6], 0);
        assert.deepEqual(instanceAttributesArray[7], Math.PI / 2);
      });
    });
  });

  describe('writePolygonTrianglesToBuffers', function () {
    let vertexArray, indexArray, instructions, newIndex;

    beforeEach(function () {
      vertexArray = [];
      indexArray = [];
      instructions = new Float32Array(100);
    });

    describe('polygon with a hole', function () {
      beforeEach(function () {
        instructions.set([
          0, 0, 0, 2, 6, 5, 0, 0, 10, 0, 15, 6, 10, 12, 0, 12, 0, 0, 3, 3, 5, 1,
          7, 3, 5, 5, 3, 3,
        ]);
        newIndex = writePolygonTrianglesToBuffers(
          instructions,
          3,
          vertexArray,
          indexArray,
          0,
        );
      });
      it('generates triangles correctly', function () {
        assert.lengthOf(vertexArray, 22);
        assert.deepEqual(
          vertexArray,
          [
            0, 0, 10, 0, 15, 6, 10, 12, 0, 12, 0, 0, 3, 3, 5, 1, 7, 3, 5, 5, 3,
            3,
          ],
        );
        assert.lengthOf(indexArray, 24);
        assert.deepEqual(
          indexArray,
          [
            4, 0, 9, 4, 9, 8, 7, 10, 0, 7, 0, 1, 7, 1, 2, 2, 3, 4, 2, 4, 8, 2,
            8, 7,
          ],
        );
      });
      it('correctly returns the new index', function () {
        assert.deepEqual(newIndex, 28);
      });
    });

    describe('polygon with a hole and custom attributes', function () {
      beforeEach(function () {
        instructions.set([
          0, 0, 0, 1234, 2, 6, 5, 0, 0, 10, 0, 15, 6, 10, 12, 0, 12, 0, 0, 3, 3,
          5, 1, 7, 3, 5, 5, 3, 3,
        ]);
        newIndex = writePolygonTrianglesToBuffers(
          instructions,
          3,
          vertexArray,
          indexArray,
          1,
        );
      });
      it('generates triangles correctly', function () {
        assert.lengthOf(vertexArray, 33);
        assert.deepEqual(
          vertexArray,
          [
            0, 0, 1234, 10, 0, 1234, 15, 6, 1234, 10, 12, 1234, 0, 12, 1234, 0,
            0, 1234, 3, 3, 1234, 5, 1, 1234, 7, 3, 1234, 5, 5, 1234, 3, 3, 1234,
          ],
        );
        assert.lengthOf(indexArray, 24);
        assert.deepEqual(
          indexArray,
          [
            4, 0, 9, 4, 9, 8, 7, 10, 0, 7, 0, 1, 7, 1, 2, 2, 3, 4, 2, 4, 8, 2,
            8, 7,
          ],
        );
      });
      it('correctly returns the new index', function () {
        assert.deepEqual(newIndex, 29);
      });
    });

    describe('maxTriangleEdgeLength filter', function () {
      it('skips triangles that cross the antimeridian in X', function () {
        instructions.set([1, 3, 170, 0, -170, 0, 0, 10]);
        writePolygonTrianglesToBuffers(
          instructions,
          0,
          vertexArray,
          indexArray,
          0,
          180,
        );
        assert.lengthOf(vertexArray, 6);
        assert.lengthOf(indexArray, 0);
      });

      it('keeps wide triangles that do not wrap in X', function () {
        // Width 150° < half-world (180°), so edges are kept.
        instructions.set([1, 4, -75, 0, 75, 0, 75, 10, -75, 10]);
        writePolygonTrianglesToBuffers(
          instructions,
          0,
          vertexArray,
          indexArray,
          0,
          180,
        );
        assert.isAbove(indexArray.length, 0);
      });

      it('clips triangles that straddle clipExtent instead of dropping them', function () {
        instructions.set([1, 3, 0, 70, 10, 70, 5, -80]);
        writePolygonTrianglesToBuffers(
          instructions,
          0,
          vertexArray,
          indexArray,
          0,
          0,
          [-180, 40, 180, 90],
        );
        assert.isAbove(indexArray.length, 0);
        // Referenced vertices (incl. Steiner) must lie in the clip extent.
        for (let i = 0; i < indexArray.length; i++) {
          const y = vertexArray[indexArray[i] * 2 + 1];
          assert.isAtLeast(y, 40);
          assert.isAtMost(y, 90);
        }
      });

      it('drops triangles entirely outside clipExtent', function () {
        instructions.set([1, 3, 0, -80, 10, -80, 5, -70]);
        writePolygonTrianglesToBuffers(
          instructions,
          0,
          vertexArray,
          indexArray,
          0,
          0,
          [-180, 40, 180, 90],
        );
        assert.lengthOf(indexArray, 0);
      });

      it('keeps dateline triangles when rings are unwrapped for earcut', function () {
        instructions.set([1, 3, 170, 0, -170, 0, 180, 10]);
        writePolygonTrianglesToBuffers(
          instructions,
          0,
          vertexArray,
          indexArray,
          0,
          180,
          null,
          180,
          360,
        );
        assert.lengthOf(vertexArray, 6);
        assert.lengthOf(indexArray, 3);
        assert.equal(vertexArray[0], 170);
        assert.equal(vertexArray[2], 190);
      });

      it('triangulates in target space when projectToTarget is set', function () {
        // Nonlinear X warp: source earcut of a concave C would leave a mouth
        // diagonal that folds after warp. Target-space earcut avoids it.
        // C opening to +X; warp stretches X by y so the mouth diagonal bows.
        instructions.set([
          1, 8, 0, 0, 4, 0, 4, 1, 2, 1, 2, 3, 4, 3, 4, 4, 0, 4,
        ]);
        const project = (c) => [c[0] * (1 + c[1]), c[1]];
        writePolygonTrianglesToBuffers(
          instructions,
          0,
          vertexArray,
          indexArray,
          0,
          0,
          null,
          undefined,
          0,
          project,
        );
        assert.isAbove(indexArray.length, 0);
        // Sample in the C opening (source); after warp the GPU triangle of a
        // source-space mouth diagonal would cover it — target earcut must not.
        const open = project([3, 2]);
        function pointInTri(p, a, b, c) {
          const v0x = c[0] - a[0];
          const v0y = c[1] - a[1];
          const v1x = b[0] - a[0];
          const v1y = b[1] - a[1];
          const v2x = p[0] - a[0];
          const v2y = p[1] - a[1];
          const dot00 = v0x * v0x + v0y * v0y;
          const dot01 = v0x * v1x + v0y * v1y;
          const dot02 = v0x * v2x + v0y * v2y;
          const dot11 = v1x * v1x + v1y * v1y;
          const dot12 = v1x * v2x + v1y * v2y;
          const inv = 1 / (dot00 * dot11 - dot01 * dot01);
          const u = (dot11 * dot02 - dot01 * dot12) * inv;
          const v = (dot00 * dot12 - dot01 * dot02) * inv;
          return u >= 0 && v >= 0 && u + v <= 1;
        }
        let covered = false;
        for (let i = 0; i < indexArray.length; i += 3) {
          const a = project([
            vertexArray[indexArray[i] * 2],
            vertexArray[indexArray[i] * 2 + 1],
          ]);
          const b = project([
            vertexArray[indexArray[i + 1] * 2],
            vertexArray[indexArray[i + 1] * 2 + 1],
          ]);
          const c = project([
            vertexArray[indexArray[i + 2] * 2],
            vertexArray[indexArray[i + 2] * 2 + 1],
          ]);
          if (pointInTri(open, a, b, c)) {
            covered = true;
            break;
          }
        }
        assert.isFalse(covered);
      });
    });
  });

  describe('unwrapFlatCoordinatesX', function () {
    it('unwraps a jump across the dateline', function () {
      const out = unwrapFlatCoordinatesX([170, 0, -170, 0], 180, 360);
      assert.equal(out[0], 170);
      assert.equal(out[2], 190);
    });
  });

  describe('filterTrianglesByTargetEdge', function () {
    it('drops triangles whose long edges fold across a projection cut', function () {
      // Nonlinear warp: midpoint jumps away from the chord (cut / UV clamp).
      const refined = filterTrianglesByTargetEdge(
        [0, 0, 1, 0, 0, 1],
        [0, 1, 2],
        2,
        (c) => {
          if (Math.abs(c[0] - 0.5) < 1e-9 && Math.abs(c[1]) < 1e-9) {
            return [0, 1000];
          }
          return [c[0] * 1000, c[1]];
        },
        100,
      );
      assert.lengthOf(refined.indices, 0);
    });

    it('keeps long but smooth earcut diagonals (hole → outer ring)', function () {
      // Linear warp: long edges stay; midpoint matches the chord.
      // Must not drop — that left fan gaps from holes in EPSG:23032.
      const refined = filterTrianglesByTargetEdge(
        [0, 0, 10, 0, 0, 10],
        [0, 1, 2],
        2,
        (c) => [c[0] * 100, c[1] * 100],
        50,
      );
      assert.deepEqual(Array.from(refined.indices), [0, 1, 2]);
    });

    it('keeps long needle slivers (no source-space splits)', function () {
      // Splitting in source space under nonlinear warp created fan gaps.
      const refined = filterTrianglesByTargetEdge(
        [0, 0, 100, 0, 50, 0.1],
        [0, 1, 2],
        2,
        (c) => c.slice(),
        10,
      );
      assert.deepEqual(Array.from(refined.indices), [0, 1, 2]);
    });

    it('keeps triangles within the target edge limit', function () {
      const refined = filterTrianglesByTargetEdge(
        [0, 0, 1, 0, 0, 1],
        [0, 1, 2],
        2,
        (c) => c.slice(),
        10,
      );
      assert.deepEqual(Array.from(refined.indices), [0, 1, 2]);
      assert.deepEqual(Array.from(refined.vertices), [0, 0, 1, 0, 0, 1]);
    });
  });
});
