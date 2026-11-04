/**
 * Stable atlas identities for entity billboard images.
 *
 * Cesium keys its billboard texture atlas by image id. An image with no URL, such
 * as the pin canvas `GeoJsonDataSource` draws for every point, gets a fresh GUID on
 * each assignment, even when it is the very same canvas. An entity billboard is
 * assigned again whenever its cluster hides it and later reuses it, so a layer
 * whose points come and go with the camera adds an atlas entry each time and never
 * frees one. Every growth repacks all entries; after a few hours the repack takes
 * long enough to freeze the page.
 *
 * A data URL is its own id: every billboard showing the same canvas, and every
 * reuse, resolves to one atlas entry.
 */

/**
 * The data URL for a canvas image, built once per canvas.
 *
 * @param {unknown} image Billboard image value.
 * @param {WeakMap<object, string>} cache Canvas to URL.
 * @returns {string|null} A URL, or null when the image is not a canvas.
 */
export function canvasImageUrl(image, cache) {
  if (
    !image ||
    typeof image !== 'object' ||
    typeof image.toDataURL !== 'function'
  ) {
    return null;
  }
  let url = cache.get(image);
  if (!url) {
    try {
      url = image.toDataURL();
    } catch {
      // A tainted canvas cannot be read: keep it as it is rather than fail the load.
      return null;
    }
    cache.set(image, url);
  }
  return url;
}

/**
 * Replace constant canvas billboard images with their data URLs.
 *
 * @param {Iterable<{billboard?: {image?: {isConstant?: boolean, getValue?: Function}}}>} entities
 * @param {WeakMap<object, string>} [cache] Shared across calls to reuse URLs.
 * @returns {number} How many billboards were changed.
 */
export function stabilizeBillboardImages(entities, cache = new WeakMap()) {
  let changed = 0;
  for (const entity of entities ?? []) {
    const billboard = entity?.billboard;
    const property = billboard?.image;
    if (!property || property.isConstant === false) continue;
    const url = canvasImageUrl(property.getValue?.(), cache);
    if (!url) continue;
    billboard.image = url;
    changed += 1;
  }
  return changed;
}
