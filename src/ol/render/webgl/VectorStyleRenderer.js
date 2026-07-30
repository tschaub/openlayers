/**
 * @module ol/render/webgl/VectorStyleRenderer
 */
import Disposable from '../../Disposable.js';
import {
  densifyFlatCoordinates,
  densifyFlatCoordinatesXYM,
} from '../../geom/flat/densify.js';
import {
  create as createTransform,
  makeInverse as makeInverseTransform,
} from '../../transform.js';
import {ARRAY_BUFFER, DYNAMIC_DRAW, ELEMENT_ARRAY_BUFFER} from '../../webgl.js';
import WebGLArrayBuffer from '../../webgl/Buffer.js';
import FontAtlas from '../../webgl/FontAtlas.js';
import {AttributeType} from '../../webgl/Helper.js';
import LabelsArray from '../../webgl/LabelsArray.js';
import {create as createWebGLWorker} from '../../worker/webgl.js';
import {flatStyleLikeToStyleFunction} from '../canvas/style.js';
import {
  filterTrianglesByTargetEdge,
  unwrapFlatCoordinatesX,
  unwrapPolygonFlatCoordinates,
  writePolygonTrianglesToBuffers,
} from './bufferUtil.js';
import {WebGLWorkerMessageType} from './constants.js';
import {colorEncodeIdAndPack} from './encodeUtil.js';
import {
  createGlyphQuadMesh,
  generateGlyphInstanceAttributes,
} from './glyphBuffers.js';
import {
  GlyphAttributes,
  GlyphUniforms,
  getGlyphFragmentShader,
  getGlyphVertexShader,
} from './glyphShaders.js';
import {
  generateLineStringRenderInstructions,
  generatePointRenderInstructions,
  generatePolygonRenderInstructions,
  getCustomAttributesSize,
} from './renderinstructions.js';
import {parseLiteralStyle} from './style.js';
import {hasTextStyle, stripNonTextStyleProperties} from './textUtil.js';

/**
 * Return a shallow-cloned batch with densified line/polygon coordinates.
 * Used when GPU-warping so long chords stay acceptable after lookup.
 * @param {import('./MixedGeometryBatch.js').default} batch Geometry batch
 * @param {number} maxSegmentLength Max segment length in batch CRS units
 * @param {number} [maxSpanX] Do not subdivide segments with |Δx| larger than this
 * @return {import('./MixedGeometryBatch.js').default} Densified batch view
 */
function densifyGeometryBatch(batch, maxSegmentLength, maxSpanX) {
  /** @type {import('./MixedGeometryBatch.js').default} */
  const densified = Object.create(Object.getPrototypeOf(batch));
  Object.assign(densified, batch);

  const lineBatch = batch.lineStringBatch;
  /** @type {import('./MixedGeometryBatch.js').LineStringGeometryBatch} */
  const newLine = {
    entries: {},
    geometriesCount: 0,
    verticesCount: 0,
  };
  for (const uid in lineBatch.entries) {
    const entry = lineBatch.entries[uid];
    /** @type {Array<Array<number>>} */
    const flatCoordss = [];
    let verticesCount = 0;
    for (let i = 0; i < entry.flatCoordss.length; ++i) {
      const densifiedCoords = densifyFlatCoordinatesXYM(
        entry.flatCoordss[i],
        maxSegmentLength,
        maxSpanX,
      );
      flatCoordss.push(densifiedCoords);
      verticesCount += densifiedCoords.length / 3;
    }
    newLine.entries[uid] = {
      ...entry,
      flatCoordss,
      verticesCount,
    };
    newLine.verticesCount += verticesCount;
    newLine.geometriesCount += flatCoordss.length;
  }
  densified.lineStringBatch = newLine;

  const polygonBatch = batch.polygonBatch;
  /** @type {import('./MixedGeometryBatch.js').PolygonGeometryBatch} */
  const newPolygon = {
    entries: {},
    geometriesCount: 0,
    verticesCount: 0,
    ringsCount: 0,
  };
  for (const uid in polygonBatch.entries) {
    const entry = polygonBatch.entries[uid];
    /** @type {Array<Array<number>>} */
    const flatCoordss = [];
    /** @type {Array<Array<number>>} */
    const ringsVerticesCounts = [];
    let verticesCount = 0;
    let ringsCount = 0;
    for (let i = 0; i < entry.flatCoordss.length; ++i) {
      const ringCounts = entry.ringsVerticesCounts?.[i];
      if (!ringCounts) {
        continue;
      }
      /** @type {Array<number>} */
      const densifiedFlat = [];
      /** @type {Array<number>} */
      const newRingCounts = [];
      let offset = 0;
      for (let r = 0; r < ringCounts.length; ++r) {
        const count = ringCounts[r];
        const ring = entry.flatCoordss[i].slice(
          offset * 2,
          (offset + count) * 2,
        );
        const densifiedRing = densifyFlatCoordinates(
          ring,
          maxSegmentLength,
          maxSpanX,
        );
        densifiedFlat.push(...densifiedRing);
        newRingCounts.push(densifiedRing.length / 2);
        offset += count;
      }
      flatCoordss.push(densifiedFlat);
      ringsVerticesCounts.push(newRingCounts);
      verticesCount += densifiedFlat.length / 2;
      ringsCount += newRingCounts.length;
    }
    newPolygon.entries[uid] = {
      ...entry,
      flatCoordss,
      ringsVerticesCounts,
      verticesCount,
      ringsCount,
    };
    newPolygon.verticesCount += verticesCount;
    newPolygon.ringsCount += ringsCount;
    newPolygon.geometriesCount += flatCoordss.length;
  }
  densified.polygonBatch = newPolygon;
  densified.pointBatch = batch.pointBatch;
  return densified;
}

/**
 * Unwrap geometry batch X around a center so dateline-crossing features stay
 * continuous for earcut and warp-field lookup.
 * @param {import('./MixedGeometryBatch.js').default} batch Geometry batch
 * @param {number} unwrapCenterX Center X
 * @param {number} worldWidth World width
 * @return {import('./MixedGeometryBatch.js').default} Unwrapped batch view
 */
