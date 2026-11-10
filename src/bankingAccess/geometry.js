// Country shapes for the banking-access layer (fork feature), from the
// bundled Natural Earth pack. Pure: no Cesium.

/** Decode one packed ring (first vertex absolute, then deltas) to [lon, lat]. */
export function decodeRing(encoded, decimals) {
  const factor = 10 ** decimals;
  const ring = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    x += encoded[i];
    y += encoded[i + 1];
    ring.push([x / factor, y / factor]);
  }
  return ring;
}

/** Shoelace area in square degrees (sign dropped): relative sizes only. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/**
 * The pack as iso3 -> { name, polygons: [outer, ...holes][], anchor, box }.
 * The anchor and the box come from the largest part, so a country cut at the
 * antimeridian (Russia, Fiji) or with far islands is framed on its main part.
 */
export function indexCountries(pack) {
  const decimals = pack?.meta?.decimals ?? 3;
  const index = new Map();
  for (const feature of pack?.features ?? []) {
    if (!/^[A-Z]{3}$/.test(feature?.iso ?? '')) continue;
    const polygons = (feature.polygons ?? []).map((poly) =>
      poly.map((ring) => decodeRing(ring, decimals)),
    );
    if (!polygons.length) continue;
    let main = polygons[0][0];
    for (const [outer] of polygons)
      if (ringArea(outer) > ringArea(main)) main = outer;
    const lons = main.map(([lon]) => lon);
    const lats = main.map(([, lat]) => lat);
    const box = {
      west: Math.min(...lons),
      east: Math.max(...lons),
      south: Math.min(...lats),
      north: Math.max(...lats),
    };
    index.set(feature.iso, {
      name: feature.name,
      polygons,
      box,
      anchor: {
        lon: lons.reduce((a, b) => a + b, 0) / lons.length,
        lat: lats.reduce((a, b) => a + b, 0) / lats.length,
      },
    });
  }
  return index;
}

/** A padded camera box around a country's main part. */
export function countryView(box) {
  const padLon = Math.max(1, (box.east - box.west) * 0.25);
  const padLat = Math.max(1, (box.north - box.south) * 0.25);
  return {
    west: Math.max(-180, box.west - padLon),
    east: Math.min(180, box.east + padLon),
    south: Math.max(-89, box.south - padLat),
    north: Math.min(89, box.north + padLat),
  };
}
