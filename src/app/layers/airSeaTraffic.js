import { createTrafficDensityLayer } from '../../layers/airsea/index.js';
import { createWarningAreasLayer } from '../../layers/airsea/warnings.js';

/** Wire the fork's aggregate air and sea traffic layers into the catalog. */
export function createApplicationTrafficDensity(options) {
  return [
    createTrafficDensityLayer({ ...options, domain: 'air' }),
    createTrafficDensityLayer({ ...options, domain: 'sea' }),
    createWarningAreasLayer(options),
  ];
}