function unwrapGeometryBatchX(batch, unwrapCenterX, worldWidth) {
  if (!(worldWidth > 0)) {
    return batch;
  }
  /** @type {import('./MixedGeometryBatch.js').default} */
  const unwrapped = Object.create(Object.getPrototypeOf(batch));
  Object.assign(unwrapped, batch);

  const lineBatch = batch.lineStringBatch;
  /** @type {import('./MixedGeometryBatch.js').LineStringGeometryBatch} */
  const newLine = {
    entries: {},
    geometriesCount: lineBatch.geometriesCount,
    verticesCount: lineBatch.verticesCount,
  };
  for (const uid in lineBatch.entries) {
    const entry = lineBatch.entries[uid];
    newLine.entries[uid] = {
      ...entry,
      flatCoordss: entry.flatCoordss.map((coords) =>
        unwrapFlatCoordinatesX(coords, unwrapCenterX, worldWidth, 3),
      ),
    };
  }
  unwrapped.lineStringBatch = newLine;

  const polygonBatch = batch.polygonBatch;
  /** @type {import('./MixedGeometryBatch.js').PolygonGeometryBatch} */
  const newPolygon = {
    entries: {},
    geometriesCount: polygonBatch.geometriesCount,
    verticesCount: polygonBatch.verticesCount,
    ringsCount: polygonBatch.ringsCount,
  };
  for (const uid in polygonBatch.entries) {
    const entry = polygonBatch.entries[uid];
    /** @type {Array<Array<number>>} */
    const flatCoordss = [];
    for (let i = 0; i < entry.flatCoordss.length; ++i) {
      const ringCounts = entry.ringsVerticesCounts?.[i];
      if (!ringCounts) {
        continue;
      }
      /** @type {Array<number>} */
      const holes = [];
      let total = 0;
      for (let r = 0; r < ringCounts.length - 1; ++r) {
        total += ringCounts[r];
        holes.push(total);
      }
      flatCoordss.push(
        unwrapPolygonFlatCoordinates(
          entry.flatCoordss[i],
          holes,
          unwrapCenterX,
          worldWidth,
        ),
      );
    }
    newPolygon.entries[uid] = {
      ...entry,
      flatCoordss,
    };
  }
  unwrapped.polygonBatch = newPolygon;

  const pointBatch = batch.pointBatch;
  /** @type {import('./MixedGeometryBatch.js').PointGeometryBatch} */
  const newPoint = {
    entries: {},
    geometriesCount: pointBatch.geometriesCount,
  };
  for (const uid in pointBatch.entries) {
    const entry = pointBatch.entries[uid];
    newPoint.entries[uid] = {
      ...entry,
      flatCoordss: entry.flatCoordss.map((coords) =>
        unwrapFlatCoordinatesX(coords, unwrapCenterX, worldWidth, 2),
      ),
    };
  }
  unwrapped.pointBatch = newPoint;
  return unwrapped;
}

const tmpColor = /** @type {Array<number>} */ ([]);

/**
 * @typedef {Object} GenerateBuffersOptions
 * @property {boolean} [skipText] Skip GPU glyph buffer generation.
 * @property {number} [maxSegmentLength] Densify long segments before upload (source units).
 * @property {number} [maxTriangleEdgeLength] Skip fill triangles with |Δx| longer
 *     than this (source units); antimeridian-spanning diagonals when reprojecting.
 * @property {import("../../extent.js").Extent} [clipExtent] Drop fill triangles
 *     with any vertex outside this source extent when reprojecting.
 * @property {number} [unwrapCenterX] Dateline unwrap center for earcut (source X).
 * @property {number} [worldWidth] Source world width for dateline unwrap and densify span limits.
 * @property {number} [maxTargetTriangleEdgeLength] Drop fill triangles whose
 *     edges exceed this length after projecting to the view CRS.
 * @property {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} [projectToTarget]
 *     Source→target for fill clipping and for baking line-label angles under reprojection.
 * @property {number} [viewRotation] View rotation for text-rotate-with-view labels.
 */

/** @type {Worker|undefined} */
let WEBGL_WORKER;
function getWebGLWorker() {
  if (!WEBGL_WORKER) {
    WEBGL_WORKER = createWebGLWorker();
  }
  return WEBGL_WORKER;
}

let workerMessageCounter = 0;

/**
 *
 * @param {Worker} worker Worker to send the message to
 * @param {Object} message Message
 * @param {Array<Transferable>} [transferables] Transferables
 * @return {Promise<Object>} Response received by the worker
 */
function messageWorker(worker, message, transferables) {
  const messageId = workerMessageCounter++;

  if (transferables) {
    worker.postMessage({...message, id: messageId}, transferables);
  } else {
    worker.postMessage({...message, id: messageId});
  }

  return new Promise((resolve) => {
    const handleMessage = (/** @type {MessageEvent} */ event) => {
      const received = event.data;

      // this is not the response to our request: skip
      if (received.id !== messageId) {
        return;
      }

      // we've received our response: stop listening
      worker.removeEventListener('message', handleMessage);

      resolve(received);
    };

    worker.addEventListener('message', handleMessage);
  });
}

/**
 * Names of attributes made available to the vertex shader.
 * Please note: changing these *will* break custom shaders!
 * @enum {string}
 */
export const Attributes = {
  POSITION: 'a_position',
  LOCAL_POSITION: 'a_localPosition',
  SEGMENT_START: 'a_segmentStart',
  SEGMENT_END: 'a_segmentEnd',
  MEASURE_START: 'a_measureStart',
  MEASURE_END: 'a_measureEnd',
  ANGLE_TANGENT_SUM: 'a_angleTangentSum',
  JOIN_ANGLES: 'a_joinAngles',
  DISTANCE_LOW: 'a_distanceLow',
  DISTANCE_HIGH: 'a_distanceHigh',
};

