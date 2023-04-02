import DataTileSource from '../src/ol/source/DataTile.js';
import Flow from '../src/ol/layer/Flow.js';
import GeoJSON from '../src/ol/format/GeoJSON.js';
import Layer from '../src/ol/layer/Layer.js';
import Map from '../src/ol/Map.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import WebGLVectorLayerRenderer from '../src/ol/renderer/webgl/VectorLayer.js';
import {asArray} from '../src/ol/color.js';
import {createXYZ, wrapX} from '../src/ol/tilegrid.js';
import {get as getProjection, transform} from '../src/ol/proj.js';
import {packColor} from '../src/ol/renderer/webgl/shaders.js';

const windData = new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    const width = image.width;
    const height = image.height;
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, width, height).data;
    resolve({data, width, height});
  };
  image.onerror = () => {
    reject(new Error('failed to load'));
  };
  image.src = './data/wind.png';
});

function bilinearInterpolation(xAlong, yAlong, v11, v21, v12, v22) {
  const q11 = (1 - xAlong) * (1 - yAlong) * v11;
  const q21 = xAlong * (1 - yAlong) * v21;
  const q12 = (1 - xAlong) * yAlong * v12;
  const q22 = xAlong * yAlong * v22;
  return q11 + q21 + q12 + q22;
}

function interpolatePixels(xAlong, yAlong, p11, p21, p12, p22) {
  return p11.map((_, i) =>
    bilinearInterpolation(xAlong, yAlong, p11[i], p21[i], p12[i], p22[i])
  );
}

const dataTileGrid = createXYZ();
const dataTileSize = 256;

const inputImageProjection = getProjection('EPSG:4326');
const dataTileProjection = getProjection('EPSG:3857');

const inputBands = 4;
const dataBands = 3;

const wind = new DataTileSource({
  wrapX: true,
  async loader(z, x, y) {
    const {
      data: inputData,
      width: inputWidth,
      height: inputHeight,
    } = await windData;

    const tileCoord = wrapX(dataTileGrid, [z, x, y], dataTileProjection);
    const extent = dataTileGrid.getTileCoordExtent(tileCoord);
    const resolution = dataTileGrid.getResolution(z);
    const data = new Uint8Array(dataTileSize * dataTileSize * dataBands);
    for (let row = 0; row < dataTileSize; ++row) {
      let offset = row * dataTileSize * dataBands;
      const mapY = extent[3] - row * resolution;
      for (let col = 0; col < dataTileSize; ++col) {
        const mapX = extent[0] + col * resolution;
        const [lon, lat] = transform(
          [mapX, mapY],
          dataTileProjection,
          inputImageProjection
        );

        const x = (inputWidth * (lon + 180)) / 360;
        let x1 = Math.floor(x);
        let x2 = Math.ceil(x);
        const xAlong = x - x1;
        if (x1 < 0) {
          x1 += inputWidth;
        }
        if (x2 >= inputWidth) {
          x2 -= inputWidth;
        }

        const y = (inputHeight * (90 - lat)) / 180;
        let y1 = Math.floor(y);
        let y2 = Math.ceil(y);
        const yAlong = y - y1;
        if (y1 < 0) {
          y1 = 0;
        }
        if (y2 >= inputHeight) {
          y2 = inputHeight - 1;
        }

        const corners = [
          [x1, y1],
          [x2, y1],
          [x1, y2],
          [x2, y2],
        ];

        const pixels = corners.map(([cx, cy]) => {
          const inputOffset = (cy * 360 + cx) * inputBands;
          return [inputData[inputOffset], inputData[inputOffset + 1]];
        });

        const interpolated = interpolatePixels(xAlong, yAlong, ...pixels);

        data[offset] = interpolated[0];
        data[offset + 1] = interpolated[1];
        offset += dataBands;
      }
    }
    return data;
  },
});

const color = packColor(asArray('#555555'));

class WebGLLayer extends Layer {
  createRenderer() {
    return new WebGLVectorLayerRenderer(this, {
      fill: {
        attributes: {
          color: () => color,
        },
      },
      stroke: {
        attributes: {
          opacity: () => 0,
        },
      },
    });
  }
}

const map = new Map({
  target: 'map',
  layers: [
    new WebGLLayer({
      source: new VectorSource({
        url: 'data/geojson/ocean.geojson',
        format: new GeoJSON(),
      }),
    }),
    new Flow({
      source: wind,
      style: {
        color: [
          'interpolate',
          ['linear'],
          ['speed'],
          0,
          '#34618d',
          0.1,
          '#2c718e',
          0.2,
          '#27818e',
          0.3,
          '#21908d',
          0.4,
          '#27ad81',
          0.5,
          '#42bb72',
          0.6,
          '#5cc863',
          0.7,
          '#83d24b',
          0.8,
          '#aadc32',
          0.9,
          '#d4e22c',
          1,
          '#fde725',
        ],
      },
    }),
  ],
  view: new View({
    center: [0, 0],
    zoom: 0,
  }),
});
