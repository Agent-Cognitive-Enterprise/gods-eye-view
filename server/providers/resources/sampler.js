// Fork: the server's own figures for the RESOURCES panel, sampled every few
// seconds into a short ring: memory, CPU (this server's share of one core, and
// the whole machine's), event-loop delay, and the machine's memory.

import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const MB = 1024 * 1024;
const round = (value, digits = 1) =>
  Number.isFinite(value)
    ? Math.round(value * 10 ** digits) / 10 ** digits
    : null;

/**
 * @param {{intervalMs?: number, keep?: number, now?: () => number,
 *   memoryUsage?: () => object, cpuUsage?: (prev?: object) => object,
 *   cores?: number, totalmem?: () => number, freemem?: () => number,
 *   loopDelay?: object|null}} options
 */
export function createSampler({
  intervalMs = 5000,
  keep = 120,
  now = () => Date.now(),
  memoryUsage = () => process.memoryUsage(),
  cpuUsage = (prev) => process.cpuUsage(prev),
  cores = Math.max(1, os.cpus().length),
  totalmem = () => os.totalmem(),
  freemem = () => os.freemem(),
  cpuTimes = () => os.cpus().map((cpu) => cpu.times),
  loopDelay = (() => {
    try {
      return monitorEventLoopDelay({ resolution: 20 });
    } catch {
      return null;
    }
  })(),
} = {}) {
  const samples = [];
  let timer = null;
  let lastCpu = null;
  let lastAt = null;
  let lastTimes = null;

  // Busy share of all cores since the last sample, from the OS's own
  // per-core counters: the machine's CPU, whatever process uses it.
  function machinePct() {
    let times;
    try {
      times = cpuTimes();
    } catch {
      return null;
    }
    const previous = lastTimes;
    lastTimes = times;
    if (!previous || previous.length !== times.length) return null;
    let busy = 0;
    let total = 0;
    times.forEach((t, i) => {
      const p = previous[i];
      const idle = t.idle - p.idle;
      const all =
        t.user -
        p.user +
        (t.nice - p.nice) +
        (t.sys - p.sys) +
        (t.irq - p.irq) +
        idle;
      busy += all - idle;
      total += all;
    });
    return total > 0 ? (busy / total) * 100 : null;
  }

  // How late the loop ran beyond its own timer: the 99th percentile less the
  // quickest turn, which is the timer interval plus the OS's timer step
  // (about 15.6 ms on Windows), not delay.
  function loopFigure(percentile) {
    if (!loopDelay || !Number.isFinite(loopDelay.min) || loopDelay.count === 0)
      return null;
    return Math.max(
      0,
      (loopDelay.percentile(percentile) - loopDelay.min) / 1e6,
    );
  }

  function sample() {
    const at = now();
    const cpu = cpuUsage();
    let corePct = null;
    if (lastCpu && at > lastAt) {
      const usedUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
      corePct = (usedUs / 1000 / (at - lastAt)) * 100;
    }
    lastCpu = cpu;
    lastAt = at;
    const mem = memoryUsage();
    const entry = {
      at,
      rss_mb: round(mem.rss / MB),
      heap_used_mb: round(mem.heapUsed / MB),
      heap_total_mb: round(mem.heapTotal / MB),
      external_mb: round((mem.external ?? 0) / MB),
      cpu_core_pct: round(corePct),
      cpu_machine_pct: round(machinePct()),
      loop_p50_ms: round(loopFigure(50)),
      loop_p99_ms: round(loopFigure(99)),
      system_total_mb: round(totalmem() / MB, 0),
      system_free_mb: round(freemem() / MB, 0),
    };
    loopDelay?.reset();
    samples.push(entry);
    if (samples.length > keep) samples.splice(0, samples.length - keep);
    return entry;
  }

  return {
    start() {
      if (timer) return;
      loopDelay?.enable();
      sample();
      timer = setInterval(sample, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      loopDelay?.disable();
    },
    sample,
    latest: () => samples.at(-1) ?? null,
    history: () => samples.slice(),
    cores,
    /** Averages over [since, until]; null without a CPU reading in it. */
    average(since, until = now()) {
      const inside = samples.filter(
        (s) => s.at >= since && s.at <= until && s.cpu_core_pct !== null,
      );
      if (!inside.length) return null;
      const mean = (key) =>
        round(
          inside.reduce((sum, s) => sum + (s[key] ?? 0), 0) / inside.length,
        );
      return {
        samples: inside.length,
        cpu_core_pct: mean('cpu_core_pct'),
        rss_mb: mean('rss_mb'),
        heap_used_mb: mean('heap_used_mb'),
        loop_p99_ms: mean('loop_p99_ms'),
      };
    },
  };
}
