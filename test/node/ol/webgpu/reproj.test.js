import {assert} from 'chai';
import Polygon from '../../../../src/ol/geom/Polygon.js';
import {fromLonLat, get as getProjection} from '../../../../src/ol/proj.js';
import OSM from '../../../../src/ol/source/OSM.js';
import {createXYZ} from '../../../../src/ol/tilegrid.js';
import {
  buildReprojMesh,
  clipExtentToProjection,
  estimateSourceExtent,
  needsReprojection,
  reprojMeshCacheKey,
  sourceResolutionForView,
  viewCoordinateToSource,
} from '../../../../src/ol/webgpu/reproj.js';

/**
 * @param {{indices: Uint32Array}|null} mesh Mesh.
 * @return {number} Index count.
 */
function meshIndexCount(mesh) {
  return mesh?.indices.length || 0;
}

describe('ol/webgpu/reproj', () => {
  it('detects when source and view projections differ', () => {
    const source = new OSM();
    assert.isFalse(
      needsReprojection(source, /** @type {*} */ (getProjection('EPSG:3857'))),
    );
    assert.isTrue(
      needsReprojection(source, /** @type {*} */ (getProjection('EPSG:4326'))),
    );
  });

  it('includes the target projection in the mesh cache key', () => {
    const source = /** @type {*} */ (getProjection('EPSG:4326'));
    const mercator = /** @type {*} */ (getProjection('EPSG:3857'));
    const geographic = /** @type {*} */ (getProjection('EPSG:4326'));
    const tileCoord = [2, 6, 2];
    assert.notStrictEqual(
      reprojMeshCacheKey(tileCoord, source, mercator),
      reprojMeshCacheKey(tileCoord, source, geographic),
    );
    assert.strictEqual(
      reprojMeshCacheKey(tileCoord, source, mercator),
      reprojMeshCacheKey(tileCoord, source, mercator),
    );
  });

  it('builds a CPU mesh with positions and UVs', () => {
    const sourceProj = getProjection('EPSG:3857');
    const targetProj = getProjection('EPSG:4326');
    const mesh = buildReprojMesh(
      [0, 5000000, 2000000, 7000000],
      /** @type {*} */ (sourceProj),
      /** @type {*} */ (targetProj),
      4,
    );
    assert.isNotNull(mesh);
    assert.strictEqual(mesh?.vertices.length, 5 * 5 * 4);
    assert.strictEqual(mesh?.indices.length, 4 * 4 * 6);
  });

  it('drops mesh quads that span more than a quarter of the target world', () => {
    const sourceProj = getProjection('EPSG:4326');
    const targetProj = getProjection('EPSG:3857');
    const coarse = buildReprojMesh(
      [-180, -80, 180, 80],
      /** @type {*} */ (sourceProj),
      /** @type {*} */ (targetProj),
      1,
    );
    assert.isNotNull(coarse);
    assert.strictEqual(meshIndexCount(coarse), 0);

    const local = buildReprojMesh(
      [10, 40, 20, 50],
      /** @type {*} */ (sourceProj),
      /** @type {*} */ (targetProj),
      2,
    );
    assert.isNotNull(local);
    assert.strictEqual(meshIndexCount(local), 2 * 2 * 6);
  });

  it('keeps a world mercator tile meshed into 4326 without spanning the dateline', () => {
    const sourceProj = getProjection('EPSG:3857');
    const targetProj = getProjection('EPSG:4326');
    const mesh = buildReprojMesh(
      [-20037508, -20037508, 20037508, 20037508],
      /** @type {*} */ (sourceProj),
      /** @type {*} */ (targetProj),
      16,
    );
    assert.isNotNull(mesh);
    assert.isAbove(meshIndexCount(mesh), 0);
    const verts = mesh?.vertices || new Float32Array();
    const indices = mesh?.indices || new Uint32Array();
    const maxEdge = 360 * 0.25;
    for (let i = 0; i < indices.length; i += 3) {
      const ax = verts[indices[i] * 4];
      const ay = verts[indices[i] * 4 + 1];
      const bx = verts[indices[i + 1] * 4];
      const by = verts[indices[i + 1] * 4 + 1];
      const cx = verts[indices[i + 2] * 4];
      const cy = verts[indices[i + 2] * 4 + 1];
      assert.isBelow(Math.hypot(ax - bx, ay - by), maxEdge);
      assert.isBelow(Math.hypot(bx - cx, by - cy), maxEdge);
      assert.isBelow(Math.hypot(cx - ax, cy - ay), maxEdge);
    }
  });

  it('estimates a source extent from a view extent', () => {
    const extent = estimateSourceExtent(
      [-10, -10, 10, 10],
      /** @type {*} */ (getProjection('EPSG:3857')),
      /** @type {*} */ (getProjection('EPSG:4326')),
    );
    assert.isNotNull(extent);
    assert.isBelow(/** @type {number} */ (extent?.[0]), 0);
    assert.isAbove(/** @type {number} */ (extent?.[2]), 0);
  });

  it('clips polar 4326 samples to the mercator world so tile queries stay valid', () => {
    const mercator = /** @type {*} */ (getProjection('EPSG:3857'));
    const geographic = /** @type {*} */ (getProjection('EPSG:4326'));
    const estimated = estimateSourceExtent(
      [-180, -90, 180, 90],
      mercator,
      geographic,
    );
    assert.isNotNull(estimated);
    assert.isAbove(Math.abs(/** @type {number} */ (estimated?.[1])), 3e7);
    const clipped = clipExtentToProjection(
      /** @type {*} */ (estimated),
      mercator,
      true,
    );
    const world = mercator.getExtent();
    assert.isNotNull(clipped);
    assert.isAtLeast(/** @type {number} */ (clipped?.[1]), world[1]);
    assert.isAtMost(/** @type {number} */ (clipped?.[3]), world[3]);
    const mesh = buildReprojMesh(
      /** @type {*} */ (clipped),
      mercator,
      geographic,
      4,
    );
    assert.isNotNull(mesh);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < (mesh?.vertices.length || 0); i += 4) {
      minY = Math.min(minY, mesh.vertices[i]);
      maxY = Math.max(maxY, mesh.vertices[i]);
    }
    assert.isBelow(minY, -80);
    assert.isAbove(maxY, 80);
    assert.isBelow(maxY - minY, 180);
  });

  it('maps a view coordinate into the feature CRS for hit tests', () => {
    const geographic = /** @type {*} */ (getProjection('EPSG:4326'));
    const mercator = /** @type {*} */ (getProjection('EPSG:3857'));
    const polygon = new Polygon([
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ]);
    const viewCoord = fromLonLat([1, 1]);
    assert.isFalse(polygon.containsXY(viewCoord[0], viewCoord[1]));
    const sourceCoord = viewCoordinateToSource(viewCoord, geographic, mercator);
    assert.isNotNull(sourceCoord);
    assert.closeTo(/** @type {number} */ (sourceCoord?.[0]), 1, 1e-6);
    assert.closeTo(/** @type {number} */ (sourceCoord?.[1]), 1, 1e-6);
    assert.isTrue(
      polygon.containsXY(
        /** @type {number} */ (sourceCoord?.[0]),
        /** @type {number} */ (sourceCoord?.[1]),
      ),
    );
    const sameCrs = viewCoordinateToSource([1, 1], geographic, geographic);
    assert.deepEqual(sameCrs, [1, 1]);
  });

  it('maps a 4326 view resolution onto a mercator tile Z near the world scale', () => {
    const mercator = /** @type {*} */ (getProjection('EPSG:3857'));
    const geographic = /** @type {*} */ (getProjection('EPSG:4326'));
    const viewRes = 0.3;
    const sourceRes = sourceResolutionForView(
      mercator,
      geographic,
      [0, 0],
      viewRes,
    );
    const grid = createXYZ({
      extent: mercator.getExtent() || undefined,
      tileSize: 512,
      maxZoom: 20,
    });
    assert.isAbove(grid.getZForResolution(viewRes), 10);
    assert.isBelow(grid.getZForResolution(sourceRes), 5);
  });
});
