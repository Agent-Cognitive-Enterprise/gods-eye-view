import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGhostMapsLayer } from './index.js';

function element(localName, children = [], value = '', attributes = {}) {
  const node = {
    localName,
    children,
    get textContent() {
      return value + children.map((child) => child.textContent).join('');
    },
    getAttribute: (key) => attributes[key] ?? null,
    getElementsByTagName(name) {
      return children.flatMap((child) => [
        ...(name === '*' || name === child.localName ? [child] : []),
        ...child.getElementsByTagName(name),
      ]);
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function documentFixture() {
  return element('document', [
    element('kml', [
      element('Document', [
        element(
          'Style',
          [
            element('IconStyle', [
              element('Icon', [element('href', [], 'icon.png')]),
            ]),
          ],
          '',
          { id: 'pin' },
        ),
        element('Placemark', [
          element('name', [], 'Test report'),
          element('styleUrl', [], '#pin'),
          element('Point', [element('coordinates', [], '12,34')]),
        ]),
      ]),
    ]),
  ]);
}

// A stored KMZ with a local icon; the XML DOM double supplies its one point.
function fixtureKmz() {
  const files = [
    ['doc.kml', '<kml/>'],
    ['icon.png', 'packed icon'],
  ];
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const key = Buffer.from(name);
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(key.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(key.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, key, bytes);
    central.push(directory, key);
    offset += header.length + key.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

function fixture(
  t,
  {
    beforeFileReturns,
    onCreateUrl,
    documentOf = documentFixture,
    storage,
  } = {},
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = class {
    parseFromString() {
      return documentOf();
    }
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'DOMParser', previous);
    else delete globalThis.DOMParser;
  });
  const created = [];
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', () => {
    const url = `blob:local-${created.length}`;
    created.push(url);
    onCreateUrl?.(layer);
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  t.mock.method(console, 'warn', () => {});
  const mounted = new Set();
  const viewer = {
    scene: { requestRender() {} },
    dataSources: {
      async add(dataSource) {
        mounted.add(dataSource);
        return dataSource;
      },
      remove(dataSource) {
        return mounted.delete(dataSource);
      },
    },
  };
  const layer = createGhostMapsLayer({
    storage: storage ?? null,
    source: {
      getCatalog: async () => ({
        products: [{ id: 'cip', version: 'a'.repeat(40), defaultOn: true }],
      }),
      getFile: async () => {
        beforeFileReturns?.(layer);
        return fixtureKmz();
      },
    },
  });
  layer.init(viewer);
  layer.enable();
  t.after(() => layer.destroy());
  return { layer, viewer, mounted, created, revoked };
}

test('cancelling a file read does not allocate packed-image URLs', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t, {
    beforeFileReturns: (layer) => queueMicrotask(() => layer.disable()),
  });
  await layer.update(viewer);
  assert.equal(created.length, 0);
  assert.equal(revoked.length, 0);
  assert.equal(mounted.size, 0);
});

test('cancellation during parsing releases every packed-image URL', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t, {
    onCreateUrl: (layer) => layer.disable(),
  });
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
});

test('entity construction failure releases parsed image URLs', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t);
  t.mock.method(Cesium.EntityCollection.prototype, 'add', () => {
    throw new Error('fixture entity failure');
  });
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
  assert.equal(layer.getStats().error, 'fixture entity failure');
});

test('successful load keeps icons until the product is disabled', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t);
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.equal(revoked.length, 0);
  assert.equal(mounted.size, 1);
  assert.equal(layer.getStats().count, 1);
  layer.disable();
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
});

const row = (label, value) => `<tr><td>${label}</td><td>${value}</td></tr>`;

function placemark(name, lon, rows) {
  return element('Placemark', [
    element('name', [], name),
    element('description', [], `<table>${rows.join('')}</table>`),
    element('Point', [element('coordinates', [], `${lon},34`)]),
  ]);
}

const day = (back) => {
  const at = new Date(Date.now() - back * 86_400_000);
  return `${at.getUTCMonth() + 1}/${at.getUTCDate()}/${at.getUTCFullYear()}`;
};

function agedDocument() {
  return element('document', [
    element('kml', [
      element('Document', [
        placemark('recent', 10, [
          row('AttackType', 'Bombing'),
          row('Date', day(3)),
        ]),
        placemark('old', 11, [
          row('AttackType', 'Bombing'),
          row('Date', day(300)),
        ]),
        placemark('undated', 12, [row('IncidentType', 'Strike')]),
        placemark('site', 13, [row('InstallationType', 'Air Base')]),
      ]),
    ]),
  ]);
}

const names = (layer) => layer.getAnalystRecords().map((record) => record.name);
const chip = (layer, id) =>
  layer.getRowControls().chips.find((c) => c.id === id);
const shownEntities = (mounted) =>
  [...mounted][0].entities.values.filter((entity) => entity.show).length;

test('the default window keeps out old and undated events, not sites', async (t) => {
  const { layer, viewer, mounted } = fixture(t, { documentOf: agedDocument });
  await layer.update(viewer);
  assert.deepEqual(names(layer), ['recent', 'site']);
  assert.equal(layer.getStats().count, 2);
  assert.equal(shownEntities(mounted), 2);
  assert.ok(chip(layer, 'window-1m').active);
  assert.match(layer.getRowControls().info, /Hidden: 1 older, 1 undated/);
});

test('a window chip changes what the map shows and stays chosen', async (t) => {
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  const { layer, viewer, mounted } = fixture(t, {
    documentOf: agedDocument,
    storage,
  });
  await layer.update(viewer);
  chip(layer, 'window-24h').onClick();
  assert.deepEqual(names(layer), ['site']);
  assert.equal(shownEntities(mounted), 1);
  chip(layer, 'window-1y').onClick();
  assert.deepEqual(names(layer), ['recent', 'old', 'site']);
  assert.equal(shownEntities(mounted), 3);
  assert.equal(stored.get('gev.ghostmaps.window'), '1y');
});

test('a stored window is read back and an unknown one ignored', async (t) => {
  for (const [value, active] of [
    ['6h', 'window-6h'],
    ['forever', 'window-1m'],
  ]) {
    const { layer } = fixture(t, {
      documentOf: agedDocument,
      storage: { getItem: () => value, setItem() {} },
    });
    assert.ok(chip(layer, active).active, value);
  }
});

test('the horizon cull does not bring back a pin the window hid', async (t) => {
  const { layer, viewer, mounted } = fixture(t, { documentOf: agedDocument });
  const listeners = [];
  viewer.scene.preRender = {
    addEventListener(listener) {
      listeners.push(listener);
      return () => {};
    },
  };
  // From the far side every pin is culled; turning to face them restores
  // only those inside the window.
  viewer.camera = { positionWC: Cesium.Cartesian3.fromDegrees(-169, -34, 4e7) };
  await layer.update(viewer);
  assert.equal(shownEntities(mounted), 0);
  viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(11, 34, 4e7);
  listeners.forEach((listener) => listener());
  assert.equal(shownEntities(mounted), 2);
});

test('events age out of the window as time passes', async (t) => {
  const { layer, viewer } = fixture(t, { documentOf: agedDocument });
  await layer.update(viewer);
  chip(layer, 'window-1w').onClick();
  assert.deepEqual(names(layer), ['recent', 'site']);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 8 * 86_400_000);
  await layer.update(viewer);
  assert.deepEqual(names(layer), ['site']);
});