/**
 * @typedef {Object} AttributeDefinition A description of a custom attribute to be passed on to the GPU, with a value different
 * for each feature.
 * @property {number} [size] Amount of numerical values composing the attribute, either 1, 2, 3 or 4; in case size is > 1, the return value
 * of the callback should be an array; if unspecified, assumed to be a single float value
 * @property {function(this:import("./MixedGeometryBatch.js").GeometryBatchItem, import("../../Feature.js").FeatureLike):number|Array<number>} callback This callback computes the numerical value of the
 * attribute for a given feature.
 */

/**
 * @typedef {Object<string, AttributeDefinition>} AttributeDefinitions
 * @typedef {Object<string, import("../../webgl/Helper.js").UniformValue>} UniformDefinitions
 */

/**
 * @typedef {Array<WebGLArrayBuffer>} WebGLArrayBufferSet Buffers organized like so: [indicesBuffer, vertexAttributesBuffer, instanceAttributesBuffer]
 */

/**
 * @typedef {Object} WebGLBuffers
 * Anything set to null means there's nothing to render for that category.
 * @property {WebGLArrayBufferSet|null} polygonBuffers Array containing indices and vertices buffers for polygons
 * @property {WebGLArrayBufferSet|null} lineStringBuffers Array containing indices and vertices buffers for line strings
 * @property {WebGLArrayBufferSet|null} pointBuffers Array containing indices and vertices buffers for points
 * @property {WebGLArrayBufferSet|null} glyphBuffers Array containing indices and instance buffers for text glyphs
 * @property {import("../../transform.js").Transform} invertVerticesTransform Inverse of the transform applied when generating buffers
 */

/**
 * @typedef {Object} RenderInstructions
 * @property {Float32Array|null} polygonInstructions Polygon instructions; null if nothing to render
 * @property {Float32Array|null} lineStringInstructions LineString instructions; null if nothing to render
 * @property {Float32Array|null} pointInstructions Point instructions; null if nothing to render
 */

/**
 * @typedef {Object} ShaderProgram An object containing both shaders (vertex and fragment)
 * @property {string} vertex Vertex shader source
 * @property {string} fragment Fragment shader source
 */

/**
 * @typedef {import('./style.js').StyleParseResult} StyleShaders
 */

/**
 * @typedef {import('../../style/flat.js').FlatStyleLike} FlatStyleLike
 */
/**
 * @typedef {import('../../style/flat.js').FlatStyle} FlatStyle
 */
/**
 * @typedef {import('../../style/flat.js').Rule} FlatStyleRule
 */

/**
 * @typedef {Object} SubRenderPass
 * @property {string} vertexShader Vertex shader
 * @property {string} fragmentShader Fragment shader
 * @property {Array<import('../../webgl/Helper.js').AttributeDescription>} attributesDesc Attributes description, defined for each primitive vertex
 * @property {Array<import('../../webgl/Helper.js').AttributeDescription>} instancedAttributesDesc Attributes description, defined once per primitive
 * @property {number} instancePrimitiveVertexCount Number of vertices per instance primitive in this render pass
 * @property {WebGLProgram} [program] Program; this has to be recreated if the helper is lost/changed
 */

/**
 * @typedef {Object} RenderPass
 * @property {SubRenderPass} [fillRenderPass] Fill render pass; undefined if no fill in pass
 * @property {SubRenderPass} [strokeRenderPass] Stroke render pass; undefined if no stroke in pass
 * @property {SubRenderPass} [symbolRenderPass] Symbol render pass; undefined if no symbol in pass
 * @property {SubRenderPass} [textRenderPass] Text glyph render pass; undefined if no text
 */

/**
 * @classdesc This class is responsible for:
 * 1. generating WebGL buffers according to a provided style, using a MixedGeometryBatch as input
 * 2. rendering geometries contained in said buffers
 *
 * A VectorStyleRenderer instance can be created either from a literal style or from shaders.
 * The shaders should not be provided explicitly but instead as a preconfigured ShaderBuilder instance.
 *
 * The `generateBuffers` method returns a promise resolving to WebGL buffers that are intended to be rendered by the
 * same renderer.
 */
