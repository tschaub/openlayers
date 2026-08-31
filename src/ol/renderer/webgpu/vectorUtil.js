/**
 * @module ol/renderer/webgpu/vectorUtil
 */
import {
  GLYPH_INSTANCE_STRIDE,
  packGlyphInstances,
} from '../../render/webgpu/glyphLayout.js';
import {projectionMatrixFromFrame} from '../../webgpu/reproj.js';
import {
  GLYPH_SHADER,
  SYMBOL_SHADER,
  VECTOR_FILL_SHADER,
  VECTOR_STROKE_SHADER,
} from '../../webgpu/shaders.js';

export const FILL_STRIDE = 10;
export const STROKE_STRIDE = 13;
export const SYMBOL_STRIDE = 14;
export const FRAME_UNIFORM_SIZE = 96;

/** @type {GPUBlendState} */
const BLEND = {
  color: {
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  },
  alpha: {
    srcFactor: 'one',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  },
};

/**
 * @classdesc
 * GPU buffers created during a draw, destroyed on the next frame.
 */
export class GpuScratch {
  constructor() {
    /**
     * @type {Array<GPUBuffer>}
     */
    this.buffers = [];
  }

  /**
   * @param {import("../../webgpu/Helper.js").default} helper Helper.
   * @param {ArrayBuffer|ArrayBufferView} data Data.
   * @param {number} usage Usage.
   * @return {GPUBuffer} Buffer.
   */
  create(helper, data, usage) {
    const buffer = helper.createBuffer(data, usage);
    this.buffers.push(buffer);
    return buffer;
  }

  destroy() {
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    this.buffers.length = 0;
  }
}

/**
 * @param {import("../../webgpu/Helper.js").default} helper Helper.
 */
export function createVectorPipelines(helper) {
  const format = helper.getFormat();
  const fillModule = helper.createShaderModule(VECTOR_FILL_SHADER);
  helper.getRenderPipeline('vector-fill', {
    layout: 'auto',
    vertex: {
      module: fillModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: FILL_STRIDE * 4,
          attributes: [
            {shaderLocation: 0, offset: 0, format: 'float32x2'},
            {shaderLocation: 1, offset: 8, format: 'float32x4'},
            {shaderLocation: 2, offset: 24, format: 'float32x4'},
          ],
        },
      ],
    },
    fragment: {
      module: fillModule,
      entryPoint: 'fs_main',
      targets: [{format, blend: BLEND}],
    },
    primitive: {topology: 'triangle-list'},
  });

  const strokeModule = helper.createShaderModule(VECTOR_STROKE_SHADER);
  helper.getRenderPipeline('vector-stroke', {
    layout: 'auto',
    vertex: {
      module: strokeModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: STROKE_STRIDE * 4,
          attributes: [
            {shaderLocation: 0, offset: 0, format: 'float32x2'},
            {shaderLocation: 1, offset: 8, format: 'float32x2'},
            {shaderLocation: 2, offset: 16, format: 'float32x4'},
            {shaderLocation: 3, offset: 32, format: 'float32x4'},
            {shaderLocation: 4, offset: 48, format: 'float32'},
          ],
        },
      ],
    },
    fragment: {
      module: strokeModule,
      entryPoint: 'fs_main',
      targets: [{format, blend: BLEND}],
    },
    primitive: {topology: 'triangle-list'},
  });

  const symbolModule = helper.createShaderModule(SYMBOL_SHADER);
  helper.getRenderPipeline('vector-symbol', {
    layout: 'auto',
    vertex: {
      module: symbolModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 8,
          stepMode: 'vertex',
          attributes: [{shaderLocation: 5, offset: 0, format: 'float32x2'}],
        },
        {
          arrayStride: SYMBOL_STRIDE * 4,
          stepMode: 'instance',
          attributes: [
            {shaderLocation: 0, offset: 0, format: 'float32x2'},
            {shaderLocation: 1, offset: 8, format: 'float32x2'},
            {shaderLocation: 2, offset: 16, format: 'float32x2'},
            {shaderLocation: 3, offset: 24, format: 'float32x4'},
            {shaderLocation: 4, offset: 40, format: 'float32x4'},
          ],
        },
      ],
    },
    fragment: {
      module: symbolModule,
      entryPoint: 'fs_main',
      targets: [{format, blend: BLEND}],
    },
    primitive: {topology: 'triangle-strip'},
  });

  const glyphModule = helper.createShaderModule(GLYPH_SHADER);
  helper.getRenderPipeline('vector-glyph', {
    layout: 'auto',
    vertex: {
      module: glyphModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 8,
          stepMode: 'vertex',
          attributes: [{shaderLocation: 8, offset: 0, format: 'float32x2'}],
        },
        {
          arrayStride: GLYPH_INSTANCE_STRIDE * 4,
          stepMode: 'instance',
          attributes: [
            {shaderLocation: 0, offset: 0, format: 'float32x2'},
            {shaderLocation: 1, offset: 8, format: 'float32x2'},
            {shaderLocation: 2, offset: 16, format: 'float32x2'},
            {shaderLocation: 3, offset: 24, format: 'float32x4'},
            {shaderLocation: 4, offset: 40, format: 'float32x4'},
            {shaderLocation: 5, offset: 56, format: 'float32x4'},
            {shaderLocation: 6, offset: 72, format: 'float32x4'},
            {shaderLocation: 7, offset: 88, format: 'float32'},
          ],
        },
      ],
    },
    fragment: {
      module: glyphModule,
      entryPoint: 'fs_main',
      targets: [{format, blend: BLEND}],
    },
    primitive: {topology: 'triangle-strip'},
  });
}

