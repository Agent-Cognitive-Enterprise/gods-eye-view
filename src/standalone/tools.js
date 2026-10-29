import { createAssetDirectorySource } from '../director/packs/source.js';
import { createApplicationTools } from '../app/tools.js';
import { startStandaloneChrome } from './startupChrome.js';
import { loadToolCatalog } from './toolCatalog.js';
export function createStandaloneTools(options) {
  return createApplicationTools({
    startChrome: startStandaloneChrome,
    sceneDataPacks: {
      sources: {
        assets: createAssetDirectorySource({
          // A panel names the app's address; see src/tools/globePanel.js.
          baseUrl: new URL(
            '/scene-assets/',
            globalThis.GEV_APP_BASE_URL ?? document.baseURI,
          ).href,
        }),
      },
    },
    ...options,
    voice: {
      // Local voice (fork feature) is offered only when the server says its
      // speech services run on this computer.
      supportedProviders: [
        'openai',
        'gemini',
        ...(globalThis.document?.querySelector?.('meta[name="gev-local-voice"]')
          ?.content === '1'
          ? ['local']
          : []),
      ],
      panel: true,
      toolCatalog: loadToolCatalog,
      ...options?.voice,
    },
  });
}