class VectorStyleRenderer extends Disposable {
  /**
   * @param {FlatStyleLike|StyleShaders|Array<StyleShaders>} styles Vector styles expressed as flat styles, flat style rules or style shaders
   * @param {import('../../style/flat.js').StyleVariables} variables Style variables
   * @param {import('../../webgl/Helper.js').default} helper Helper
   * @param {boolean} [enableHitDetection] Whether to enable the hit detection (needs compatible shader)
   */
  constructor(styles, variables, helper, enableHitDetection) {
    super();

    /**
     * @private
     * @type {import('../../webgl/Helper.js').default}
     */
    this.helper_;

    /**
     * @private
     */
    this.hitDetectionEnabled_ = !!enableHitDetection;

    /**
     * Flat style like; if shaders are given as input, will use the `sourceRule` property of the shaders
     * `null` if no Flat style equivalent is available (e.g. custom-made shaders); in that case no text rendering will happen
     * @type {FlatStyleLike|null}
     */
    this.flatStyle = toFlatStyleLike(styles);

    /**
     * @type {Array<StyleShaders>}
     * @private
     */
    this.styleShaders = convertStyleToShaders(styles, variables);

    /**
     * @type {AttributeDefinitions}
     * @private
     */
    this.customAttributes_ = {};

    /**
     @type {UniformDefinitions}
     * @private
     */
    this.uniforms_ = {};

    // add hit detection attribute if enabled
    if (this.hitDetectionEnabled_) {
      this.customAttributes_['hitColor'] = {
        callback() {
          return colorEncodeIdAndPack(this.ref ?? 0, tmpColor);
        },
        size: 2,
      };
    }

    // add attributes & uniforms coming from all shaders
    for (const styleShader of this.styleShaders) {
      for (const attributeName in styleShader.attributes) {
        if (attributeName in this.customAttributes_) {
          // already defined: skip
          continue;
        }
        this.customAttributes_[attributeName] =
          styleShader.attributes[attributeName];
      }
      for (const uniformName in styleShader.uniforms) {
        if (uniformName in this.uniforms_) {
          // already defined: skip
          continue;
        }
        this.uniforms_[uniformName] = styleShader.uniforms[uniformName];
      }
    }

    // create a render pass for each shader
    /**
     * @type {Array<RenderPass>}
     * @private
     */
    this.renderPasses_ = this.styleShaders.map((styleShader) => {
      /** @type {RenderPass} */
      const renderPass = {};

      const customAttributesDesc = Object.entries(this.customAttributes_).map(
        ([name, value]) => {
          const isUsed = name in styleShader.attributes || name === 'hitColor';
          return {
            name: isUsed ? `a_${name}` : null, // giving a null name means this is only used for "spacing" in between attributes
            size: value.size || 1,
            type: AttributeType.FLOAT,
          };
        },
      );

      // set up each subpass
      if (styleShader.builder.getFillVertexShader()) {
        renderPass.fillRenderPass = {
          vertexShader: /** @type {string} */ (
            styleShader.builder.getFillVertexShader()
          ),
          fragmentShader: /** @type {string} */ (
            styleShader.builder.getFillFragmentShader()
          ),
          attributesDesc: [
            {
              name: Attributes.POSITION,
              size: 2,
              type: AttributeType.FLOAT,
            },
            ...customAttributesDesc,
          ],
          instancedAttributesDesc: [], // no instanced rendering for polygons
          instancePrimitiveVertexCount: 3,
        };
      }
      if (styleShader.builder.getStrokeVertexShader()) {
        renderPass.strokeRenderPass = {
          vertexShader: /** @type {string} */ (
            styleShader.builder.getStrokeVertexShader()
          ),
          fragmentShader: /** @type {string} */ (
            styleShader.builder.getStrokeFragmentShader()
          ),
          attributesDesc: [
            {
              name: Attributes.LOCAL_POSITION,
              size: 2,
              type: AttributeType.FLOAT,
            },
          ],
          instancedAttributesDesc: [
            {
              name: Attributes.SEGMENT_START,
              size: 2,
              type: AttributeType.FLOAT,
            },
            {
              name: Attributes.MEASURE_START,
              size: 1,
              type: AttributeType.FLOAT,
            },
            {
              name: Attributes.SEGMENT_END,
              size: 2,
              type: AttributeType.FLOAT,
            },
            {
              name: Attributes.MEASURE_END,
              size: 1,
              type: AttributeType.FLOAT,
            },
            {
              name: Attributes.JOIN_ANGLES,
              size: 2,
              type: AttributeType.FLOAT,
            },
            {
              name: Attributes.DISTANCE_LOW,
              size: 1,
              type: AttributeType.FLOAT,
            },
            {
              name: Attributes.DISTANCE_HIGH,
              size: 1,
              type: AttributeType.FLOAT,
            },
            {
              name: Attributes.ANGLE_TANGENT_SUM,
              size: 1,
              type: AttributeType.FLOAT,
            },
            ...customAttributesDesc,
          ],
          instancePrimitiveVertexCount: 6,
        };
      }
      if (styleShader.builder.getSymbolVertexShader()) {
        renderPass.symbolRenderPass = {
          vertexShader: /** @type {string} */ (
            styleShader.builder.getSymbolVertexShader()
          ),
          fragmentShader: /** @type {string} */ (
            styleShader.builder.getSymbolFragmentShader()
          ),
          attributesDesc: [
            {
              name: Attributes.LOCAL_POSITION,
              size: 2,
              type: AttributeType.FLOAT,
            },
          ],
          instancedAttributesDesc: [
            {
              name: Attributes.POSITION,
              size: 2,
              type: AttributeType.FLOAT,
            },
            ...customAttributesDesc,
          ],
          instancePrimitiveVertexCount: 6,
        };
      }
      return renderPass;
    });

    this.hasFill_ = this.renderPasses_.some((pass) => pass.fillRenderPass);
    this.hasStroke_ = this.renderPasses_.some((pass) => pass.strokeRenderPass);
    this.hasSymbol_ = this.renderPasses_.some((pass) => pass.symbolRenderPass);
    this.hasText_ = this.flatStyle && hasTextStyle(this.flatStyle);

    /**
     * @type {SubRenderPass|null}
     * @private
     */
    this.textRenderPass_ = null;

    /**
     * @type {FontAtlas|null}
     * @private
     */
    this.fontAtlas_ = null;

    /**
     * @type {WebGLTexture|null}
     * @private
     */
    this.atlasTexture_ = null;

    /**
     * @type {boolean}
     * @private
     */
    this.atlasUploaded_ = false;

    /**
     * @type {import('../../style/Style.js').StyleFunction|null}
     * @private
     */
    this.textStyleFunction_ = null;

    if (this.hasText_) {
      this.fontAtlas_ = new FontAtlas();
      // Evaluate only text-* properties so fill/stroke/circle exprs that
      // reference missing feature props do not throw during glyph layout.
      const textFlatStyle = stripNonTextStyleProperties(
        structuredClone(
          /** @type {import('../../style/flat.js').FlatStyleLike} */ (
            this.flatStyle
          ),
        ),
      );
      this.textStyleFunction_ = flatStyleLikeToStyleFunction(textFlatStyle);
      this.textRenderPass_ = {
        vertexShader: getGlyphVertexShader(),
        fragmentShader: getGlyphFragmentShader(),
        attributesDesc: [
          {
            name: GlyphAttributes.LOCAL_POSITION,
            size: 2,
            type: AttributeType.FLOAT,
          },
        ],
        instancedAttributesDesc: [
          {name: GlyphAttributes.POSITION, size: 2, type: AttributeType.FLOAT},
          {name: GlyphAttributes.OFFSET, size: 2, type: AttributeType.FLOAT},
          {name: GlyphAttributes.SIZE, size: 2, type: AttributeType.FLOAT},
          {name: GlyphAttributes.TEX_COORD, size: 4, type: AttributeType.FLOAT},
          {name: GlyphAttributes.COLOR, size: 4, type: AttributeType.FLOAT},
          {name: GlyphAttributes.ANGLE, size: 1, type: AttributeType.FLOAT},
        ],
        instancePrimitiveVertexCount: 6,
      };
      // Atlas texture is bound explicitly in the glyph pass (not via helper
      // uniforms) so it is not overwritten by other texture slots.
    }

    // this will initialize render passes with the given helper
    this.setHelper(helper);
  }

