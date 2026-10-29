// Local LLM client for an OpenAI-compatible server on this machine (KoboldCpp
// running Qwen). Loopback only: any other host is refused at configuration,
// so prompts never leave the machine and there is no path to a cloud model.
// One generation at a time with a hard timeout; KoboldCpp's own queue/idle
// report is checked first so this never competes with the operator's other
// work on the same model.

const DEFAULT_CANDIDATES = Object.freeze(['http://127.0.0.1:5001/v1']);
const PROBE_TIMEOUT_MS = 4_000;
const OWN_GRACE_MS = 6_000;

/** Parse and validate a loopback base URL; null when it is not loopback http(s). */
export function loopbackBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback =
    host === 'localhost' ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) return null;
  return url.href.replace(/\/+$/, '');
}

/**
 * @param {{baseUrl?: string, fetchImpl?: Function, timeoutMs?: number,
 *   maxTokens?: number, now?: () => number}} [options]
 */
export function createLocalLlm({
  baseUrl = process.env.GEV_LLM_BASE_URL,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = Number(process.env.GEV_LLM_TIMEOUT_MS) || 90_000,
  maxTokens = 600,
  now = () => Date.now(),
} = {}) {
  const configured = baseUrl ? loopbackBaseUrl(baseUrl) : null;
  const refused = Boolean(baseUrl) && !configured;
  const candidates = configured
    ? [configured]
    : refused
      ? []
      : [...DEFAULT_CANDIDATES];
  const state = {
    base_url: configured,
    model: null,
    server: null,
    status: refused ? 'refused_non_loopback' : 'unknown',
    last_probe_at: null,
    last_ok_at: null,
    last_error: refused ? 'GEV_LLM_BASE_URL must be a loopback address' : null,
    in_flight: false,
    json_schema: true,
  };

  let finishedAt = null;
  const get = async (url) => {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const origin = (base) => base.replace(/\/v1$/, '');

  /** Find the server and its loaded model. */
  async function probe() {
    state.last_probe_at = now();
    if (refused) return state;
    for (const base of candidates) {
      try {
        const models = await get(`${base}/models`);
        const model =
          models?.data?.find((m) => m?.status?.value !== 'unloaded')?.id ??
          models?.data?.[0]?.id;
        if (!model) throw new Error('no model loaded');
        const version = await get(`${origin(base)}/api/extra/version`).catch(
          () => null,
        );
        Object.assign(state, {
          base_url: base,
          model: String(model).slice(0, 120),
          server: version?.result
            ? `${version.result} ${version.version ?? ''}`.trim()
            : null,
          status: 'online',
          last_error: null,
        });
        return state;
      } catch (error) {
        state.last_error = String(error?.message || error).slice(0, 160);
      }
    }
    state.status = 'offline';
    return state;
  }

  /** KoboldCpp reports its own queue; another client's generation means busy. */
  async function busy() {
    if (!state.base_url) return false;
    try {
      const perf = await get(`${origin(state.base_url)}/api/extra/perf`);
      if (Number(perf?.queue) > 0) return true;
      // KoboldCpp keeps idle=0 for a moment after a generation ends; within
      // that grace after our own request, the generation was ours.
      return (
        perf?.idle === 0 && now() - (finishedAt ?? -Infinity) > OWN_GRACE_MS
      );
    } catch {
      return false; // not KoboldCpp, or perf unavailable: rely on our own concurrency of 1
    }
  }

  /**
   * One schema-constrained chat completion.
   * @returns {Promise<{text: string, latencyMs: number, usage: object|null}>}
   */
  async function complete(messages, schema, { signal } = {}) {
    if (state.status !== 'online' || !state.base_url)
      throw new Error('local model offline');
    if (state.in_flight) throw new Error('local model busy');
    state.in_flight = true;
    const started = now();
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(`${state.base_url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.2,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'assessment', schema, strict: true },
          },
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('empty completion');
      state.last_ok_at = now();
      state.last_error = null;
      return { text, latencyMs: now() - started, usage: body.usage ?? null };
    } catch (error) {
      const message =
        error?.name === 'TimeoutError'
          ? 'timeout'
          : String(error?.message || error).slice(0, 160);
      state.last_error = message;
      // KoboldCpp keeps generating after the client gives up; stop the
      // abandoned generation (ours: we checked it was idle before sending).
      if (message === 'timeout')
        fetchImpl(`${origin(state.base_url)}/api/extra/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }).catch(() => {});
      // A dead server shows as offline until the next probe finds it again.
      if (
        message === 'timeout' ||
        /ECONNREFUSED|fetch failed|socket/i.test(message)
      )
        state.status = 'offline';
      throw new Error(message);
    } finally {
      state.in_flight = false;
      finishedAt = now();
    }
  }

  return { probe, busy, complete, status: () => ({ ...state }) };
}
