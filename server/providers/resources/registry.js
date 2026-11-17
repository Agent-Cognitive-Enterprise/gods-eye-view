// Fork: the RESOURCES panel's registry of the server's background jobs.
// Plugins register what they run in the background (a feed poller, a
// collector); the panel lists them, and the operator can turn off the ones
// that can be switched. What the operator turned off is remembered in a small
// JSON file and applied again when the job registers after a restart, until
// it is turned back on or the defaults are restored.

import fs from 'node:fs';
import path from 'node:path';

const MAX_CHANGES = 20;
const ID = /^[a-z0-9][a-z0-9:._-]{0,79}$/;

function readOff(file, log) {
  if (!file) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = Array.isArray(parsed?.off) ? parsed.off : [];
    return new Set(ids.filter((id) => typeof id === 'string' && ID.test(id)));
  } catch (error) {
    if (error?.code !== 'ENOENT')
      log(
        `[resources] ${path.basename(file)} unreadable, defaults used: ${error.message}`,
      );
    return new Set();
  }
}

/**
 * @param {{file?: string|null, now?: () => number, log?: Function,
 *   measure?: (since: number, until?: number) => object|null}} options
 *   `measure` averages the server's own figures over a period (the sampler's
 *   `average`), for the before and after of each change.
 */
export function createResourceRegistry({
  file = null,
  now = () => Date.now(),
  log = (...args) => console.warn(...args),
  measure = null,
} = {}) {
  const jobs = new Map();
  const off = readOff(file, log);
  const changes = [];

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(
        tmp,
        `${JSON.stringify({ version: 1, off: [...off].sort() }, null, 2)}\n`,
      );
      fs.renameSync(tmp, file);
    } catch (error) {
      log(
        `[resources] could not remember the switched-off jobs: ${error.message}`,
      );
    }
  }

  function apply(job, on) {
    try {
      job.setEnabled(on);
      return true;
    } catch (error) {
      log(
        `[resources] ${job.id}: could not turn ${on ? 'on' : 'off'}: ${error?.message ?? error}`,
      );
      return false;
    }
  }

  function record(id, on) {
    const at = now();
    changes.unshift({
      id,
      on,
      at,
      before: measure?.(at - 2 * 60_000, at) ?? null,
    });
    changes.length = Math.min(changes.length, MAX_CHANGES);
  }

  return {
    /**
     * Register one background job; returns a function that unregisters it.
     * @param {{id: string, group: string, label: string,
     *   status: () => object, setEnabled?: (on: boolean) => void,
     *   dependents?: string[], fixedReason?: string|null}} job
     *   `status` reports its state; `setEnabled` makes it switchable;
     *   `dependents` are codes for what stops with it; `fixedReason` says
     *   why a job has no switch.
     */
    register(job) {
      if (!ID.test(job?.id ?? ''))
        throw new TypeError(`Bad resource job id: ${job?.id}`);
      if (typeof job.status !== 'function')
        throw new TypeError(`${job.id} needs a status`);
      jobs.set(job.id, job);
      if (off.has(job.id) && typeof job.setEnabled === 'function')
        apply(job, false);
      return () => {
        if (jobs.get(job.id) === job) jobs.delete(job.id);
      };
    },

    list() {
      return [...jobs.values()].map((job) => {
        let state;
        try {
          state = job.status() ?? {};
        } catch (error) {
          state = {
            status: 'unknown',
            error: String(error?.message ?? error).slice(0, 200),
          };
        }
        return {
          id: job.id,
          group: job.group,
          label: job.label,
          ...state,
          switchable: typeof job.setEnabled === 'function',
          off_by_you: off.has(job.id),
          dependents: job.dependents ?? [],
          fixed_reason: job.fixedReason ?? null,
        };
      });
    },

    /** @returns {'ok'|'unknown'|'fixed'|'failed'} */
    setEnabled(id, on) {
      const job = jobs.get(id);
      if (!job) return 'unknown';
      if (typeof job.setEnabled !== 'function') return 'fixed';
      if (on === !off.has(id)) return 'ok';
      if (!apply(job, on)) return 'failed';
      if (on) off.delete(id);
      else off.add(id);
      persist();
      record(id, on);
      return 'ok';
    },

    /** Turn every job the operator turned off back on. */
    restoreDefaults() {
      const restored = [];
      for (const id of [...off]) {
        const job = jobs.get(id);
        if (job && !apply(job, true)) continue;
        off.delete(id);
        restored.push(id);
        if (job) record(id, true);
      }
      persist();
      return restored;
    },

    /** Recent changes, newest first, each with the figures after it once known. */
    changes() {
      const t = now();
      return changes.map((change, index) => {
        // After: from a minute in until the next change (or now), at least a minute of it.
        const from = change.at + 60_000;
        const until = index > 0 ? changes[index - 1].at : t;
        const after =
          until - from >= 60_000 ? (measure?.(from, until) ?? null) : null;
        return { ...change, after };
      });
    },

    offIds: () => [...off],
  };
}
