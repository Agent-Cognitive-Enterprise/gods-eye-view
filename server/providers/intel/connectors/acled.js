// ACLED (Armed Conflict Location & Event Data): registration-only, and its
// terms restrict redistribution of the data. This console serves LAN viewers,
// so ACLED is listed but never polled: "needs a key" without an account, and
// "blocked by terms" once one is configured, until an operator has confirmed
// that ACLED's licence permits this use and an ingest is implemented.

export function acledConnector({ email = '', key = '' } = {}) {
  const configured = Boolean(String(email).trim() && String(key).trim());
  return {
    id: 'acled-conflict',
    provider: 'acled',
    url: 'https://acleddata.com/',
    intervalMs: 24 * 3600_000,
    staleAfterMs: 7 * 24 * 3600_000,
    license: 'ACLED terms of use (registration; redistribution restricted)',
    attribution: 'ACLED',
    requiresCredentials: () => !configured,
    blockedByTerms: configured,
    async poll() {
      throw new Error('ACLED ingest is not enabled');
    },
  };
}
