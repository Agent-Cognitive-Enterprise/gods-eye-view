import { createTrafficDensityLayer } from '../../layers/airsea/index.js';
import { createWarningAreasLayer } from '../../layers/airsea/warnings.js';
import { createTrafficAnomaliesLayer } from '../../layers/airsea/anomalies.js';
import { createCellShare } from '../../airsea/cellShare.js';

/**
 * Wire the fork's aggregate air and sea traffic layers into the catalog.
 * Air, sea and warning areas share hexagons through one cell share.
 */
export function createApplicationTrafficDensity(base) {
  const options = { ...base, share: createCellShare() };
  return [
    createTrafficDensityLayer({ ...options, domain: 'air' }),
    createTrafficDensityLayer({ ...options, domain: 'sea' }),
    createWarningAreasLayer(options),
    createTrafficAnomaliesLayer(options),
  ];
}