/**
 * @param {import("../../webgpu/Helper.js").default} helper Helper.
 * @param {GPUBuffer} buffer Uniform buffer.
 * @param {Float32Array} data Uniform data.
 * @param {Float32Array} projMat Projection matrix storage.
 * @param {import("../../Map.js").FrameState} frameState Frame.
 * @param {number} hitDetection Hit flag.
 */
export function writeFrameUniforms(
  helper,
  buffer,
  data,
  projMat,
  frameState,
  hitDetection,
) {
  projectionMatrixFromFrame(
    frameState,
    frameState.coordinateToPixelTransform,
    projMat,
  );
  data.fill(0);
  data.set(projMat, 0);
  data[16] = -Infinity;
  data[17] = -Infinity;
  data[18] = Infinity;
  data[19] = Infinity;
  data[20] = frameState.size[0];
  data[21] = frameState.size[1];
  data[22] = frameState.layerStatesArray[frameState.layerIndex].opacity;
  data[23] = hitDetection;
  helper.writeBuffer(buffer, data);
}

/**
 * @param {import("../../webgpu/Helper.js").default} helper Helper.
 * @param {GPUBuffer} uniformBuffer Uniforms.
 * @param {import("../../render/webgpu/buffers.js").VectorBuffers} buffers Buffers.
 * @param {GpuScratch} scratch Scratch.
 */
export function drawFills(helper, uniformBuffer, buffers, scratch) {
  if (!buffers.fillIndices.length) {
    return;
  }
  const pipeline = helper.getRenderPipeline(
    'vector-fill',
    /** @type {any} */ ({}),
  );
  const vbo = scratch.create(
    helper,
    buffers.fillVertices,
    GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  );
  const ibo = scratch.create(
    helper,
    buffers.fillIndices,
    GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  );
  const pass = helper.getRenderPass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    helper.getDevice().createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{binding: 0, resource: {buffer: uniformBuffer}}],
    }),
  );
  pass.setVertexBuffer(0, vbo);
  pass.setIndexBuffer(ibo, 'uint32');
  pass.drawIndexed(buffers.fillIndices.length);
}

/**
 * @param {import("../../webgpu/Helper.js").default} helper Helper.
 * @param {GPUBuffer} uniformBuffer Uniforms.
 * @param {import("../../render/webgpu/buffers.js").VectorBuffers} buffers Buffers.
 * @param {GpuScratch} scratch Scratch.
 */