  /**
   * @param {import('./MixedGeometryBatch.js').default} geometryBatch Geometry batch
   * @param {import("../../transform.js").Transform} transform Transform to apply to coordinates
   * @param {number} resolution View resolution; used for text render instructions if any
   * @param {GenerateBuffersOptions} [options] Buffer generation options
   * @return {Promise<WebGLBuffers>} A promise resolving to WebGL buffers; buffer sets are set to `null` if nothing to render
   */
  async generateBuffers(geometryBatch, transform, resolution, options) {
    // also return the inverse of the transform that was applied when generating buffers
    const invertVerticesTransform = makeInverseTransform(
      createTransform(),
      transform,
    );

    if (geometryBatch.isEmpty()) {
      return {
        polygonBuffers: null,
        lineStringBuffers: null,
        pointBuffers: null,
        glyphBuffers: null,
        invertVerticesTransform: invertVerticesTransform,
      };
    }
    const skipText = options?.skipText;
    const projectToTarget = options?.projectToTarget;
    const maxSegmentLength = options?.maxSegmentLength || 0;
    // Unwrap before densify so midpoints are inserted on the short arc.
    let batchForBuffers = geometryBatch;
    if (
      options?.unwrapCenterX !== undefined &&
      options?.worldWidth &&
      options.worldWidth > 0
    ) {
      batchForBuffers = unwrapGeometryBatchX(
        batchForBuffers,
        options.unwrapCenterX,
        options.worldWidth,
      );
    }
    if (maxSegmentLength > 0) {
      // Half-world span: never densify antimeridian chords the long way.
      const maxSpanX =
        options?.worldWidth && options.worldWidth > 0
          ? options.worldWidth * 0.5
          : 0;
      batchForBuffers = densifyGeometryBatch(
        batchForBuffers,
        maxSegmentLength,
        maxSpanX,
      );
    }

    const gpuLabelsArray = new LabelsArray();
    const renderInstructions = this.generateRenderInstructions_(
      batchForBuffers,
      gpuLabelsArray,
      transform,
    );

    /** @type {Promise<WebGLArrayBufferSet|null>|null} */
    let glyphBuffersPromise = null;
    if (
      this.hasText_ &&
      !skipText &&
      this.textStyleFunction_ &&
      this.fontAtlas_
    ) {
      glyphBuffersPromise = Promise.resolve(
        this.generateGlyphBuffers_(
          batchForBuffers,
          transform,
          resolution || 1,
          projectToTarget,
          options?.viewRotation || 0,
        ),
      );
    }

    const [glyphBuffers, polygonBuffers, lineStringBuffers, pointBuffers] =
      await Promise.all([
        glyphBuffersPromise,
        this.hasFill_
          ? this.generateBuffersForType_(
              renderInstructions.polygonInstructions,
              'Polygon',
              transform,
              options?.maxTriangleEdgeLength || 0,
              options?.clipExtent || null,
              options?.unwrapCenterX,
              options?.worldWidth || 0,
              options?.maxTargetTriangleEdgeLength || 0,
              projectToTarget,
            )
          : null,
        this.hasStroke_
          ? this.generateBuffersForType_(
              renderInstructions.lineStringInstructions,
              'LineString',
              transform,
            )
          : null,
        this.hasSymbol_
          ? this.generateBuffersForType_(
              renderInstructions.pointInstructions,
              'Point',
              transform,
            )
          : null,
      ]);
    return {
      polygonBuffers: polygonBuffers ?? null,
      lineStringBuffers: lineStringBuffers ?? null,
      pointBuffers: pointBuffers ?? null,
      glyphBuffers: glyphBuffers ?? null,
      invertVerticesTransform: invertVerticesTransform,
    };
  }

  /**
   * @param {import('./MixedGeometryBatch.js').default} batch Geometry batch
   * @param {import("../../transform.js").Transform} transform Transform
   * @param {number} resolution View resolution
   * @param {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} [projectToTarget]
   *     Optional exact forward projection for line label angles.
   * @param {number} [viewRotation] View rotation for rotate-with-view.
   * @return {WebGLArrayBufferSet|null} Glyph buffers
   * @private
   */
  generateGlyphBuffers_(
    batch,
    transform,
    resolution,
    projectToTarget,
    viewRotation,
  ) {
    const instanceAttrs = generateGlyphInstanceAttributes(
      batch,
      /** @type {import('../../style/Style.js').StyleFunction} */ (
        this.textStyleFunction_
      ),
      transform,
      {
        atlas: /** @type {FontAtlas} */ (this.fontAtlas_),
        resolution,
        viewRotation: viewRotation || 0,
        projectToTarget,
      },
    );
    if (!instanceAttrs.length) {
      return null;
    }
    const mesh = createGlyphQuadMesh();
    const indicesBuffer = new WebGLArrayBuffer(
      ELEMENT_ARRAY_BUFFER,
      DYNAMIC_DRAW,
    ).fromArrayBuffer(/** @type {ArrayBuffer} */ (mesh.indices.buffer));
    const vertexAttributesBuffer = new WebGLArrayBuffer(
      ARRAY_BUFFER,
      DYNAMIC_DRAW,
    ).fromArrayBuffer(
      /** @type {ArrayBuffer} */ (mesh.vertexAttributes.buffer),
    );
    const instanceAttributesBuffer = new WebGLArrayBuffer(
      ARRAY_BUFFER,
      DYNAMIC_DRAW,
    ).fromArrayBuffer(/** @type {ArrayBuffer} */ (instanceAttrs.buffer));
    this.helper_.flushBufferData(indicesBuffer);
    this.helper_.flushBufferData(vertexAttributesBuffer);
    this.helper_.flushBufferData(instanceAttributesBuffer);
    return [indicesBuffer, vertexAttributesBuffer, instanceAttributesBuffer];
  }

