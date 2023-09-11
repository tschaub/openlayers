import GeoJSON from '../src/ol/format/GeoJSON.js';
import Link from '../src/ol/interaction/Link.js';
import Map from '../src/ol/Map.js';
import VectorLayer from '../src/ol/layer/Vector.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import {useGeographic} from '../src/ol/proj.js';

useGeographic();

const vectorLayer = new VectorLayer({
  source: new VectorSource({
    url: 'http://localhost:4000/bulawayo.json',
    format: new GeoJSON(),
  }),
  style: {
    'fill-color': '#00AAFF',
    'stroke-color': 'rgba(50, 50, 50, 0.5)',
    'stroke-width': 1,
  },
});

const map = new Map({
  layers: [vectorLayer],
  target: 'map',
  view: new View({
    center: [28.58737, -20.16127],
    zoom: 13,
  }),
});

map.addInteraction(new Link());