export function drawStrokes(helper, uniformBuffer, buffers, scratch) {
  if (!buffers.strokeIndices.length) {
    return;
  }
  const pipeline = helper.getRenderPipeline(
    'vector-stroke',
    /** @type {any} */ ({}),
  );
  const vbo = scratch.create(
    helper,
    buffers.strokeVertices,
    GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  );
  const ibo = scratch.create(
    helper,
    buffers.strokeIndices,
    GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  );
  const pass = helper.getRenderPass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    helper.getDevice().createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{binding: 0, resource: {buffer: uniformBuffer}}],
    }),
  );
  pass.setVertexBuffer(0, vbo);
  pass.setIndexBuffer(ibo, 'uint32');
  pass.drawIndexed(buffers.strokeIndices.length);
}

/**
 * @param {import("../../webgpu/Helper.js").default} helper Helper.
 * @param {GPUBuffer} uniformBuffer Uniforms.
 * @param {import("../../render/webgpu/buffers.js").VectorBuffers} buffers Buffers.
 * @param {Array<boolean>} visibility Visibility per label.
 * @param {import("../../webgpu/FontAtlas.js").default} atlas Atlas.
 * @param {GPUBuffer} cornerBuffer Corner quad.
 * @param {GpuScratch} scratch Scratch.
 * @param {import("../../render/webgpu/labelFade.js").LabelFade} [fade] Fade tracker.
 * @param {number} [time] Frame time.
 * @param {number} [maxWorldDistance] Max world distance for fade continuity.
 * @return {boolean} True if a label fade is still running.
 */
export function drawSymbolsAndText(
  helper,
  uniformBuffer,
  buffers,
  visibility,
  atlas,
  cornerBuffer,
  scratch,
  fade,
  time,
  maxWorldDistance,
) {
  const now = time !== undefined ? time : 0;
  const fading = fade
    ? fade.update(buffers.labels, visibility, now, maxWorldDistance)
    : false;
  /** @type {Array<import("../../render/webgpu/glyphLayout.js").GlyphInstance>} */
  const visibleGlyphs = [];
  /** @type {Array<number>} */
  const glyphOpacities = [];
  /** @type {Array<number>} */
  const visibleSymbols = [];
  for (let i = 0; i < buffers.labels.length; ++i) {
    if (visibility[i] === false) {
      continue;
    }
    const label = buffers.labels[i];
    const opacity = fade ? fade.opacity(label.id, now) : 1;
    if (label.glyphCount) {
      for (let g = 0; g < label.glyphCount; ++g) {
        visibleGlyphs.push(buffers.glyphs[(label.glyphStart || 0) + g]);
        glyphOpacities.push(opacity);
      }
    }
    const symbolIndex = /** @type {number|undefined} */ (
      /** @type {any} */ (label).symbolIndex
    );
    if (symbolIndex !== undefined) {
      const o = symbolIndex * SYMBOL_STRIDE;
      if (o + SYMBOL_STRIDE <= buffers.symbolInstances.length) {
        const instance = Array.from(
          buffers.symbolInstances.subarray(o, o + SYMBOL_STRIDE),
        );
        instance[9] *= opacity;
        visibleSymbols.push(...instance);
      }
    }
  }

  if (visibleSymbols.length) {
    const pipeline = helper.getRenderPipeline(
      'vector-symbol',
      /** @type {any} */ ({}),
    );
    const instanceBuffer = scratch.create(
      helper,
      new Float32Array(visibleSymbols),
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    );
    const pass = helper.getRenderPass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      helper.getDevice().createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{binding: 0, resource: {buffer: uniformBuffer}}],
      }),
    );
    pass.setVertexBuffer(0, cornerBuffer);
    pass.setVertexBuffer(1, instanceBuffer);
    pass.draw(4, visibleSymbols.length / SYMBOL_STRIDE);
  }

  if (visibleGlyphs.length) {
    const atlasTexture = atlas.upload(helper);
    const pipeline = helper.getRenderPipeline(
      'vector-glyph',
      /** @type {any} */ ({}),
    );
    const packed = packGlyphInstances(visibleGlyphs, glyphOpacities);
    const instanceBuffer = scratch.create(
      helper,
      packed,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    );
    const pass = helper.getRenderPass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      helper.getDevice().createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          {binding: 0, resource: {buffer: uniformBuffer}},
          {binding: 1, resource: helper.getLinearSampler()},
          {binding: 2, resource: atlasTexture.createView()},
        ],
      }),
    );
    pass.setVertexBuffer(0, cornerBuffer);
    pass.setVertexBuffer(1, instanceBuffer);
    pass.draw(4, visibleGlyphs.length);
  }
  return fading;
}

