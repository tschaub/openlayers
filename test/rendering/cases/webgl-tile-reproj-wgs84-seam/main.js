import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import {getCenter} from '../../../../src/ol/extent.js';
import WebGLTileLayer from '../../../../src/ol/layer/WebGLTile.js';
import {get as getProjection} from '../../../../src/ol/proj.js';
import DataTile from '../../../../src/ol/source/DataTile.js';
import {createXYZ} from '../../../../src/ol/tilegrid.js';

/**
 * Solid-color XYZ tiles in EPSG:3857 viewed in EPSG:4326.
 * Regression: adjacent tile meshes must overlap by half a source pixel so
 * meridional seams do not show as vertical white gaps (OSM → WGS 84).
 * All tiles are the same red so any white vertical band is a seam.
 */
const size = 256;
const canvas = document.createElement('canvas');
canvas.width = size;
canvas.height = size;
const context = canvas.getContext('2d');

const source = new DataTile({
  projection: 'EPSG:3857',
  wrapX: true,
  interpolate: true,
  transition: 0,
  tileGrid: createXYZ({
    extent: getProjection('EPSG:3857').getExtent(),
    maxZoom: 4,
    tileSize: size,
  }),
  loader: function () {
    context.fillStyle = '#e31a1c';
    context.fillRect(0, 0, size, size);
    return context.getImageData(0, 0, size, size).data;
  },
});

const layer = new WebGLTileLayer({source});

const projection = getProjection('EPSG:4326');

const map = new Map({
  pixelRatio: 1,
  target: 'map',
  layers: [layer],
  view: new View({
    projection,
    // Several 3857 tile meridians cross this WGS 84 viewport.
    center: getCenter([-30, -35, 30, 35]),
    resolution: 0.45,
  }),
});

map.on('rendercomplete', function onRenderComplete() {
  map.un('rendercomplete', onRenderComplete);
  render({
    message:
      'EPSG:4326 WebGL tiles from EPSG:3857: solid fill meets across tile meridians without vertical white seams',
    tolerance: 0.02,
  });
});