  /**
   * @param {import('./MixedGeometryBatch.js').default} geometryBatch Geometry batch
   * @param {LabelsArray} labelsArray Labels array
   * @param {import("../../transform.js").Transform} transform Transform to apply to coordinates
   * @return {RenderInstructions} Render instructions
   * @private
   */
  generateRenderInstructions_(geometryBatch, labelsArray, transform) {
    const polygonInstructions = this.hasFill_
      ? generatePolygonRenderInstructions(
          geometryBatch.polygonBatch,
          new Float32Array(0),
          labelsArray,
          this.customAttributes_,
          transform,
        )
      : null;
    const lineStringInstructions = this.hasStroke_
      ? generateLineStringRenderInstructions(
          geometryBatch.lineStringBatch,
          new Float32Array(0),
          labelsArray,
          this.customAttributes_,
          transform,
        )
      : null;
    const pointInstructions = this.hasSymbol_
      ? generatePointRenderInstructions(
          geometryBatch.pointBatch,
          new Float32Array(0),
          labelsArray,
          this.customAttributes_,
          transform,
        )
      : null;

    return {
      polygonInstructions,
      lineStringInstructions,
      pointInstructions,
    };
  }

  /**
   * @param {Float32Array|null} renderInstructions Render instructions
   * @param {import("../../geom/Geometry.js").Type} geometryType Geometry type
   * @param {import("../../transform.js").Transform} transform Transform to apply to coordinates
   * @param {number} [maxTriangleEdgeLength] Max fill triangle |Δx| (source units).
   * @param {import("../../extent.js").Extent|null} [clipExtent] Cull fill triangles outside extent.
   * @param {number} [unwrapCenterX] Dateline unwrap center for earcut.
   * @param {number} [worldWidth] Source world width for unwrap.
   * @param {number} [maxTargetTriangleEdgeLength] Max edge length in target CRS.
   * @param {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} [projectToTarget] Source→target.
   * @return {Promise<WebGLArrayBufferSet|undefined>|null} Indices buffer and vertices buffer; null if nothing to render
   * @private
   */
  generateBuffersForType_(
    renderInstructions,
    geometryType,
    transform,
    maxTriangleEdgeLength,
    clipExtent,
    unwrapCenterX,
    worldWidth,
    maxTargetTriangleEdgeLength,
    projectToTarget,
  ) {
    if (renderInstructions === null) {
      return null;
    }

    // Target-space earcut needs projectToTarget on the main thread (worker
    // has no projection/warp field). Vertex XY are then rewritten to target
    // CRS so GPU edges match the triangulation (warp disabled at fill draw).
    if (geometryType === 'Polygon' && projectToTarget) {
      return Promise.resolve().then(() => {
        if (!this.helper_.getGL()) {
          return;
        }
        const customAttributesSize = getCustomAttributesSize(
          this.customAttributes_,
        );
        /** @type {Array<number>} */
        const vertices = [];
        /** @type {Array<number>} */
        const indices = [];
        let offset = 0;
        while (offset < renderInstructions.length) {
          offset = writePolygonTrianglesToBuffers(
            renderInstructions,
            offset,
            vertices,
            indices,
            customAttributesSize,
            maxTriangleEdgeLength || 0,
            clipExtent || null,
            unwrapCenterX,
            worldWidth || 0,
            projectToTarget,
          );
        }
        const attrsPerVertex = 2 + customAttributesSize;
        const refined =
          maxTargetTriangleEdgeLength > 0
            ? filterTrianglesByTargetEdge(
                Float32Array.from(vertices),
                Uint32Array.from(indices),
                attrsPerVertex,
                projectToTarget,
                maxTargetTriangleEdgeLength,
              )
            : {
                vertices: Float32Array.from(vertices),
                indices: Uint32Array.from(indices),
              };
        // Keep source XY so fill and stroke share the same GPU warp path
        // (preprojecting fill alone left fill/stroke gaps).
        const indicesBuffer = new WebGLArrayBuffer(
          ELEMENT_ARRAY_BUFFER,
          DYNAMIC_DRAW,
        ).fromArrayBuffer(
          refined.indices.buffer.slice(0, refined.indices.byteLength),
        );
        const vertexAttributesBuffer = new WebGLArrayBuffer(
          ARRAY_BUFFER,
          DYNAMIC_DRAW,
        ).fromArrayBuffer(
          refined.vertices.buffer.slice(0, refined.vertices.byteLength),
        );
        const instanceAttributesBuffer = new WebGLArrayBuffer(
          ARRAY_BUFFER,
          DYNAMIC_DRAW,
        ).fromArrayBuffer(new Float32Array(0).buffer);
        this.helper_.flushBufferData(indicesBuffer);
        this.helper_.flushBufferData(vertexAttributesBuffer);
        this.helper_.flushBufferData(instanceAttributesBuffer);
        return [
          indicesBuffer,
          vertexAttributesBuffer,
          instanceAttributesBuffer,
        ];
      });
    }

    let messageType;
    switch (geometryType) {
      case 'Polygon':
        messageType = WebGLWorkerMessageType.GENERATE_POLYGON_BUFFERS;
        break;
      case 'LineString':
        messageType = WebGLWorkerMessageType.GENERATE_LINE_STRING_BUFFERS;
        break;
      case 'Point':
        messageType = WebGLWorkerMessageType.GENERATE_POINT_BUFFERS;
        break;
      default:
        return null;
    }

    /** @type {import('./constants.js').WebGLWorkerGenerateBuffersMessage} */
    const message = {
      type: messageType,
      renderInstructions: renderInstructions.buffer,
      renderInstructionsTransform: transform,
      customAttributesSize: getCustomAttributesSize(this.customAttributes_),
      maxTriangleEdgeLength: maxTriangleEdgeLength || 0,
      clipExtent: clipExtent || undefined,
      unwrapCenterX,
      worldWidth: worldWidth || 0,
    };

    return messageWorker(getWebGLWorker(), message, [
      renderInstructions.buffer,
    ]).then((data) => {
      // the helper has disposed in the meantime; the promise will not be resolved
      if (!this.helper_.getGL()) {
        return;
      }

      const received =
        /** @type {import('./constants.js').WebGLWorkerGenerateBuffersMessage} */ (
          data
        );

      // copy & flush received buffers to GPU
      if (
        !received.indicesBuffer ||
        !received.vertexAttributesBuffer ||
        !received.instanceAttributesBuffer
      ) {
        return;
      }
      const indicesBuffer = new WebGLArrayBuffer(
        ELEMENT_ARRAY_BUFFER,
        DYNAMIC_DRAW,
      ).fromArrayBuffer(received.indicesBuffer);
      const vertexAttributesBuffer = new WebGLArrayBuffer(
        ARRAY_BUFFER,
        DYNAMIC_DRAW,
      ).fromArrayBuffer(received.vertexAttributesBuffer);
      const instanceAttributesBuffer = new WebGLArrayBuffer(
        ARRAY_BUFFER,
        DYNAMIC_DRAW,
      ).fromArrayBuffer(received.instanceAttributesBuffer);
      this.helper_.flushBufferData(indicesBuffer);
      this.helper_.flushBufferData(vertexAttributesBuffer);
      this.helper_.flushBufferData(instanceAttributesBuffer);

      return [indicesBuffer, vertexAttributesBuffer, instanceAttributesBuffer];
    });
  }

