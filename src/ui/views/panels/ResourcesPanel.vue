<script setup>
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import RailPanel from '../../rail/RailPanel.vue';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import { useResourcesStore } from '../../stores/resources.js';
import {
  changeSummary,
  dependentLabels,
  fixedReasonLabel,
  formatBytes,
  formatDuration,
  formatMegabytes,
  formatPercent,
  groupJobs,
  jobFacts,
  sparkline,
  statusTone,
} from '../../resourcesPresentation.js';

// RESOURCES (fork feature): what the server and this browser are doing. The
// monitor (src/ui/resourcesMonitor.js) reads /api/resources only while this
// panel is open. Switching a server job off asks first, and works only on the
// computer the server runs on; layers turn off as in the layer list.
const PANEL_ID = 'resources-panel';
const store = useResourcesStore();
const { server, layers, state, error, pending, switchError } = storeToRefs(store);
const { panels } = storeToRefs(usePanelChromeStore());
const open = computed(() => panels.value[PANEL_ID]?.collapsed === false);
watch(open, (value) => store.setVisible(value), { immediate: true });
onBeforeUnmount(() => store.setVisible(false));

const now = ref(Date.now());
const tick = setInterval(() => {
  now.value = Date.now();
}, 5000);
onBeforeUnmount(() => clearInterval(tick));

const latest = computed(() => server.value?.server?.latest ?? null);
const history = computed(() => server.value?.server?.history ?? []);
const jobs = computed(() => server.value?.jobs ?? []);
const groups = computed(() => groupJobs(jobs.value));
const canControl = computed(() => server.value?.can_control === true);
const anyOff = computed(() => jobs.value.some((job) => job.off_by_you));
const changes = computed(() => (server.value?.changes ?? []).slice(0, 5));
const disk = computed(() => server.value?.disk ?? null);
const uptime = computed(() => formatDuration((server.value?.server?.uptime_s ?? NaN) * 1000));
const cpuLine = computed(() => sparkline(history.value, 'cpu_core_pct'));
const memLine = computed(() => sparkline(history.value, 'rss_mb'));

// The one job or layer waiting for "Turn off" to be confirmed.
const confirming = ref(null);
const ask = (id) => {
  confirming.value = id;
};
const cancel = () => {
  confirming.value = null;
};
function switchJob(job, enabled) {
  confirming.value = null;
  store.act('setJob', job.id, enabled);
}
function layerOff(layer) {
  confirming.value = null;
  store.act('layerOff', layer.id);
}
const jobIsOn = (job) => !job.off_by_you;
</script>

