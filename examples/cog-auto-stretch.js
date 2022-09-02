import GeoTIFF from '../src/ol/source/GeoTIFF.js';
import Map from '../src/ol/Map.js';
import TileLayer from '../src/ol/layer/WebGLTile.js';

const source = new GeoTIFF({
  normalize: false,
  sources: [
    {
      // visible red, band 1 in the style expression below
      url: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/2020/S2A_36QWD_20200701_0_L2A/B04.tif',
    },
    {
      // visible green, band 2 in the style expression below
      url: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/2020/S2A_36QWD_20200701_0_L2A/B03.tif',
    },
    {
      // visible blue, band 3 in the style expression below
      url: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/2020/S2A_36QWD_20200701_0_L2A/B02.tif',
    },
  ],
});

const layer = new TileLayer({
  style: {
    color: [
      'array',
      [
        'interpolate',
        ['linear'],
        ['band', 1],
        ['band-min', 1],
        0,
        ['band-max', 1],
        1,
      ],
      [
        'interpolate',
        ['linear'],
        ['band', 2],
        ['band-min', 2],
        0,
        ['band-max', 2],
        1,
      ],
      [
        'interpolate',
        ['linear'],
        ['band', 3],
        ['band-min', 3],
        0,
        ['band-max', 3],
        1,
      ],
      1,
    ],
  },
  source: source,
});

const map = new Map({
  target: 'map',
  layers: [layer],
  view: source.getView(),
});