  /**
   * Render the geometries in the given buffers.
   * @param {WebGLBuffers} buffers WebGL Buffers to draw
   * @param {import("../../Map.js").FrameState} frameState Frame state
   * @param {function(): void} preRenderCallback This callback will be called right before drawing, and can be used to set uniforms
   */
  render(buffers, frameState, preRenderCallback) {
    for (const renderPass of this.renderPasses_) {
      renderPass.fillRenderPass &&
        buffers.polygonBuffers &&
        this.renderInternal_(
          buffers.polygonBuffers[0],
          buffers.polygonBuffers[1],
          buffers.polygonBuffers[2],
          renderPass.fillRenderPass,
          frameState,
          preRenderCallback,
        );
      renderPass.strokeRenderPass &&
        buffers.lineStringBuffers &&
        this.renderInternal_(
          buffers.lineStringBuffers[0],
          buffers.lineStringBuffers[1],
          buffers.lineStringBuffers[2],
          renderPass.strokeRenderPass,
          frameState,
          preRenderCallback,
        );
      renderPass.symbolRenderPass &&
        buffers.pointBuffers &&
        this.renderInternal_(
          buffers.pointBuffers[0],
          buffers.pointBuffers[1],
          buffers.pointBuffers[2],
          renderPass.symbolRenderPass,
          frameState,
          preRenderCallback,
        );
    }
    if (this.textRenderPass_ && buffers.glyphBuffers) {
      this.renderInternal_(
        buffers.glyphBuffers[0],
        buffers.glyphBuffers[1],
        buffers.glyphBuffers[2],
        this.textRenderPass_,
        frameState,
        () => {
          preRenderCallback();
          this.bindGlyphAtlas_();
        },
      );
    }
  }

