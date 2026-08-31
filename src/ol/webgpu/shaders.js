/**
 * @module ol/webgpu/shaders
 */

export const TILE_SHADER = `
struct TileUniforms {
  tileTransform: mat4x4<f32>,
  renderExtent: vec4<f32>,
  depth: f32,
  transitionAlpha: f32,
  texturePixelWidth: f32,
  texturePixelHeight: f32,
  textureResolution: f32,
  globalAlpha: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> uniforms: TileUniforms;
@group(0) @binding(1) var tileSampler: sampler;
@group(0) @binding(2) var tileTexture: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) localMapCoord: vec2<f32>,
}

@vertex
fn vs_main(@location(0) texCoord: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.texCoord = texCoord;
  out.localMapCoord = vec2(
    uniforms.texturePixelWidth * uniforms.textureResolution * texCoord.x,
    -uniforms.texturePixelHeight * uniforms.textureResolution * texCoord.y
  );
  out.position = uniforms.tileTransform * vec4(texCoord, uniforms.depth, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  if (
    in.localMapCoord.x < uniforms.renderExtent[0] ||
    in.localMapCoord.y < uniforms.renderExtent[1] ||
    in.localMapCoord.x > uniforms.renderExtent[2] ||
    in.localMapCoord.y > uniforms.renderExtent[3]
  ) {
    discard;
  }
  var color = textureSample(tileTexture, tileSampler, in.texCoord);
  let alpha = color.a * uniforms.transitionAlpha * uniforms.globalAlpha;
  return vec4(color.rgb * alpha, alpha);
}
`;

export const REPROJ_TILE_SHADER = `
struct ReprojUniforms {
  projectionMatrix: mat4x4<f32>,
  renderExtent: vec4<f32>,
  depth: f32,
  transitionAlpha: f32,
  globalAlpha: f32,
  _pad0: f32,
}

@group(0) @binding(0) var<uniform> uniforms: ReprojUniforms;
@group(0) @binding(1) var tileSampler: sampler;
@group(0) @binding(2) var tileTexture: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) worldPos: vec2<f32>,
}

@vertex
fn vs_main(@location(0) targetPos: vec2<f32>, @location(1) texCoord: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.texCoord = texCoord;
  out.worldPos = targetPos;
  out.position = uniforms.projectionMatrix * vec4(targetPos, uniforms.depth, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  if (
    in.worldPos.x < uniforms.renderExtent[0] ||
    in.worldPos.y < uniforms.renderExtent[1] ||
    in.worldPos.x > uniforms.renderExtent[2] ||
    in.worldPos.y > uniforms.renderExtent[3]
  ) {
    discard;
  }
  var color = textureSample(tileTexture, tileSampler, in.texCoord);
  let alpha = color.a * uniforms.transitionAlpha * uniforms.globalAlpha;
  return vec4(color.rgb * alpha, alpha);
}
`;

export const VECTOR_FILL_SHADER = `
struct FrameUniforms {
  projectionMatrix: mat4x4<f32>,
  renderExtent: vec4<f32>,
  viewportSizePx: vec2<f32>,
  globalAlpha: f32,
  hitDetection: f32,
}

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) hitColor: vec4<f32>,
}

@vertex
fn vs_main(
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) hitColor: vec4<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.position = uniforms.projectionMatrix * vec4(position, 0.0, 1.0);
  out.color = color;
  out.hitColor = hitColor;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  if (uniforms.hitDetection > 0.5) {
    return in.hitColor;
  }
  var color = in.color;
  color.a = color.a * uniforms.globalAlpha;
  return vec4(color.rgb * color.a, color.a);
}
`;

export const VECTOR_STROKE_SHADER = `
struct FrameUniforms {
  projectionMatrix: mat4x4<f32>,
  renderExtent: vec4<f32>,
  viewportSizePx: vec2<f32>,
  globalAlpha: f32,
  hitDetection: f32,
}

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) hitColor: vec4<f32>,
}

@vertex
fn vs_main(
  @location(0) position: vec2<f32>,
  @location(1) normal: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) hitColor: vec4<f32>,
  @location(4) width: f32,
) -> VertexOut {
  var out: VertexOut;
  var clip = uniforms.projectionMatrix * vec4(position, 0.0, 1.0);
  var offset = normal * (width * 0.5);
  clip = vec4(
    clip.xy + offset / (uniforms.viewportSizePx * 0.5) * clip.w,
    clip.z,
    clip.w
  );
  out.position = clip;
  out.color = color;
  out.hitColor = hitColor;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  if (uniforms.hitDetection > 0.5) {
    return in.hitColor;
  }
  var color = in.color;
  color.a = color.a * uniforms.globalAlpha;
  return vec4(color.rgb * color.a, color.a);
}
`;

export const SYMBOL_SHADER = `
struct FrameUniforms {
  projectionMatrix: mat4x4<f32>,
  renderExtent: vec4<f32>,
  viewportSizePx: vec2<f32>,
  globalAlpha: f32,
  hitDetection: f32,
}

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) hitColor: vec4<f32>,
  @location(2) local: vec2<f32>,
}

@vertex
fn vs_main(
  @location(0) position: vec2<f32>,
  @location(1) offsetPx: vec2<f32>,
  @location(2) sizePx: vec2<f32>,
  @location(3) color: vec4<f32>,
  @location(4) hitColor: vec4<f32>,
  @location(5) corner: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  var clip = uniforms.projectionMatrix * vec4(position, 0.0, 1.0);
  var px = offsetPx + (corner - vec2(0.5, 0.5)) * sizePx;
  // CSS pixels are Y-down; clip space is Y-up.
  clip = vec4(
    clip.x + px.x / (uniforms.viewportSizePx.x * 0.5) * clip.w,
    clip.y - px.y / (uniforms.viewportSizePx.y * 0.5) * clip.w,
    clip.z,
    clip.w
  );
  out.position = clip;
  out.color = color;
  out.hitColor = hitColor;
  out.local = corner * 2.0 - vec2(1.0, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  if (dot(in.local, in.local) > 1.0) {
    discard;
  }
  if (uniforms.hitDetection > 0.5) {
    return in.hitColor;
  }
  var color = in.color;
  color.a = color.a * uniforms.globalAlpha;
  return vec4(color.rgb * color.a, color.a);
}
`;