/**
 * Extra CSS pixels around every declutter box so near-miss labels do not touch.
 * @type {number}
 */
export const LABEL_COLLISION_MARGIN = 2;

/**
 * @param {import("../../render/webgpu/declutter.js").Label} box Box.
 * @param {Array<number>|undefined} padding `[top, right, bottom, left]`.
 * @param {number} margin Extra margin.
 */
function inflateBox(box, padding, margin) {
  const pad = padding || [0, 0, 0, 0];
  box.minX -= pad[3] + margin;
  box.minY -= pad[0] + margin;
  box.maxX += pad[1] + margin;
  box.maxY += pad[2] + margin;
}

/**
 * Convert label AABBs into CSS screen pixels for declutter.
 *
 * @param {import("../../render/webgpu/buffers.js").VectorBuffers} buffers Buffers.
 * @param {import("../../Map.js").FrameState} frameState Frame.
 * @return {Array<import("../../render/webgpu/declutter.js").Label>} Screen labels.
 */
export function labelsToScreen(buffers, frameState) {
  const transform = frameState.coordinateToPixelTransform;
  return buffers.labels.map((label) => {
    const box = {
      minX: label.minX,
      minY: label.minY,
      maxX: label.maxX,
      maxY: label.maxY,
      priority: label.priority,
      id: label.id,
      mode: label.mode,
      pairId: label.pairId,
      padding: label.padding,
      glyphStart: label.glyphStart,
      glyphCount: label.glyphCount,
    };
    const extra = /** @type {any} */ (label);
    const anchor =
      /** @type {import("../../coordinate.js").Coordinate|undefined} */ (
        extra._anchor
      );
    if (label.glyphCount) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let g = 0; g < label.glyphCount; ++g) {
        const glyph = buffers.glyphs[(label.glyphStart || 0) + g];
        const pixel = [
          transform[0] * glyph.x + transform[2] * glyph.y + transform[4],
          transform[1] * glyph.x + transform[3] * glyph.y + transform[5],
        ];
        const x0 = pixel[0] + glyph.offsetX;
        const y0 = pixel[1] + glyph.offsetY;
        minX = Math.min(minX, x0);
        minY = Math.min(minY, y0);
        maxX = Math.max(maxX, x0 + glyph.width);
        maxY = Math.max(maxY, y0 + glyph.height);
      }
      box.minX = minX;
      box.minY = minY;
      box.maxX = maxX;
      box.maxY = maxY;
      inflateBox(box, label.padding, LABEL_COLLISION_MARGIN);
    } else if (anchor) {
      const pixel = [
        transform[0] * anchor[0] + transform[2] * anchor[1] + transform[4],
        transform[1] * anchor[0] + transform[3] * anchor[1] + transform[5],
      ];
      box.minX = pixel[0] + label.minX;
      box.minY = pixel[1] + label.minY;
      box.maxX = pixel[0] + label.maxX;
      box.maxY = pixel[1] + label.maxY;
      inflateBox(box, undefined, LABEL_COLLISION_MARGIN);
    } else {
      inflateBox(box, label.padding, LABEL_COLLISION_MARGIN);
    }
    return box;
  });
}
