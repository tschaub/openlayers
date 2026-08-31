import {assert} from 'chai';
import {getTransform} from '../../../../../src/ol/proj.js';
import {
  filterTrianglesByTargetEdge,
  tessellatePolygon,
} from '../../../../../src/ol/render/webgpu/tessellate.js';

describe('ol/render/webgpu/tessellate', () => {
  it('earcuts without reprojection options (same as the old fill path)', () => {
    const mesh = tessellatePolygon([0, 0, 2, 0, 2, 2, 0, 2], []);
    assert.strictEqual(mesh.indices.length, 6);
    assert.strictEqual(mesh.vertices.length, 8);
  });

  it('clips triangles that extend outside the target extent', () => {
    const mesh = tessellatePolygon([0, 0, 10, 0, 5, 20], [], {
      clipExtent: [0, 0, 10, 10],
    });
    assert.isAbove(mesh.indices.length, 0);
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      assert.isAtMost(mesh.vertices[i + 1], 10);
    }
  });

  it('projects vertices into the target CRS before earcut', () => {
    const transformFn = getTransform('EPSG:4326', 'EPSG:3857');
    const mesh = tessellatePolygon([0, 0, 1, 0, 1, 1, 0, 1], [], {
      projectToTarget: (coord) => {
        const projected = transformFn(coord);
        return [projected[0], projected[1]];
      },
    });
    assert.strictEqual(mesh.indices.length, 6);
    assert.closeTo(mesh.vertices[0], 0, 1e-6);
    assert.closeTo(mesh.vertices[1], 0, 1e-6);
    assert.isAbove(mesh.vertices[2], 100000);
  });

  it('drops a folding triangle whose midpoint does not follow the warp', () => {
    const sourceXY = [0, 0, 1, 0, 0.5, 1];
    const indices = [0, 1, 2];
    const projectToTarget = (coord) => {
      if (coord[0] === 0.5 && coord[1] === 0) {
        return [1000, 0];
      }
      return [coord[0], coord[1]];
    };
    const filtered = filterTrianglesByTargetEdge(
      sourceXY,
      indices,
      projectToTarget,
      0.5,
    );
    assert.deepEqual(filtered, []);
  });

  it('keeps long but smooth earcut diagonals (hole → outer ring)', () => {
    const filtered = filterTrianglesByTargetEdge(
      [0, 0, 10, 0, 0, 10],
      [0, 1, 2],
      (coord) => [coord[0] * 100, coord[1] * 100],
      50,
    );
    assert.deepEqual(filtered, [0, 1, 2]);
  });

  it('keeps long needle slivers (no source-space splits)', () => {
    const filtered = filterTrianglesByTargetEdge(
      [0, 0, 100, 0, 50, 0.1],
      [0, 1, 2],
      (coord) => [coord[0], coord[1]],
      10,
    );
    assert.deepEqual(filtered, [0, 1, 2]);
  });

  it('skips antimeridian-spanning source triangles', () => {
    const mesh = tessellatePolygon([0, 0, 200, 0, 200, 1, 0, 1], [], {
      maxSpanX: 100,
    });
    assert.deepEqual(mesh.indices, []);
  });

  it('drops folding triangles during tessellation', () => {
    const mesh = tessellatePolygon([0, 0, 1, 0, 0.5, 1], [], {
      projectToTarget: (coord) => {
        if (coord[0] === 0.5 && coord[1] === 0) {
          return [1000, 0];
        }
        return [coord[0], coord[1]];
      },
      maxTargetEdge: 0.5,
    });
    assert.deepEqual(mesh.indices, []);
  });
});