export const GLYPH_SHADER = `
struct FrameUniforms {
  projectionMatrix: mat4x4<f32>,
  renderExtent: vec4<f32>,
  viewportSizePx: vec2<f32>,
  globalAlpha: f32,
  hitDetection: f32,
}

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var atlasTexture: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) fillColor: vec4<f32>,
  @location(1) strokeColor: vec4<f32>,
  @location(2) hitColor: vec4<f32>,
  @location(3) texCoord: vec2<f32>,
}

@vertex
fn vs_main(
  @location(0) position: vec2<f32>,
  @location(1) offsetPx: vec2<f32>,
  @location(2) sizePx: vec2<f32>,
  @location(3) texCoord: vec4<f32>,
  @location(4) fillColor: vec4<f32>,
  @location(5) strokeColor: vec4<f32>,
  @location(6) hitColor: vec4<f32>,
  @location(7) angle: f32,
  @location(8) corner: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  var clip = uniforms.projectionMatrix * vec4(position, 0.0, 1.0);
  var local = corner * sizePx + offsetPx;
  let c = cos(angle);
  let s = sin(angle);
  let rotated = vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  // CSS pixels are Y-down; clip space is Y-up.
  clip = vec4(
    clip.x + rotated.x / (uniforms.viewportSizePx.x * 0.5) * clip.w,
    clip.y - rotated.y / (uniforms.viewportSizePx.y * 0.5) * clip.w,
    clip.z,
    clip.w
  );
  out.position = clip;
  out.fillColor = fillColor;
  out.strokeColor = strokeColor;
  out.hitColor = hitColor;
  out.texCoord = mix(texCoord.xy, texCoord.zw, corner);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let atlas = textureSample(atlasTexture, atlasSampler, in.texCoord);
  if (atlas.a < 0.01) {
    discard;
  }
  if (uniforms.hitDetection > 0.5) {
    return in.hitColor;
  }
  // Atlas: white fill, black stroke, transparent background. Mix by luminance.
  var color = mix(in.strokeColor, in.fillColor, atlas.r);
  color.a = color.a * atlas.a * uniforms.globalAlpha;
  return vec4(color.rgb * color.a, color.a);
}
`;

export const DECLUTTER_SHADER = `
struct Label {
  aabb: vec4<f32>,
  priority: u32,
  mode: u32,
  pairId: u32,
  _pad: u32,
}

struct Params {
  count: u32,
  gridWidth: u32,
  gridHeight: u32,
  cellSize: f32,
}

@group(0) @binding(0) var<storage, read> labels: array<Label>;
@group(0) @binding(1) var<storage, read_write> occupancy: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> visibility: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

const MODE_DECLUTTER: u32 = 0u;
const MODE_OBSTACLE: u32 = 1u;
const MODE_NONE: u32 = 2u;

fn cellIndex(x: i32, y: i32) -> u32 {
  let gx = clamp(x, 0, i32(params.gridWidth) - 1);
  let gy = clamp(y, 0, i32(params.gridHeight) - 1);
  return u32(gy) * params.gridWidth + u32(gx);
}

@compute @workgroup_size(1)
fn cs_main() {
  for (var i = 0u; i < params.count; i = i + 1u) {
    let label = labels[i];
    if (label.mode == MODE_NONE) {
      visibility[i] = 1u;
      continue;
    }
    let minX = i32(floor(label.aabb[0] / params.cellSize));
    let minY = i32(floor(label.aabb[1] / params.cellSize));
    let maxX = i32(floor(label.aabb[2] / params.cellSize));
    let maxY = i32(floor(label.aabb[3] / params.cellSize));
    var blocked = false;
    if (label.mode == MODE_DECLUTTER) {
      for (var y = minY; y <= maxY; y = y + 1) {
        for (var x = minX; x <= maxX; x = x + 1) {
          let idx = cellIndex(x, y);
          if (atomicLoad(&occupancy[idx]) != 0u) {
            blocked = true;
          }
        }
      }
    }
    if (blocked) {
      visibility[i] = 0u;
      continue;
    }
    visibility[i] = 1u;
    for (var y = minY; y <= maxY; y = y + 1) {
      for (var x = minX; x <= maxX; x = x + 1) {
        atomicStore(&occupancy[cellIndex(x, y)], 1u);
      }
    }
  }
}
`;

/**
 * Inject a compiled color pipeline after the texture sample.
 *
 * @param {string} shader Base shader.
 * @param {string} [fragmentBody] WGSL statements.
 * @param {string} [functions] Helper functions.
 * @return {string} Shader.
 */
export function withTileColorPipeline(shader, fragmentBody, functions) {
  if (!fragmentBody) {
    return shader;
  }
  const prefix = functions ? functions + '\n' : '';
  return (
    prefix +
    shader.replace(
      'var color = textureSample(tileTexture, tileSampler, in.texCoord);',
      `var color = textureSample(tileTexture, tileSampler, in.texCoord);\n  ${fragmentBody}`,
    )
  );
}
