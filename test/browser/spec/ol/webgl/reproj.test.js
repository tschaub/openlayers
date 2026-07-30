import {assert} from 'chai';
import proj4 from 'proj4';
import Map from '../../../../../src/ol/Map.js';
import View from '../../../../../src/ol/View.js';
import {getWidth} from '../../../../../src/ol/extent.js';
import {densifyFlatCoordinates} from '../../../../../src/ol/geom/flat/densify.js';
import WebGLTileLayer from '../../../../../src/ol/layer/WebGLTile.js';
import {
  addCommon,
  clearAllProjections,
  get as getProjection,
  getTransform,
  transform,
  transformExtent,
} from '../../../../../src/ol/proj.js';
import {register} from '../../../../../src/ol/proj/proj4.js';
import DataTileSource from '../../../../../src/ol/source/DataTile.js';
import OSM from '../../../../../src/ol/source/OSM.js';
import LRUCache from '../../../../../src/ol/structs/LRUCache.js';
import {createXYZ} from '../../../../../src/ol/tilegrid.js';
import {create as createTransform} from '../../../../../src/ol/transform.js';
import Mesh from '../../../../../src/ol/webgl/reproj/Mesh.js';
import WarpField from '../../../../../src/ol/webgl/reproj/WarpField.js';
import {
  buildSourceTargetGrid,
  projectSourceToTarget,
  sampleGrid,
} from '../../../../../src/ol/webgl/reproj/grid.js';
import {
  calculateFinestSourceExtentResolution,
  createTileMesh,
  estimateSourceExtentForView,
  getSourceTileQuery,
  getSourceTileRefs,
  needsReprojection,
  padSourceExtentForWarp,
  targetAllowsUnwrappedSourceX,
} from '../../../../../src/ol/webgl/reproj/util.js';

