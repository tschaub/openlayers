/**
 * @module ol/webgpu/TileTexture
 */
import DataTile, {asArrayLike, asImageLike} from '../DataTile.js';
import ImageTile from '../ImageTile.js';
import TileState from '../TileState.js';
import {createCanvasContext2D} from '../dom.js';
import EventType from '../events/EventType.js';
import EventTarget from '../events/Target.js';

/** @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null} */
let pixelContext = null;

function getPixelContext() {
  if (!pixelContext) {
    pixelContext = createCanvasContext2D(1, 1, undefined, {
      willReadFrequently: true,
    });
  }
  return pixelContext;
}

/**
 * @typedef {Object} Options
 * @property {import("../Tile.js").default} tile Tile.
 * @property {import("./Helper.js").default} helper Helper.
 * @property {number} [gutter=0] Gutter.
 */

/**
 * @classdesc
 * GPU texture representation of a raster tile.
 */
class TileTexture extends EventTarget {
  /**
   * @param {Options} options Options.
   */
  constructor(options) {
    super();

    /**
     * @type {import("../Tile.js").default}
     */
    this.tile;

    /**
     * @type {boolean}
     */
    this.ready = false;

    /**
     * @type {boolean}
     */
    this.loaded = false;

    /**
     * @type {GPUTexture|null}
     */
    this.texture = null;

    /**
     * @type {number}
     */
    this.bandCount = 4;

    /**
     * @protected
     * @type {import("./Helper.js").default}
     */
    this.helper = options.helper;

    /**
     * @protected
     * @type {number}
     */
    this.gutter = options.gutter || 0;

    this.handleTileChange_ = this.handleTileChange_.bind(this);
    this.setTile(options.tile);
  }

  /**
   * Upload the tile image if it is loaded but has no GPU texture yet.
   */
  ensureUploaded() {
    if (this.loaded && !this.texture) {
      this.uploadTile();
    }
  }

  /**
   * @param {import("./Helper.js").default} helper Helper.
   */
  setHelper(helper) {
    this.helper = helper;
    if (this.loaded) {
      this.uploadTile();
    }
  }

  /**
   * @param {import("../Tile.js").default} tile Tile.
   */
  setTile(tile) {
    if (tile === this.tile) {
      return;
    }
    if (this.tile) {
      this.tile.removeEventListener(EventType.CHANGE, this.handleTileChange_);
    }
    this.tile = tile;
    this.ready = false;
    this.loaded = tile.getState() === TileState.LOADED;
    if (this.loaded) {
      this.uploadTile();
    } else {
      if (this.texture) {
        this.texture.destroy();
        this.texture = null;
      }
      tile.addEventListener(EventType.CHANGE, this.handleTileChange_);
    }
  }

  /**
   * @private
   */
  handleTileChange_() {
    const state = this.tile.getState();
    if (state === TileState.LOADED) {
      this.loaded = true;
      this.uploadTile();
    } else if (state === TileState.ERROR || state === TileState.EMPTY) {
      this.ready = true;
      this.dispatchEvent(EventType.CHANGE);
    }
  }

  /**
   * @protected
   */
  uploadTile() {
    const helper = this.helper;
    if (!helper) {
      return;
    }
    const tile = this.tile;
    /** @type {import("../DataTile.js").Data|import("../DataTile.js").ImageLike|null} */
    let data = null;
    if (tile instanceof ImageTile) {
      data = tile.getImage();
    } else if (tile instanceof DataTile) {
      data = tile.getData();
    }
    if (!data) {
      return;
    }

    if (this.texture) {
      this.texture.destroy();
      this.texture = null;
    }

    const image = asImageLike(data);
    if (image) {
      this.texture = helper.createTextureFromImage(image, tile.interpolate);
      this.bandCount = 4;
      this.ready = true;
      this.dispatchEvent(EventType.CHANGE);
      return;
    }

    const array = asArrayLike(data);
    if (
      (array && array instanceof Uint8Array) ||
      array instanceof Uint8ClampedArray
    ) {
      const size = tile instanceof DataTile ? tile.getSize() : [256, 256];
      const texture = helper.getDevice().createTexture({
        size: [size[0], size[1]],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      helper
        .getDevice()
        .queue.writeTexture({texture}, array, {bytesPerRow: size[0] * 4}, [
          size[0],
          size[1],
        ]);
      this.texture = texture;
      this.bandCount = 4;
      this.ready = true;
      this.dispatchEvent(EventType.CHANGE);
    }
  }

  /**
   * Sample a pixel from the source tile (column/row in rendered tile space).
   *
   * @param {number} renderCol Column.
   * @param {number} renderRow Row.
   * @return {import("../DataTile.js").ArrayLike|null} Pixel values, or null.
   */
  getPixelData(renderCol, renderRow) {
    if (!this.loaded) {
      return null;
    }
    const col = Math.floor(renderCol);
    const row = Math.floor(renderRow);
    if (col < 0 || row < 0) {
      return null;
    }
    const tile = this.tile;
    if (tile instanceof DataTile) {
      const data = tile.getData();
      if (!data) {
        return null;
      }
      const arrayData = asArrayLike(data);
      if (arrayData) {
        const size = tile.getSize();
        const gutter = this.gutter;
        const width = size[0] + 2 * gutter;
        const sourceCol = gutter + col;
        const sourceRow = gutter + row;
        if (sourceCol >= width || sourceRow >= size[1] + 2 * gutter) {
          return null;
        }
        const bands = this.bandCount;
        const offset = bands * (sourceRow * width + sourceCol);
        if (arrayData instanceof DataView) {
          const height = size[1] + 2 * gutter;
          const bytesPerPixel = arrayData.byteLength / (width * height);
          const byteOffset = bytesPerPixel * (sourceRow * width + sourceCol);
          return new DataView(
            arrayData.buffer.slice(byteOffset, byteOffset + bytesPerPixel),
          );
        }
        if (offset + bands > arrayData.length) {
          return null;
        }
        return arrayData.slice(offset, offset + bands);
      }
      const image = asImageLike(data);
      if (!image) {
        return null;
      }
      return this.getImagePixelData_(image, col, row);
    }
    if (tile instanceof ImageTile) {
      const image = tile.getImage();
      if (!image) {
        return null;
      }
      return this.getImagePixelData_(image, col, row);
    }
    return null;
  }

  /**
   * @param {import("../DataTile.js").ImageLike} image Image.
   * @param {number} col Column.
   * @param {number} row Row.
   * @return {Uint8ClampedArray|null} RGBA.
   * @private
   */
  getImagePixelData_(image, col, row) {
    const context = getPixelContext();
    const gutter = this.gutter;
    try {
      context.clearRect(0, 0, 1, 1);
      context.drawImage(image, gutter + col, gutter + row, 1, 1, 0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data;
    } catch {
      pixelContext = null;
      return null;
    }
  }

  /**
   * @override
   */
  disposeInternal() {
    if (this.tile) {
      this.tile.removeEventListener(EventType.CHANGE, this.handleTileChange_);
    }
    if (this.texture) {
      this.texture.destroy();
      this.texture = null;
    }
    super.disposeInternal();
  }
}

export default TileTexture;
