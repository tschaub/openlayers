import Map from '../src/ol/Map.js';
import View from '../src/ol/View.js';
import GeoJSON from '../src/ol/format/GeoJSON.js';
import WebGPUTileLayer from '../src/ol/layer/WebGPUTile.js';
import WebGPUVectorLayer from '../src/ol/layer/WebGPUVector.js';
import {fromLonLat} from '../src/ol/proj.js';
import OSM from '../src/ol/source/OSM.js';
import VectorSource from '../src/ol/source/Vector.js';

const style = {
  'fill-color': 'rgba(255, 255, 255, 0.6)',
  'stroke-color': '#319FD3',
  'stroke-width': 1,
  'text-value': ['get', 'name'],
  'text-font': '12px Calibri,sans-serif',
  'text-fill-color': '#000',
  'text-stroke-color': '#fff',
  'text-stroke-width': 3,
  'text-overflow': true,
};

const vectorLayer = new WebGPUVectorLayer({
  source: new VectorSource({
    url: 'https://openlayers.org/data/vector/us-states.json',
    format: new GeoJSON(),
  }),
  style,
  declutter: true,
});

const map = new Map({
  layers: [
    new WebGPUTileLayer({
      source: new OSM(),
    }),
    vectorLayer,
  ],
  target: 'map',
  view: new View({
    center: fromLonLat([-100, 38.5]),
    zoom: 4,
  }),
});

map.on('pointermove', function (evt) {
  if (evt.dragging) {
    return;
  }
  const info = document.getElementById('info');
  const feature = map.forEachFeatureAtPixel(evt.pixel, (f) => f);
  if (info) {
    info.innerHTML = feature ? feature.get('name') || '&nbsp;' : '&nbsp;';
  }
});