  /**
   * Upload/bind the font atlas for the glyph render pass.
   * @private
   */
  bindGlyphAtlas_() {
    if (!this.fontAtlas_ || !this.helper_) {
      return;
    }
    const gl = this.helper_.getGL();
    if (!this.atlasTexture_) {
      this.atlasTexture_ = gl.createTexture();
    }
    const atlas = this.fontAtlas_;
    this.helper_.bindTexture(
      this.atlasTexture_,
      0,
      GlyphUniforms.ATLAS,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (atlas.isDirty() || !this.atlasUploaded_) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        /** @type {TexImageSource} */ (atlas.canvas),
      );
      this.atlasUploaded_ = true;
      atlas.markClean();
    }
    this.helper_.setUniformFloatVec2(
      GlyphUniforms.ATLAS_SIZE,
      atlas.getSize(),
    );
  }

  /**
   * @param {WebGLArrayBuffer} indicesBuffer Indices buffer
   * @param {WebGLArrayBuffer} vertexAttributesBuffer Vertex attributes buffer
   * @param {WebGLArrayBuffer} instanceAttributesBuffer Instance attributes buffer
   * @param {SubRenderPass} subRenderPass Render pass (program, attributes, etc.) specific to one geometry type
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {function(): void} preRenderCallback This callback will be called right before drawing, and can be used to set uniforms
   * @private
   */
  renderInternal_(
    indicesBuffer,
    vertexAttributesBuffer,
    instanceAttributesBuffer,
    subRenderPass,
    frameState,
    preRenderCallback,
  ) {
    const renderCount = indicesBuffer.getSize();
    if (renderCount === 0) {
      return;
    }

    const usesInstancedRendering = subRenderPass.instancedAttributesDesc.length;

    const program = subRenderPass.program;
    if (!program) {
      return;
    }

    this.helper_.useProgram(program, frameState);
    this.helper_.bindBuffer(vertexAttributesBuffer);
    this.helper_.bindBuffer(indicesBuffer);
    this.helper_.enableAttributes(subRenderPass.attributesDesc);
    this.helper_.bindBuffer(instanceAttributesBuffer);
    this.helper_.enableAttributesInstanced(
      subRenderPass.instancedAttributesDesc,
    );

    preRenderCallback();

    if (usesInstancedRendering) {
      const instanceAttributesStride =
        subRenderPass.instancedAttributesDesc.reduce(
          (prev, curr) => prev + (curr.size || 1),
          0,
        );
      const instanceCount =
        instanceAttributesBuffer.getSize() / instanceAttributesStride;

      this.helper_.drawElementsInstanced(0, renderCount, instanceCount);
    } else {
      this.helper_.drawElements(0, renderCount);
    }
  }

  /**
   * @param {import('../../webgl/Helper.js').default} helper Helper
   * @param {WebGLBuffers|null} [buffers] WebGL Buffers to reload if any
   */
  setHelper(helper, buffers = null) {
    this.helper_ = helper;

    for (const renderPass of this.renderPasses_) {
      if (renderPass.fillRenderPass) {
        renderPass.fillRenderPass.program = this.helper_.getProgram(
          renderPass.fillRenderPass.fragmentShader,
          renderPass.fillRenderPass.vertexShader,
        );
      }
      if (renderPass.strokeRenderPass) {
        renderPass.strokeRenderPass.program = this.helper_.getProgram(
          renderPass.strokeRenderPass.fragmentShader,
          renderPass.strokeRenderPass.vertexShader,
        );
      }
      if (renderPass.symbolRenderPass) {
        renderPass.symbolRenderPass.program = this.helper_.getProgram(
          renderPass.symbolRenderPass.fragmentShader,
          renderPass.symbolRenderPass.vertexShader,
        );
      }
    }
    if (this.textRenderPass_) {
      this.textRenderPass_.program = this.helper_.getProgram(
        this.textRenderPass_.fragmentShader,
        this.textRenderPass_.vertexShader,
      );
    }
    this.helper_.addUniforms(this.uniforms_);

    if (buffers) {
      if (buffers.polygonBuffers) {
        this.helper_.flushBufferData(buffers.polygonBuffers[0]);
        this.helper_.flushBufferData(buffers.polygonBuffers[1]);
        this.helper_.flushBufferData(buffers.polygonBuffers[2]);
      }
      if (buffers.lineStringBuffers) {
        this.helper_.flushBufferData(buffers.lineStringBuffers[0]);
        this.helper_.flushBufferData(buffers.lineStringBuffers[1]);
        this.helper_.flushBufferData(buffers.lineStringBuffers[2]);
      }
      if (buffers.pointBuffers) {
        this.helper_.flushBufferData(buffers.pointBuffers[0]);
        this.helper_.flushBufferData(buffers.pointBuffers[1]);
        this.helper_.flushBufferData(buffers.pointBuffers[2]);
      }
      if (buffers.glyphBuffers) {
        this.helper_.flushBufferData(buffers.glyphBuffers[0]);
        this.helper_.flushBufferData(buffers.glyphBuffers[1]);
        this.helper_.flushBufferData(buffers.glyphBuffers[2]);
      }
    }
  }

  /**
   * Clean up.
   * @override
   */
  disposeInternal() {
    super.disposeInternal();
  }
}

export default VectorStyleRenderer;

/**
 * @param {FlatStyleLike|StyleShaders|Array<StyleShaders>} styleOrShaders Either a flat style or shaders
 * @return {FlatStyleLike|null} Will return null if the original flat style could not be found
 */
export function toFlatStyleLike(styleOrShaders) {
  if (Array.isArray(styleOrShaders)) {
    // if it's an array of shaders but at least one has no source rule, we can't return a flat style like
    if (styleOrShaders.some((s) => 'builder' in s && !('sourceRule' in s))) {
      return null;
    }
    if (styleOrShaders.some((s) => 'builder' in s)) {
      return styleOrShaders.flatMap((style) => {
        const sourceRule = /** @type {StyleShaders} */ (style).sourceRule;
        return sourceRule ? [sourceRule] : [];
      });
    }
    return /** @type {FlatStyleLike} */ (styleOrShaders);
  }
  if ('builder' in styleOrShaders) {
    if (!('sourceRule' in styleOrShaders)) {
      return null;
    }
    const sourceRule = /** @type {StyleShaders} */ (styleOrShaders).sourceRule;
    if (!sourceRule) {
      return null;
    }
    return [sourceRule];
  }
  return styleOrShaders;
}

/**
 * Breaks down a vector style into an array of prebuilt shader builders with attributes and uniforms
 * @param {FlatStyleLike|StyleShaders|Array<StyleShaders>} style Vector style
 * @param {import('../../style/flat.js').StyleVariables} variables Style variables
 * @return {Array<StyleShaders>} Array of style shaders
 */
export function convertStyleToShaders(style, variables) {
  // possible cases:
  // - single shader
  // - multiple shaders
  // - single style
  // - multiple styles
  // - multiple rules
  const asArray = Array.isArray(style) ? style : [style];

  // if array of rules: break rules into separate styles, compute "else" filters
  if ('style' in asArray[0]) {
    /** @type {Array<StyleShaders>} */
    const shaders = [];
    const rules = /** @type {Array<FlatStyleRule>} */ (asArray);
    const previousFilters = [];
    for (const rule of rules) {
      /** @type {Array<FlatStyle>} */
      const ruleStyles = Array.isArray(rule.style) ? rule.style : [rule.style];
      /** @type {import("../../expr/expression.js").EncodedExpression|undefined} */
      let currentFilter = rule.filter;
      if (rule.else && previousFilters.length) {
        currentFilter = [
          'all',
          ...previousFilters.map((filter) => ['!', filter]),
        ];
        if (rule.filter) {
          currentFilter.push(rule.filter);
        }
        if (currentFilter.length < 3) {
          currentFilter = currentFilter[1];
        }
      }
      if (rule.filter) {
        previousFilters.push(rule.filter);
      }
      // parse each style and convert to shader
      const styleShaders = ruleStyles.map((style) => ({
        ...parseLiteralStyle(style, variables, currentFilter),
        sourceRule: rule,
      }));
      shaders.push(...styleShaders);
    }
    return shaders;
  }

  // if array of shaders: return as is
  if ('builder' in asArray[0]) {
    return /** @type {Array<StyleShaders>} */ (asArray);
  }

  // array of flat styles: simply convert to shaders
  return /** @type {Array<FlatStyle>} */ (asArray).map((style) => ({
    ...parseLiteralStyle(style, variables, undefined),
    sourceRule: {style},
  }));
}
