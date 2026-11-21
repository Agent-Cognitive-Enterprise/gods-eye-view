import { msg } from '../i18n/index.js';

/**
 * Fork: readable names of the Autopilot feeds (server/providers/intel), by
 * feed id. FEEDS and RESOURCES both show these; translate with t().
 */
export const FEED_LABELS = Object.freeze({
  'usgs-earthquakes': msg('USGS earthquakes'),
  'ghostmaps-incidents': msg('S2 GhostMaps incidents'),
  'gdacs-alerts': msg('GDACS disaster alerts'),
  'tsunami-ptwc': msg('Pacific Tsunami Warning Center'),
  'tsunami-ntwc': msg('National Tsunami Warning Center'),
  'nws-alerts': msg('US weather alerts (NWS)'),
  'nasa-eonet': msg('NASA EONET natural events'),
  'who-don': msg('WHO disease outbreak news'),
  'worldbank-inflation': msg('World Bank inflation'),
  'reliefweb-disasters': msg('ReliefWeb disasters'),
  'acled-conflict': msg('ACLED conflict data'),
  'gdelt-events': msg('GDELT machine-coded news'),
  'airsea-signals': msg('Air & Sea signals'),
  'submarine-cables': msg('Submarine cable notices'),
});
