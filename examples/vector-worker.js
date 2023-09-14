import Map from '../src/ol/Map.js';
import OSM from '../src/ol/source/OSM.js';
import TileLayer from '../src/ol/layer/Tile.js';
import VectorBoss from '../src/ol/source/VectorBoss.js';
import VectorLayer from '../src/ol/layer/Vector.js';
import View from '../src/ol/View.js';

const map = new Map({
  layers: [
    new TileLayer({
      source: new OSM(),
    }),
    new VectorLayer({
      source: new VectorBoss({
        url: 'https://openlayers.org/data/vector/ecoregions.json',
      }),
    }),
  ],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 2,
  }),
});