describe('ol/webgl/reproj', () => {
  /** @type {Map} */
  let map, mapR;
  let target, targetR;
  let loader;

  beforeEach(() => {
    target = document.createElement('div');
    target.style.width = '256px';
    target.style.height = '256px';
    document.body.appendChild(target);

    targetR = document.createElement('div');
    targetR.style.width = '256px';
    targetR.style.height = '256px';
    document.body.appendChild(targetR);

    const size = 256;
    loader = (z, x, y) => {
      const output = new Uint8Array(size * size * 4);
      for (let j = 0; j < size; ++j) {
        for (let i = 0; i < size; ++i) {
          const offset = (j * size + i) * 4;
          output[offset] = i;
          output[offset + 1] = j;
          output[offset + 2] = (i + x) % 2 === 0 ? i : size - 1 - i;
          output[offset + 3] = (j + x) % 2 === 0 ? size - 1 - j : j;
        }
      }
      return output;
    };
  });

  afterEach(() => {
    disposeMap(map, target);
    disposeMap(mapR, targetR);
    delete proj4.defs['EPSG:32632'];
    delete proj4.defs['EPSG:32636'];
    clearAllProjections();
    addCommon();
  });

  describe('Mesh', () => {
    it('builds a non-empty mesh for a source tile extent', () => {
      const sourceProj = getProjection('EPSG:4326');
      const targetProj = getProjection('EPSG:3857');
      const mesh = new Mesh({
        sourceProj,
        targetProj,
        sourceExtent: [0, 0, 90, 45],
        sourceResolution: 90 / 256,
      });
      assert.isFalse(mesh.isEmpty());
      assert.isAbove(mesh.getIndexCount(), 0);
    });

    it('shares exact target vertices along adjacent tile edges', () => {
      const sourceProj = getProjection('EPSG:4326');
      const targetProj = getProjection('EPSG:3857');
      const resolution = 90 / 256;
      const left = new Mesh({
        sourceProj,
        targetProj,
        sourceExtent: [0, 0, 90, 45],
        sourceResolution: resolution,
      });
      const right = new Mesh({
        sourceProj,
        targetProj,
        sourceExtent: [90, 0, 180, 45],
        sourceResolution: resolution,
      });
      const leftVerts = left.vertices.getArray();
      const rightVerts = right.vertices.getArray();
      // Right edge of left tile (source x = 90) vs left edge of right tile.
      /** @type {Array<string>} */
      const leftEdge = [];
      /** @type {Array<string>} */
      const rightEdge = [];
      for (let i = 0; i < leftVerts.length; i += 4) {
        if (leftVerts[i + 2] === 90) {
          leftEdge.push(`${leftVerts[i]},${leftVerts[i + 1]}`);
        }
      }
      for (let i = 0; i < rightVerts.length; i += 4) {
        if (rightVerts[i + 2] === 90) {
          rightEdge.push(`${rightVerts[i]},${rightVerts[i + 1]}`);
        }
      }
      assert.deepEqual(leftEdge, rightEdge);
      assert.isAbove(leftEdge.length, 1);
    });

    it('createTileMesh overlaps adjacent tiles by half a source pixel', () => {
      const sourceProj = getProjection('EPSG:4326');
      const targetProj = getProjection('EPSG:3857');
      const resolution = 90 / 256;
      const left = createTileMesh({
        sourceProj,
        targetProj,
        sourceTileExtent: [0, 0, 90, 45],
        sourceResolution: resolution,
      });
      const right = createTileMesh({
        sourceProj,
        targetProj,
        sourceTileExtent: [90, 0, 180, 45],
        sourceResolution: resolution,
      });
      assert.isNotNull(left);
      assert.isNotNull(right);
      const leftVerts = left.vertices.getArray();
      const rightVerts = right.vertices.getArray();
      let leftMaxX = -Infinity;
      let rightMinX = Infinity;
      for (let i = 0; i < leftVerts.length; i += 4) {
        leftMaxX = Math.max(leftMaxX, leftVerts[i + 2]);
      }
      for (let i = 0; i < rightVerts.length; i += 4) {
        rightMinX = Math.min(rightMinX, rightVerts[i + 2]);
      }
      // Expanded grids must overlap across the shared tile boundary at x=90.
      assert.isAbove(leftMaxX, 90);
      assert.isBelow(rightMinX, 90);
      assert.approximately(leftMaxX - 90, resolution * 0.5, 1e-9);
      assert.approximately(90 - rightMinX, resolution * 0.5, 1e-9);
    });

    it('skips edge buffers by default', () => {
      const mesh = new Mesh({
        sourceProj: getProjection('EPSG:4326'),
        targetProj: getProjection('EPSG:3857'),
        sourceExtent: [0, 0, 90, 45],
        sourceResolution: 90 / 256,
      });
      assert.isNull(mesh.edgeVertices);
      assert.equal(mesh.getEdgeVertexCount(), 0);
    });

    it('builds edge buffers when requested', () => {
      const mesh = new Mesh({
        sourceProj: getProjection('EPSG:4326'),
        targetProj: getProjection('EPSG:3857'),
        sourceExtent: [0, 0, 90, 45],
        sourceResolution: 90 / 256,
        buildEdges: true,
      });
      assert.isNotNull(mesh.edgeVertices);
      assert.isAbove(mesh.getEdgeVertexCount(), 0);
    });

    it('keeps mercator dateline tile edges in the eastern hemisphere', () => {
      proj4.defs(
        'ESRI:54009',
        '+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
      );
      register(proj4);
      const sourceProj = getProjection('EPSG:3857');
      const targetProj = getProjection('ESRI:54009');
      targetProj.setExtent([-18e6, -9e6, 18e6, 9e6]);
      // Easternmost OSM tile at z=3 (touches mercator max-x / lon 180).
      const sourceExtent = [
        15028131.257091936, -10018754.17139462, 20037508.342789248,
        -5009377.085697309,
      ];
      const mesh = new Mesh({
        sourceProj,
        targetProj,
        sourceExtent,
        sourceResolution: 78271.51696402048,
      });
      assert.isFalse(mesh.isEmpty());
      const verts = mesh.vertices.getArray();
      const indices = mesh.indices.getArray();
      const halfWorld = 18e6;
      let maxEdge = 0;
      for (let i = 0; i < indices.length; i += 3) {
        for (const [a, b] of [
          [indices[i], indices[i + 1]],
          [indices[i + 1], indices[i + 2]],
          [indices[i + 2], indices[i]],
        ]) {
          const len = Math.hypot(
            verts[a * 4] - verts[b * 4],
            verts[a * 4 + 1] - verts[b * 4 + 1],
          );
          if (len > maxEdge) {
            maxEdge = len;
          }
        }
      }
      assert.isBelow(maxEdge, halfWorld, 'no triangle may cross the cut');
      // Eastern source edge must project to positive Mollweide X.
      for (let i = 0; i < verts.length; i += 4) {
        if (verts[i + 2] === sourceExtent[2]) {
          assert.isAbove(verts[i], 0);
        }
      }
    });

    it('includes northernmost mercator tiles for a wide north-polar view', () => {
      proj4.defs(
        'EPSG:3413',
        '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 ' +
          '+x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
      );
      register(proj4);
      const targetProj = getProjection('EPSG:3413');
      const targetExtent = [-4194304, -4194304, 4194304, 4194304];
      targetProj.setExtent(targetExtent);
      const sourceProj = getProjection('EPSG:3857');
      const sourceExtent = estimateSourceExtentForView(
        targetExtent,
        sourceProj,
        targetProj,
      );
      assert.isNotNull(sourceExtent);
      const grid = createXYZ();
      const topTileMinY = grid.getTileCoordExtent([4, 0, 0])[1];
      assert.isAtLeast(
        sourceExtent[3],
        topTileMinY,
        'estimate must reach the y=0 mercator row',
      );
      const osm = new OSM();
      const viewResolution = (targetExtent[2] - targetExtent[0]) / 1024;
      const query = getSourceTileQuery(
        osm,
        targetProj,
        targetExtent,
        viewResolution,
      );
      assert.isNotNull(query);
      const refs = getSourceTileRefs(
        osm,
        sourceProj,
        query.sourceExtent,
        query.z,
      );
      assert.isTrue(
        refs.some((ref) => ref.y === 0),
        'wide polar view must load northernmost source tiles',
      );
    });

    it('includes both dateline columns for a wide panned north-polar view', () => {
      proj4.defs(
        'EPSG:3413',
        '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 ' +
          '+x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
      );
      register(proj4);
      const targetProj = getProjection('EPSG:3413');
      targetProj.setExtent([-4194304, -4194304, 4194304, 4194304]);
      const sourceProj = getProjection('EPSG:3857');
      const resolution = 4885.091942062713;
      const center = [90148.15095, 275317.38035];
      // Wide short viewport: center rings alone can miss one antimeridian
      // column and leave a radial white wedge.
      const width = 1576;
      const height = 400;
      const viewExtent = [
        center[0] - (width * resolution) / 2,
        center[1] - (height * resolution) / 2,
        center[0] + (width * resolution) / 2,
        center[1] + (height * resolution) / 2,
      ];
      const osm = new OSM();
      const query = getSourceTileQuery(osm, targetProj, viewExtent, resolution);
      assert.isNotNull(query);
      const refs = getSourceTileRefs(
        osm,
        sourceProj,
        query.sourceExtent,
        query.z,
      );
      const xs = new Set(refs.filter((ref) => ref.y === 0).map((ref) => ref.x));
      assert.isTrue(xs.has(0), 'must include western dateline column');
      assert.isTrue(
        xs.has((1 << query.z) - 1),
        'must include eastern dateline column',
      );
    });

    it('keeps a stable source zoom when panning a north-polar view', () => {
      proj4.defs(
        'EPSG:3413',
        '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 ' +
          '+x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
      );
      register(proj4);
      const targetProj = getProjection('EPSG:3413');
      targetProj.setExtent([-4194304, -4194304, 4194304, 4194304]);
      const sourceProj = getProjection('EPSG:3857');
      const viewResolution = 32768;
      const half = viewResolution * 128;
      const atPole = [-half, -half, half, half];
      const panned = [
        -500000 - half,
        500000 - half,
        -500000 + half,
        500000 + half,
      ];
      const poleRes = calculateFinestSourceExtentResolution(
        sourceProj,
        targetProj,
        atPole,
        viewResolution,
      );
      const pannedRes = calculateFinestSourceExtentResolution(
        sourceProj,
        targetProj,
        panned,
        viewResolution,
      );
      // Center-only resolution jumps ~8× when leaving the pole; finest-of-grid
      // stays in the same ballpark so tile z (and polar coverage) stays stable.
      assert.isBelow(pannedRes / poleRes, 2);
      const osm = new OSM();
      const poleQuery = getSourceTileQuery(
        osm,
        targetProj,
        atPole,
        viewResolution,
      );
      const pannedQuery = getSourceTileQuery(
        osm,
        targetProj,
        panned,
        viewResolution,
      );
      assert.isNotNull(poleQuery);
      assert.isNotNull(pannedQuery);
      assert.isAtMost(Math.abs(poleQuery.z - pannedQuery.z), 1);
    });

    it('drops south-hemisphere mercator samples in a north-polar view', () => {
      proj4.defs(
        'EPSG:3413',
        '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 ' +
          '+x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
      );
      register(proj4);
      const sourceProj = getProjection('EPSG:3857');
      const targetProj = getProjection('EPSG:3413');
      targetProj.setExtent([-4194304, -4194304, 4194304, 4194304]);
      // Southern tile at z=3 (y=6): projects far outside the polar extent and
      // previously produced viewport rays from float precision blow-up.
      const sourceExtent = [
        -15028131.257091932, -15028131.257091936, -10018754.17139462,
        -10018754.171394624,
      ];
      const mesh = new Mesh({
        sourceProj,
        targetProj,
        sourceExtent,
        sourceResolution: 78271.51696402048,
      });
      assert.isTrue(mesh.isEmpty());

      const northExtent = [
        -15028131.257091932, 10018754.17139462, -10018754.17139462,
        15028131.257091936,
      ];
      const northMesh = new Mesh({
        sourceProj,
        targetProj,
        sourceExtent: northExtent,
        sourceResolution: 78271.51696402048,
      });
      assert.isFalse(northMesh.isEmpty());
      const verts = northMesh.vertices.getArray();
      const indices = northMesh.indices.getArray();
      const te = targetProj.getExtent();
      const pad = (te[2] - te[0]) * 0.05;
      for (let i = 0; i < indices.length; ++i) {
        const v = indices[i];
        assert.isAbove(verts[v * 4], te[0] - pad);
        assert.isAbove(verts[v * 4 + 1], te[1] - pad);
        assert.isBelow(verts[v * 4], te[2] + pad);
        assert.isBelow(verts[v * 4 + 1], te[3] + pad);
      }
    });
  });

  describe('densify', () => {
    it('subdivides long XY segments', () => {
      const densified = densifyFlatCoordinates([0, 0, 100, 0], 25);
      assert.isAbove(densified.length / 2, 2);
      assert.equal(densified[0], 0);
      assert.equal(densified[densified.length - 2], 100);
    });

    it('does not subdivide antimeridian chords beyond maxSpanX', () => {
      // Densifying 179 → -179 the long way created Mollweide horizontal streaks.
      const ring = [179, -18, -179, -18];
      const densified = densifyFlatCoordinates(ring, 2, 180);
      assert.equal(densified.length, 4);
      assert.deepEqual(densified, ring);
    });

    it('still subdivides short arcs when maxSpanX is set', () => {
      const densified = densifyFlatCoordinates([0, 0, 100, 0], 25, 180);
      assert.isAbove(densified.length / 2, 2);
    });
  });

  describe('WarpField', () => {
    it('keeps continuous target X across lon 180 in an unwrapped field', () => {
      // Dateline-centered warp windows must not wrap samples back into ±180 —
      // that put a seam in the texture and LINEAR filtering caused fill streaks.
      const sourceProj = getProjection('EPSG:4326');
      const targetProj = getProjection('EPSG:3857');
      const field = new WarpField({
        sourceProj,
        targetProj,
        sourceExtent: [160, -30, 200, 10],
        sourceResolution: 40 / 256,
      });
      const west = field.projectExact([179, 0]);
      const east = field.projectExact([181, 0]);
      assert.isNotNull(west);
      assert.isNotNull(east);
      assert.isAbove(east[0], west[0]);
      assert.isBelow(east[0] - west[0], 500000);
      const sampledWest = field.sample([179, 0]);
      const sampledEast = field.sample([181, 0]);
      assert.isNotNull(sampledWest);
      assert.isNotNull(sampledEast);
      assert.isAbove(sampledEast[0], sampledWest[0]);
    });

    it('samples match projectSourceToTarget within tolerance', () => {
      const sourceProj = getProjection('EPSG:4326');
      const targetProj = getProjection('EPSG:3857');
      const sourceExtent = [0, 0, 90, 45];
      const sourceResolution = 90 / 256;
      const field = new WarpField({
        sourceProj,
        targetProj,
        sourceExtent,
        sourceResolution,
      });
      const forward = getTransform(sourceProj, targetProj);
      // Grid corners must match exactly; interior samples may diverge by the
      // bilinear residual of the warp (bounded by ~a source-pixel chord).
      const exactNodes = [
        [0, 0],
        [90, 0],
        [0, 45],
        [90, 45],
      ];
      for (const sourcePos of exactNodes) {
        const exact = projectSourceToTarget(
          sourcePos,
          sourceProj,
          targetProj,
          undefined,
          forward,
          undefined,
        );
        const sampled = field.sample(sourcePos);
        assert.isNotNull(exact);
        assert.isNotNull(sampled);
        // Field stores targets as float32 (GPU texture upload).
        assert.approximately(sampled[0], exact[0], 1);
        assert.approximately(sampled[1], exact[1], 1);
      }
      const interior = field.sample([45, 22.5]);
      const interiorExact = projectSourceToTarget(
        [45, 22.5],
        sourceProj,
        targetProj,
        undefined,
        forward,
        undefined,
      );
      assert.isNotNull(interior);
      assert.isNotNull(interiorExact);
      // Bilinear residual of the warp between grid nodes.
      const maxErr = 2000;
      assert.approximately(interior[0], interiorExact[0], maxErr);
      assert.approximately(interior[1], interiorExact[1], maxErr);
    });

    it('shares edge samples between adjacent fields', () => {
      const sourceProj = getProjection('EPSG:4326');
      const targetProj = getProjection('EPSG:3857');
      const resolution = 90 / 256;
      const left = new WarpField({
        sourceProj,
        targetProj,
        sourceExtent: [0, 0, 90, 45],
        sourceResolution: resolution,
      });
      const right = new WarpField({
        sourceProj,
        targetProj,
        sourceExtent: [90, 0, 180, 45],
        sourceResolution: resolution,
      });
      const ys = [0, 11.25, 22.5, 33.75, 45];
      for (const y of ys) {
        const a = left.sample([90, y]);
        const b = right.sample([90, y]);
        assert.isNotNull(a);
        assert.isNotNull(b);
        assert.approximately(a[0], b[0], 1e-6);
        assert.approximately(a[1], b[1], 1e-6);
      }
    });

    it('recenters worldwide pads and keeps unwrapped dateline fields continuous', () => {
      proj4.defs(
        'ESRI:54009',
        '+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
      );
      proj4.defs(
        'EPSG:5479',
        '+proj=lcc +lat_1=-76.66666666666667 +lat_2=-79.33333333333333 ' +
          '+lat_0=-78 +lon_0=163 +x_0=7000000 +y_0=5000000 +ellps=GRS80 ' +
          '+towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
      );
      register(proj4);
      const sourceProj = getProjection('EPSG:4326');
      const mollweide = getProjection('ESRI:54009');
      mollweide.setExtent([-18e6, -9e6, 18e6, 9e6]);
      const antarctic = getProjection('EPSG:5479');
      antarctic.setExtent([6825737.53, 4189159.8, 9633741.96, 5782472.71]);

      // World-wide pad is recentered into a continuous unwrap window.
      const padded = padSourceExtentForWarp(
        [-270, -180, 270, 180],
        sourceProj,
        0,
        0,
      );
      assert.deepEqual(padded, [-180, -90, 180, 90]);

      // Dateline-centered unwrapped field past ±180 stays continuous when the
      // target CRS is centered near the dateline (not cut at the antimeridian).
      const field = new WarpField({
        sourceProj,
        targetProj: antarctic,
        sourceExtent: padSourceExtentForWarp(
          [160, -80, 200, -70],
          sourceProj,
          0,
          180,
        ),
        sourceResolution: 1,
      });
      const a = field.sample([170, -75]);
      const b = field.sample([190, -75]);
      assert.isNotNull(a);
      assert.isNotNull(b);
      const exactA = transform([170, -75], sourceProj, antarctic);
      const exactB = transform([190, -75], sourceProj, antarctic);
      assert.approximately(a[0], exactA[0], 5e4);
      assert.approximately(b[0], exactB[0], 5e4);
      // Samples on either side of ±180 must not jump across the globe.
      assert.approximately(a[0], b[0], 1e6);

      // Mollweide is cut at the antimeridian: east-of-cut samples stay east.
      const mollField = new WarpField({
        sourceProj,
        targetProj: mollweide,
        sourceExtent: padSourceExtentForWarp(
          [100, -50, 179, 0],
          sourceProj,
          0,
          140,
        ),
        sourceResolution: 1,
      });
      const east = mollField.sample([179, -41]);
      assert.isNotNull(east);
      assert.isAbove(east[0], 0, '179°E should stay in eastern hemisphere');
      const exactEast = transform([179, -41], sourceProj, mollweide);
      assert.approximately(east[0], exactEast[0], 2e6);
    });
  });

  describe('sampleGrid', () => {
    it('clamps out-of-bounds samples to grid edges', () => {
      const grid = buildSourceTargetGrid({
        sourceProj: getProjection('EPSG:4326'),
        targetProj: getProjection('EPSG:3857'),
        sourceExtent: [0, 0, 90, 45],
        sourceResolution: 90 / 8,
        uniformSpacing: true,
      });
      const inside = sampleGrid(grid, [0, 0]);
      const outside = sampleGrid(grid, [-10, -10]);
      assert.isNotNull(inside);
      assert.isNotNull(outside);
      assert.deepEqual(outside, inside);
    });
  });

  describe('padSourceExtentForWarp', () => {
    it('pads and clamps Y to the source world', () => {
      const sourceProj = getProjection('EPSG:4326');
      const padded = padSourceExtentForWarp(
        [-90, -45, 90, 45],
        sourceProj,
        0.5,
      );
      assert.isAtLeast(padded[1], -90);
      assert.isAtMost(padded[3], 90);
      assert.isBelow(padded[0], -90);
      assert.isAbove(padded[2], 90);
    });

    it('clamps near-global extents to the world (no unwrapped half-window)', () => {
      const sourceProj = getProjection('EPSG:4326');
      const padded = padSourceExtentForWarp(
        [-178, -85, 178, -60],
        sourceProj,
        0,
        180,
      );
      assert.strictEqual(padded[0], -180);
      assert.strictEqual(padded[2], 180);
      assert.isAtLeast(padded[1], -90);
      assert.isAtMost(padded[3], 90);
    });

    it('unwraps local dateline footprints past ±180', () => {
      const sourceProj = getProjection('EPSG:4326');
      const padded = padSourceExtentForWarp(
        [160, -80, -160, -70],
        sourceProj,
        0,
        180,
      );
      // Local bbox around the dateline becomes a continuous unwrapped window.
      assert.isBelow(padded[0], 180);
      assert.isAbove(padded[2], 180);
      assert.isBelow(getWidth(padded), 180);
    });

    it('does not build an unwrapped field wider than half the world', () => {
      const sourceProj = getProjection('EPSG:4326');
      // Africa→NZ class footprint: under ½ world before pad, over after.
      const padded = padSourceExtentForWarp(
        [20, -45, 180, 5],
        sourceProj,
        0.5,
        100,
      );
      assert.isAtLeast(padded[0], -180);
      assert.isAtMost(padded[2], 180);
      assert.isAtMost(getWidth(padded), 360);
    });

    it('clamps Mollweide dateline pads (no unwrapped X past ±180)', () => {
      proj4.defs(
        'ESRI:54009',
        '+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
      );
      register(proj4);
      const sourceProj = getProjection('EPSG:4326');
      const mollweide = getProjection('ESRI:54009');
      mollweide.setExtent([-18e6, -9e6, 18e6, 9e6]);
      assert.isFalse(targetAllowsUnwrappedSourceX(sourceProj, mollweide));
      assert.isTrue(
        targetAllowsUnwrappedSourceX(sourceProj, getProjection('EPSG:3857')),
      );
      // Fiji-class footprint past 180° must not create an unwrapped Mollweide field.
      const padded = padSourceExtentForWarp(
        [162, -24, 196, -10],
        sourceProj,
        0.5,
        179,
        mollweide,
      );
      assert.isAtLeast(padded[0], -180);
      assert.isAtMost(padded[2], 180);
    });
  });

  describe('estimateSourceExtentForView (Australia)', () => {
    it('keeps an Australia/NZ view in the eastern hemisphere without a sticky center', () => {
      const sourceProj = getProjection('EPSG:4326');
      const viewProj = getProjection('EPSG:3857');
      const center = transform([145, -30], 'EPSG:4326', 'EPSG:3857');
      const half = 3500000;
      const viewExtent = [
        center[0] - half,
        center[1] - half,
        center[0] + half,
        center[1] + half,
      ];
      const needed = estimateSourceExtentForView(
        viewExtent,
        sourceProj,
        viewProj,
        undefined,
        8,
      );
      assert.isNotNull(needed);
      assert.isAbove(needed[0], 90);
      assert.isBelow(needed[2], 180);
      // A western sticky center must not be required for a correct footprint;
      // when passed, it biases the estimate into the wrong hemisphere.
      const biased = estimateSourceExtentForView(
        viewExtent,
        sourceProj,
        viewProj,
        undefined,
        8,
        -90,
      );
      assert.isNotNull(biased);
      assert.isBelow(biased[2], 0);
    });
  });

  describe('transformMatrix mesh', () => {
    it('applies inverse matrix before projecting tile extents', () => {
      const sourceProj = getProjection('EPSG:4326');
      const targetProj = getProjection('EPSG:3857');
      // Scale data-space extents by 2 relative to geographic degrees.
      const transformMatrix = createTransform();
      transformMatrix[0] = 0.5;
      transformMatrix[3] = 0.5;
      const sourceExtent = [0, 0, 45, 22.5];
      const mesh = new Mesh({
        sourceProj,
        targetProj,
        sourceExtent,
        sourceResolution: 45 / 64,
        transformMatrix,
      });
      assert.isFalse(mesh.isEmpty());
      const verts = mesh.vertices.getArray();
      // Corner at data (0,0) → geographic (0,0) → mercator near origin.
      let foundOrigin = false;
      for (let i = 0; i < verts.length; i += 4) {
        if (verts[i + 2] === 0 && verts[i + 3] === 0) {
          assert.approximately(verts[i], 0, 1);
          assert.approximately(verts[i + 1], 0, 1);
          foundOrigin = true;
        }
      }
      assert.isTrue(foundOrigin);
      // Data (45, 0) → geographic (90, 0).
      const expected = transform([90, 0], sourceProj, targetProj);
      let foundEast = false;
      for (let i = 0; i < verts.length; i += 4) {
        if (verts[i + 2] === 45 && verts[i + 3] === 0) {
          assert.approximately(verts[i], expected[0], 1);
          assert.approximately(verts[i + 1], expected[1], 1);
          foundEast = true;
        }
      }
      assert.isTrue(foundEast);
    });
  });

  describe('preload source extent', () => {
    it('reuses the view-derived source extent for coarser zoom refs', () => {
      const source = new DataTileSource({
        projection: 'EPSG:4326',
        tileGrid: createXYZ({extent: [-180, -90, 180, 90], maxZoom: 5}),
        loader,
      });
      const viewProj = getProjection('EPSG:3857');
      const viewExtent = transformExtent(
        [-10, -10, 10, 10],
        'EPSG:4326',
        'EPSG:3857',
      );
      const query = getSourceTileQuery(source, viewProj, viewExtent, 10000);
      assert.isNotNull(query);
      const coarseZ = Math.max(query.z - 2, source.getTileGrid().getMinZoom());
      const fineRefs = getSourceTileRefs(
        source,
        getProjection('EPSG:4326'),
        query.sourceExtent,
        query.z,
      );
      const coarseRefs = getSourceTileRefs(
        source,
        getProjection('EPSG:4326'),
        query.sourceExtent,
        coarseZ,
      );
      assert.isAbove(fineRefs.length, 0);
      assert.isAbove(coarseRefs.length, 0);
      // Coarser zoom must not invent a different (wrong-CRS) extent; refs
      // share the same sourceExtent and only change z.
      assert.isTrue(coarseRefs.every((ref) => ref.z === coarseZ));
      assert.isTrue(fineRefs.every((ref) => ref.z === query.z));
    });
  });

  describe('reproj cache eviction', () => {
    it('deletes GPU resources when entries are evicted', () => {
      const layer = new WebGLTileLayer({
        source: new DataTileSource({
          projection: 'EPSG:4326',
          loader,
        }),
      });
      const renderer = layer.getRenderer();
      let deleted = 0;
      const fakeHelper = {};
      /** @type {Array<{delete: function(*): void}>} */
      const entries = [];
      for (let i = 0; i < 4; ++i) {
        entries.push({
          delete(h) {
            assert.strictEqual(h, fakeHelper);
            deleted++;
          },
        });
      }
      renderer.reprojCache_ = new LRUCache(2);
      renderer.helper = fakeHelper;
      for (let i = 0; i < entries.length; ++i) {
        renderer.reprojCache_.set(String(i), entries[i]);
      }
      renderer.expireReprojCache_();
      assert.strictEqual(renderer.reprojCache_.getCount(), 2);
      assert.strictEqual(deleted, 2);
      // Avoid dispose() clearing the stub helper / remaining entries.
      renderer.reprojCache_.clear();
      renderer.helper = null;
      layer.dispose();
    });
  });

  describe('needsReprojection', () => {
    it('detects differing projections', () => {
      const source = new DataTileSource({
        projection: 'EPSG:4326',
        loader,
      });
      assert.isTrue(needsReprojection(source, getProjection('EPSG:3857')));
      assert.isFalse(needsReprojection(source, getProjection('EPSG:4326')));
    });

    it('detects transformMatrix sources', () => {
      const source = new DataTileSource({
        projection: 'EPSG:3857',
        loader,
      });
      source.transformMatrix = createTransform();
      assert.isTrue(needsReprojection(source, getProjection('EPSG:3857')));
    });
  });

  it('pixel data reprojected from EPSG:4326 to EPSG:3857 exactly matches original', () =>
    new Promise((resolve) => {
      target.style.width = '512px';
      map = new Map({
        target: target,
        view: new View({
          center: [0, 0],
          zoom: 1,
          multiWorld: true,
          projection: 'EPSG:4326',
        }),
      });

      targetR.style.width = '512px';
      targetR.style.height = '512px';
      mapR = new Map({
        target: targetR,
        view: new View({
          center: [0, 0],
          zoom: 1,
          multiWorld: true,
        }),
      });

      const source = new DataTileSource({
        loader: loader,
        transition: 0,
        projection: 'EPSG:4326',
        maxResolution: 180 / 256,
        maxZoom: 0,
      });
      const layer = new WebGLTileLayer({
        source: source,
      });
      const layerR = new WebGLTileLayer({
        source: source,
      });
      map.addLayer(layer);
      map.once('rendercomplete', () => {
        mapR.addLayer(layerR);
        mapR.once('rendercomplete', () => {
          for (let i = 0; i < 256; ++i) {
            const pixelR = [i + 0.5, i * 2 + 1];
            const coordinateR = mapR.getCoordinateFromPixel(pixelR);
            const dataR = layerR.getData(pixelR);
            const coordinate = transform(
              coordinateR,
              mapR.getView().getProjection(),
              map.getView().getProjection(),
            );
            const pixel = map.getPixelFromCoordinate(coordinate);

            const dataA = [];
            for (let j = -1; j < 2; ++j) {
              dataA.push(layer.getData([pixel[0], pixel[1] + j]).toString());
            }
            assert.include(dataA, dataR.toString());
          }
          resolve();
        });
      });
    }));

  it('pixel data reprojected from EPSG:3857 to EPSG:4326 exactly matches original', () =>
    new Promise((resolve) => {
      map = new Map({
        target: target,
        view: new View({
          center: [0, 0],
          zoom: 0,
          multiWorld: true,
        }),
      });

      targetR.style.width = '512px';
      mapR = new Map({
        target: targetR,
        view: new View({
          center: [0, 0],
          zoom: 1,
          multiWorld: true,
          projection: 'EPSG:4326',
        }),
      });

      const source = new DataTileSource({
        loader: loader,
        transition: 0,
        maxZoom: 0,
      });
      const layer = new WebGLTileLayer({
        source: source,
      });
      const layerR = new WebGLTileLayer({
        source: source,
      });
      map.addLayer(layer);
      map.once('rendercomplete', () => {
        mapR.addLayer(layerR);
        mapR.once('rendercomplete', () => {
          for (let i = 0; i < 256; ++i) {
            const pixelR = [i + 0.5, i + 0.5];
            const coordinateR = mapR.getCoordinateFromPixel(pixelR);
            if (Math.abs(coordinateR[1]) < 84) {
              const dataR = layerR.getData(pixelR);
              const coordinate = transform(
                coordinateR,
                mapR.getView().getProjection(),
                map.getView().getProjection(),
              );
              const pixel = map.getPixelFromCoordinate(coordinate);

              const dataA = [];
              for (let j = -3; j < 4; ++j) {
                dataA.push(layer.getData([pixel[0], pixel[1] + j]).toString());
              }
              assert.include(dataA, dataR.toString());
            }
          }
          resolve();
        });
      });
    }));

  it('pixel data reprojected from EPSG:32636 to EPSG:32632 exactly matches original', () =>
    new Promise((resolve) => {
      proj4.defs(
        'EPSG:32632',
        '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs',
      );
      proj4.defs(
        'EPSG:32636',
        '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs',
      );
      register(proj4);

      getProjection('EPSG:32632').setExtent([-3500000, 0, 4500000, 10000000]);
      getProjection('EPSG:32636').setExtent([-3500000, 0, 4500000, 10000000]);

      const extent = [539660, 1835050, 543590, 1838980];
      const tileGrid = createXYZ({extent: extent, maxZoom: 0});

      const source = new DataTileSource({
        loader: loader,
        transition: 0,
        tileGrid: tileGrid,
        projection: 'EPSG:32636',
      });
      const layer = new WebGLTileLayer({
        source: source,
      });
      const layerR = new WebGLTileLayer({
        source: source,
      });

      map = new Map({
        target: target,
        layers: [layer],
        view: new View({
          projection: 'EPSG:32636',
        }),
      });

      mapR = new Map({
        target: targetR,
        layers: [layerR],
        view: new View({
          projection: 'EPSG:32632',
        }),
      });

      map.getView().fit(extent);
      map.once('rendercomplete', () => {
        mapR
          .getView()
          .fit(
            transformExtent(
              extent,
              map.getView().getProjection(),
              mapR.getView().getProjection(),
            ),
          );
        mapR.once('rendercomplete', () => {
          for (let i = 1; i < 255; ++i) {
            let pixel, coordinate, coordinateR, pixelR, dataR, dataA;
            const emptyData = new Uint8Array([0, 0, 0, 0]);

            pixel = [i + 0.5, i + 0.5];
            coordinate = map.getCoordinateFromPixel(pixel);
            coordinateR = transform(
              coordinate,
              map.getView().getProjection(),
              mapR.getView().getProjection(),
            );
            pixelR = mapR.getPixelFromCoordinate(coordinateR);
            dataR = layerR.getData(pixelR);

            dataA = [];
            for (let i = -1; i < 2; ++i) {
              for (let j = -1; j < 2; ++j) {
                const data = layer.getData([pixel[0] + i, pixel[1] + j]);
                dataA.push(data.toString());
              }
            }
            assert.include(dataA, dataR.toString());

            pixel = [i + 0.5, 255.5 - i];
            coordinate = map.getCoordinateFromPixel(pixel);
            coordinateR = transform(
              coordinate,
              map.getView().getProjection(),
              mapR.getView().getProjection(),
            );
            pixelR = mapR.getPixelFromCoordinate(coordinateR);
            dataR = layerR.getData(pixelR);

            dataA = [];
            for (let i = -1; i < 2; ++i) {
              for (let j = -1; j < 2; ++j) {
                const data = layer.getData([pixel[0] + i, pixel[1] + j]);
                dataA.push(data.toString());
              }
            }
            assert.include(dataA, dataR.toString());

            pixel = [i + 0.5, 1.5];
            coordinate = map.getCoordinateFromPixel(pixel);
            coordinateR = transform(
              coordinate,
              map.getView().getProjection(),
              mapR.getView().getProjection(),
            );
            pixelR = mapR.getPixelFromCoordinate(coordinateR);
            dataR = layerR.getData(pixelR);

            dataA = [];
            for (let i = -1; i < 2; ++i) {
              for (let j = -1; j < 2; ++j) {
                const data = layer.getData([pixel[0] + i, pixel[1] + j]);
                dataA.push(data.toString());
              }
            }
            assert.include(dataA, dataR.toString());

            pixel = [1.5, i + 0.5];
            coordinate = map.getCoordinateFromPixel(pixel);
            coordinateR = transform(
              coordinate,
              map.getView().getProjection(),
              mapR.getView().getProjection(),
            );
            pixelR = mapR.getPixelFromCoordinate(coordinateR);
            dataR = layerR.getData(pixelR);

            dataA = [];
            for (let i = -1; i < 2; ++i) {
              for (let j = -1; j < 2; ++j) {
                const data = layer.getData([pixel[0] + i, pixel[1] + j]);
                dataA.push(data.toString());
              }
            }
            assert.include(dataA, dataR.toString());

            pixel = [i + 0.5, 255.5];
            coordinate = map.getCoordinateFromPixel(pixel);
            coordinateR = transform(
              coordinate,
              map.getView().getProjection(),
              mapR.getView().getProjection(),
            );
            pixelR = mapR.getPixelFromCoordinate(coordinateR);
            dataR = layerR.getData(pixelR);

            dataA = [];
            for (let i = -1; i < 2; ++i) {
              for (let j = -1; j < 2; ++j) {
                const data = layer.getData([pixel[0] + i, pixel[1] + j]);
                dataA.push((data || emptyData).toString());
              }
            }
            assert.include(dataA, dataR.toString());
          }
          resolve();
        });
      });
    }));
});
