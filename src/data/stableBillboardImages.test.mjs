import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasImageUrl,
  stabilizeBillboardImages,
} from './stableBillboardImages.js';

function fakeCanvas(name) {
  let calls = 0;
  return {
    tagName: 'CANVAS',
    toDataURL() {
      calls += 1;
      return `data:image/png;base64,${name}`;
    },
    get calls() {
      return calls;
    },
  };
}
const constant = (value) => ({ isConstant: true, getValue: () => value });

test('every billboard showing one canvas gets one URL, built once', () => {
  const pin = fakeCanvas('pin');
  const entities = Array.from({ length: 50 }, () => ({
    billboard: { image: constant(pin) },
  }));
  assert.equal(stabilizeBillboardImages(entities), 50);
  assert.equal(pin.calls, 1);
  assert.ok(
    entities.every((e) => e.billboard.image === 'data:image/png;base64,pin'),
  );
});

test('a shared cache reuses URLs across data sources', () => {
  const pin = fakeCanvas('pin');
  const cache = new WeakMap();
  stabilizeBillboardImages([{ billboard: { image: constant(pin) } }], cache);
  stabilizeBillboardImages([{ billboard: { image: constant(pin) } }], cache);
  assert.equal(pin.calls, 1);
});

test('strings, time-varying images and entities without billboards are left alone', () => {
  const pin = fakeCanvas('pin');
  const varying = { isConstant: false, getValue: () => pin };
  const entities = [
    {},
    { billboard: {} },
    { billboard: { image: constant('icons/a.png') } },
    { billboard: { image: varying } },
    null,
  ];
  assert.equal(stabilizeBillboardImages(entities), 0);
  assert.equal(entities[2].billboard.image.getValue(), 'icons/a.png');
  assert.equal(entities[3].billboard.image, varying);
  assert.equal(pin.calls, 0);
});

test('canvasImageUrl answers null for anything that is not a canvas', () => {
  const cache = new WeakMap();
  assert.equal(canvasImageUrl(undefined, cache), null);
  assert.equal(canvasImageUrl('data:x', cache), null);
  assert.equal(canvasImageUrl({ src: 'a.png' }, cache), null);
});