<template>
  <RailPanel :id="PANEL_ID" start-collapsed :title="t('RESOURCES')" sideways rail-scroller>
    <div class="resources-body ui-scroll" data-rail-scroller>
      <p v-if="state === 'loading' && !server" class="intel-muted">{{ t('Loading…') }}</p>
      <p v-if="state === 'error'" class="resources-error" role="alert">{{ t('Could not read the server figures: {error}', { error }) }}</p>
      <p v-if="switchError" class="resources-error" role="alert">{{ t('Could not switch it: {error}', { error: switchError }) }}</p>

      <section v-if="latest" class="resources-section" :aria-label="t('Server')">
        <h3 class="resources-heading">{{ t('Server') }}</h3>
        <div class="resources-figures">
          <div class="resources-figure">
            <span class="resources-figure-label">{{ t('CPU (one core)') }}</span>
            <span class="resources-figure-value">{{ formatPercent(latest.cpu_core_pct) }}</span>
            <svg v-if="cpuLine" class="resources-spark" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true"><polyline :points="cpuLine" /></svg>
          </div>
          <div class="resources-figure">
            <span class="resources-figure-label">{{ t('Memory') }}</span>
            <span class="resources-figure-value">{{ formatMegabytes(latest.rss_mb) }}</span>
            <svg v-if="memLine" class="resources-spark" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true"><polyline :points="memLine" /></svg>
          </div>
        </div>
        <p class="resources-facts">
          {{ t('Heap {used} of {total}', { used: formatMegabytes(latest.heap_used_mb), total: formatMegabytes(latest.heap_total_mb) }) }}
          · {{ t('Event-loop delay {p99} (p99)', { p99: formatDuration(latest.loop_p99_ms) }) }}
          · {{ t('Machine CPU {pct}', { pct: formatPercent(latest.cpu_machine_pct) }) }}
          · {{ t('Free memory {free} of {total}', { free: formatMegabytes(latest.system_free_mb), total: formatMegabytes(latest.system_total_mb) }) }}
          · {{ t('Up {uptime}', { uptime }) }}
        </p>
      </section>

      <section v-for="group in groups" :key="group.id" class="resources-section" :aria-label="group.label">
        <h3 class="resources-heading">{{ group.label }}</h3>
        <ul class="resources-list">
          <li v-for="job in group.jobs" :key="job.id" class="resources-row" :class="{ 'is-off': job.off_by_you }">
            <span class="resources-dot" :class="`tone-${statusTone(job.off_by_you ? 'off' : job.status)}`" aria-hidden="true"></span>
            <div class="resources-row-main">
              <span class="resources-row-title">{{ job.label }}<template v-if="job.provider && job.provider !== job.label"> · {{ job.provider }}</template></span>
              <span class="resources-row-facts">{{ job.off_by_you ? t('Off (you turned it off)') : jobFacts(job, now) }}</span>
              <span v-if="job.error && !job.off_by_you" class="resources-row-error">{{ job.error }}</span>
              <span v-if="!job.switchable && fixedReasonLabel(job)" class="resources-row-facts">{{ fixedReasonLabel(job) }}</span>
              <div v-if="confirming === job.id" class="resources-confirm" role="group" :aria-label="t('Confirm')">
                <span>{{ t('Turn off {label}? This also stops:', { label: job.label }) }}</span>
                <ul><li v-for="dep in dependentLabels(job)" :key="dep">{{ dep }}</li></ul>
                <UiButton class="data-toggle-chip" @click="switchJob(job, false)">{{ t('Turn off') }}</UiButton>
                <UiButton class="data-toggle-chip" @click="cancel">{{ t('Cancel') }}</UiButton>
              </div>
            </div>
            <template v-if="job.switchable && canControl && confirming !== job.id">
              <UiButton v-if="jobIsOn(job)" class="data-toggle-chip" :disabled="pending === job.id" @click="ask(job.id)">{{ t('Turn off') }}</UiButton>
              <UiButton v-else class="data-toggle-chip active" :disabled="pending === job.id" @click="switchJob(job, true)">{{ t('Turn on') }}</UiButton>
            </template>
          </li>
        </ul>
      </section>

      <p v-if="server && !canControl" class="intel-muted resources-note">{{ t('Switches work only on the computer that runs the server.') }}</p>
      <UiButton v-if="anyOff && canControl" class="data-toggle-chip resources-restore" :disabled="pending === 'restore'" @click="store.act('restoreDefaults')">{{ t('Restore defaults') }}</UiButton>

      <section v-if="changes.length" class="resources-section" :aria-label="t('Recent changes')">
        <h3 class="resources-heading">{{ t('Recent changes') }}</h3>
        <ul class="resources-list">
          <li v-for="change in changes" :key="`${change.id}-${change.at}`" class="resources-change">{{ changeSummary(change, jobs) }}</li>
        </ul>
      </section>

      <section class="resources-section" :aria-label="t('In this browser')">
        <h3 class="resources-heading">{{ t('In this browser') }}</h3>
        <p v-if="!layers.length" class="intel-muted">{{ t('No layers are on.') }}</p>
        <ul v-else class="resources-list">
          <li v-for="layer in layers" :key="layer.id" class="resources-row">
            <span class="resources-dot tone-ok" aria-hidden="true"></span>
            <div class="resources-row-main">
              <span class="resources-row-title">{{ layer.name }}</span>
              <span class="resources-row-facts"><template v-if="layer.count !== null">{{ t('{count} items', { count: formatNumber(layer.count) }) }}</template><template v-if="layer.objects"> · {{ t('{count} drawn', { count: formatNumber(layer.objects) }) }}</template></span>
              <div v-if="confirming === `layer:${layer.id}`" class="resources-confirm" role="group" :aria-label="t('Confirm')">
                <span>{{ t('Turn off the {label} layer?', { label: layer.name }) }}</span>
                <UiButton class="data-toggle-chip" @click="layerOff(layer)">{{ t('Turn off') }}</UiButton>
                <UiButton class="data-toggle-chip" @click="cancel">{{ t('Cancel') }}</UiButton>
              </div>
            </div>
            <UiButton v-if="confirming !== `layer:${layer.id}`" class="data-toggle-chip" :disabled="pending === `layer:${layer.id}`" @click="ask(`layer:${layer.id}`)">{{ t('Turn off') }}</UiButton>
          </li>
        </ul>
      </section>

      <section v-if="disk?.entries?.length" class="resources-section" :aria-label="t('Cache on disk')">
        <h3 class="resources-heading">{{ t('Cache on disk') }} · {{ formatBytes(disk.total_bytes) }}</h3>
        <ul class="resources-list">
          <li v-for="entry in disk.entries" :key="entry.name" class="resources-disk"><span>{{ entry.name }}</span><span>{{ formatBytes(entry.bytes) }}</span></li>
        </ul>
      </section>
    </div>
  </RailPanel>
</template>
