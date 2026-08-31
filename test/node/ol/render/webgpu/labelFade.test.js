import {assert} from 'chai';
import {
  LABEL_FADE_DURATION,
  LabelFade,
} from '../../../../../src/ol/render/webgpu/labelFade.js';

describe('ol/render/webgpu/labelFade', () => {
  it('fades a new label from 0 to 1 over the duration', () => {
    const fade = new LabelFade(200);
    const labels = [{id: 1}];
    assert.isTrue(fade.update(labels, [true], 1000));
    assert.strictEqual(fade.opacity(1, 1000), 0);
    assert.strictEqual(fade.opacity(1, 1100), 0.5);
    assert.strictEqual(fade.opacity(1, 1200), 1);
    assert.isFalse(fade.update(labels, [true], 1200));
  });

  it('restarts the fade after a label is hidden', () => {
    const fade = new LabelFade(200);
    fade.update([{id: 1}], [true], 0);
    fade.update([{id: 1}], [false], 200);
    fade.update([{id: 1}], [true], 500);
    assert.strictEqual(fade.opacity(1, 500), 0);
    assert.strictEqual(fade.opacity(1, 600), 0.5);
  });

  it('does not treat unlabeled or already-opaque labels as fading', () => {
    const fade = new LabelFade(200);
    assert.isFalse(fade.update([{}], [true], 0));
    assert.strictEqual(fade.opacity(undefined, 0), 1);
    fade.update([{id: 1}], [true], 0);
    fade.update([{id: 1}], [true], LABEL_FADE_DURATION);
    assert.isFalse(fade.update([{id: 1}], [true], LABEL_FADE_DURATION));
  });

  it('reuses fade when the same text appears nearby with a new id', () => {
    const fade = new LabelFade(200);
    fade.update([{id: 1, text: 'Montana', _anchor: [0, 0]}], [true], 0, 100);
    fade.update([{id: 1, text: 'Montana', _anchor: [0, 0]}], [true], 200, 100);
    const fading = fade.update(
      [{id: 2, text: 'Montana', _anchor: [10, 0]}],
      [true],
      1000,
      100,
    );
    assert.isFalse(fading);
    assert.strictEqual(fade.opacity(2, 1000), 1);
  });

  it('fades in when the same text is farther than maxWorldDistance', () => {
    const fade = new LabelFade(200);
    fade.update([{id: 1, text: 'Montana', _anchor: [0, 0]}], [true], 0, 100);
    fade.update(
      [{id: 2, text: 'Montana', _anchor: [1000, 0]}],
      [true],
      1000,
      100,
    );
    assert.strictEqual(fade.opacity(2, 1000), 0);
    assert.strictEqual(fade.opacity(2, 1100), 0.5);
  });

  it('does not match by text when maxWorldDistance is omitted', () => {
    const fade = new LabelFade(200);
    fade.update([{id: 1, text: 'Montana', _anchor: [0, 0]}], [true], 0);
    fade.update([{id: 2, text: 'Montana', _anchor: [0, 0]}], [true], 1000);
    assert.strictEqual(fade.opacity(2, 1000), 0);
  });

  it('propagates a matched text fade to a paired symbol with the same id', () => {
    const fade = new LabelFade(200);
    fade.update(
      [{id: 1, text: 'Montana', _anchor: [0, 0]}, {id: 1}],
      [true, true],
      0,
      100,
    );
    fade.update(
      [{id: 1, text: 'Montana', _anchor: [0, 0]}, {id: 1}],
      [true, true],
      200,
      100,
    );
    fade.update(
      [{id: 2, text: 'Montana', _anchor: [0, 0]}, {id: 2}],
      [true, true],
      1000,
      100,
    );
    assert.strictEqual(fade.opacity(2, 1000), 1);
  });
});
