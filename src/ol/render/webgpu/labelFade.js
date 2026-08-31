/**
 * @module ol/render/webgpu/labelFade
 */

/**
 * Fade-in duration for newly visible labels (ms).
 * @type {number}
 */
export const LABEL_FADE_DURATION = 200;

/**
 * Match previous-frame labels within this many CSS pixels (converted to
 * world units with view resolution) so the same text at a new tile zoom
 * does not restart the fade.
 * @type {number}
 */
export const LABEL_FADE_MATCH_PIXELS = 64;

/**
 * @typedef {Object} FadeLabel
 * @property {number} [id] Feature uid.
 * @property {string} [text] Displayed text.
 * @property {import("../../coordinate.js").Coordinate} [_anchor] World-space anchor.
 */

/**
 * @typedef {Object} FadeEntry
 * @property {number} [id] Feature uid.
 * @property {string} [text] Displayed text.
 * @property {number} [x] World anchor x.
 * @property {number} [y] World anchor y.
 * @property {number} appearTime First visible time.
 */

/**
 * @param {Array<FadeEntry>} prev Previous visible entries.
 * @param {Set<number>} used Matched previous indices.
 * @param {FadeLabel} label Current label.
 * @param {number} [maxWorldDistance] Max world distance for text matching.
 * @return {number|undefined} Previous appear time, if any.
 */
function matchPrev(prev, used, label, maxWorldDistance) {
  const id = label.id;
  if (id !== undefined) {
    for (let i = 0; i < prev.length; ++i) {
      if (used.has(i) || prev[i].id !== id) {
        continue;
      }
      used.add(i);
      return prev[i].appearTime;
    }
  }
  const text = label.text;
  const anchor = label._anchor;
  if (
    !text ||
    !anchor ||
    maxWorldDistance === undefined ||
    maxWorldDistance <= 0
  ) {
    return undefined;
  }
  const maxDistSq = maxWorldDistance * maxWorldDistance;
  let best = -1;
  let bestDistSq = Infinity;
  for (let i = 0; i < prev.length; ++i) {
    if (used.has(i)) {
      continue;
    }
    const entry = prev[i];
    if (entry.text !== text || entry.x === undefined || entry.y === undefined) {
      continue;
    }
    const dx = entry.x - anchor[0];
    const dy = entry.y - anchor[1];
    const distSq = dx * dx + dy * dy;
    if (distSq <= maxDistSq && distSq < bestDistSq) {
      best = i;
      bestDistSq = distSq;
    }
  }
  if (best < 0) {
    return undefined;
  }
  used.add(best);
  return prev[best].appearTime;
}

/**
 * @classdesc
 * Per-label opacity for a short fade-in when a label first becomes visible.
 * Hidden labels are forgotten so they fade in again if they return.
 * When `maxWorldDistance` is passed, the same text at a nearby world
 * position reuses the previous fade so vector-tile zoom swaps do not flash.
 */
export class LabelFade {
  /**
   * @param {number} [duration] Duration in milliseconds.
   */
  constructor(duration = LABEL_FADE_DURATION) {
    /**
     * @private
     * @type {number}
     */
    this.duration_ = duration;

    /**
     * @private
     * @type {Map<number, number>}
     */
    this.appearTime_ = new Map();

    /**
     * Visible labels from the previous update, for id and text+anchor matching.
     * @private
     * @type {Array<FadeEntry>}
     */
    this.prev_ = [];
  }

  /**
   * Record newly visible labels and drop ids that are no longer shown.
   *
   * @param {Array<FadeLabel>} labels Labels.
   * @param {Array<boolean>} visibility Visibility aligned with `labels`.
   * @param {number} time Frame time.
   * @param {number} [maxWorldDistance] Max world distance to treat same-text
   * labels as a continuation. Omitted: match by id only.
   * @return {boolean} True if any visible label is still fading.
   */
  update(labels, visibility, time, maxWorldDistance) {
    const prev = this.prev_;
    const used = new Set();
    /** @type {Map<number, number>} */
    const appearById = new Map();
    /** @type {Array<FadeEntry>} */
    const next = [];

    for (let i = 0; i < labels.length; ++i) {
      if (visibility[i] === false) {
        continue;
      }
      const label = labels[i];
      if (label.id === undefined && !label.text) {
        continue;
      }
      const appear = matchPrev(prev, used, label, maxWorldDistance) ?? time;
      if (label.id !== undefined) {
        const existing = appearById.get(label.id);
        appearById.set(
          label.id,
          existing !== undefined ? Math.min(existing, appear) : appear,
        );
      }
      const anchor = label._anchor;
      next.push({
        id: label.id,
        text: label.text,
        x: anchor ? anchor[0] : undefined,
        y: anchor ? anchor[1] : undefined,
        appearTime: appear,
      });
    }

    for (const entry of next) {
      if (entry.id === undefined) {
        continue;
      }
      const oldest = appearById.get(entry.id);
      if (oldest !== undefined) {
        entry.appearTime = oldest;
      }
    }

    this.appearTime_.clear();
    let fading = false;
    for (const entry of next) {
      if (entry.id === undefined) {
        continue;
      }
      this.appearTime_.set(entry.id, entry.appearTime);
      if (time - entry.appearTime < this.duration_) {
        fading = true;
      }
    }
    this.prev_ = next;
    return fading;
  }

  /**
   * @param {number|undefined} id Label id.
   * @param {number} time Frame time.
   * @return {number} Opacity in `[0, 1]`.
   */
  opacity(id, time) {
    if (id === undefined) {
      return 1;
    }
    const appearTime = this.appearTime_.get(id);
    if (appearTime === undefined || this.duration_ <= 0) {
      return 1;
    }
    return Math.min(1, (time - appearTime) / this.duration_);
  }
}
