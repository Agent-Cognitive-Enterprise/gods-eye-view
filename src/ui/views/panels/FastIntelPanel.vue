<script setup>
import { storeToRefs } from 'pinia';
import { computed, ref } from 'vue';
import { t } from '../../../i18n/index.js';
import { presentFastIntel } from '../../fastIntelPresentation.js';
import UiButton from '../../kit/UiButton.vue';
import UiSelect from '../../kit/UiSelect.js';
import RailPanel from '../../rail/RailPanel.vue';
import { useFastIntelStore } from '../../stores/fastIntel.js';

// FAST INTELLIGENCE (fork feature): what the push sources found, how to narrow
// it, and how far each source can be trusted to be working right now. Hidden
// until createFastIntelPanel presents it; every change goes back to that owner.
const store = useFastIntelStore();
const { state, sourcesOpen, healthOpen } = storeToRefs(store);
const panel = computed(() => (state.value ? presentFastIntel(state.value) : null));
const handle = ref('');

async function follow() {
  const typed = handle.value.trim();
  if (typed && (await store.act('followAccount', typed))) handle.value = '';
}
</script>

<template>
  <RailPanel id="fast-intel-panel" :hidden="!panel" start-collapsed data-panel-fill :title="t('FAST INTELLIGENCE')">
    <template #badge><span id="fast-intel-count" :class="{ 'intel-feeds-down': panel?.summary.down }" :aria-label="t('Push sources up')">{{ panel?.summary.text }}</span></template>
    <div id="fast-intel-body" class="ui-scroll">
      <template v-if="panel">
        <div v-for="filter in panel.filters" :key="filter.id" class="fast-chips" :data-fast-filter="filter.id">
          <span class="intel-setting-label">{{ filter.label }}</span>
          <UiButton v-for="chip in filter.chips" :key="chip.id" class="data-toggle-chip" pressed-class="active" :pressed="chip.active" :title="chip.title" @click="store.act('setView', chip.change)">{{ chip.label }}</UiButton>
        </div>
        <p class="fast-coverage" :class="{ 'fast-coverage-down': panel.coverage.down }">{{ panel.coverage.text }}</p>
        <ul class="fast-activity">
          <li v-if="!panel.rows.length" class="intel-muted">{{ t('Nothing yet') }}</li>
          <li v-for="row in panel.rows" :key="row.id" class="fast-row" :class="`s-${row.status}`">
            <button type="button" class="fast-row-button" :aria-expanded="String(row.open)" @click="store.act('toggleEvent', row.id)">
              <span class="fast-badge">{{ row.badge }}</span>
              <span class="fast-row-title">{{ row.title }}</span>
              <span class="intel-muted">{{ row.meta }}</span>
            </button>
            <div v-if="row.timeline" class="fast-timeline">
              <p v-if="row.timeline.text" class="intel-muted">{{ row.timeline.text }}</p>
              <template v-else>
                <div v-for="line in row.timeline.lines" :key="line.label" class="fast-kv">
                  <span class="intel-muted">{{ line.label }}</span>
                  <span>{{ line.value }}</span>
                </div>
                <div v-for="item in row.timeline.evidence" :key="item.key" class="fast-evidence">
                  <span v-if="item.withdrawn" class="intel-muted">{{ t('Withdrawn by its source') }}</span>
                  <template v-else>
                    <span>{{ item.excerpt }}</span>
                    <a v-if="item.url" class="fast-link" :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.link }}</a>
                  </template>
                </div>
              </template>
            </div>
          </li>
        </ul>
        <button type="button" class="intel-section panel-title intel-rules-toggle fast-section" :aria-expanded="String(sourcesOpen)" @click="sourcesOpen = !sourcesOpen">{{ sourcesOpen ? '▾' : '▸' }} {{ t('SOURCES') }}</button>
        <div v-if="sourcesOpen" class="fast-sources">
          <div v-for="account in panel.accounts" :key="account.did" class="fast-account">
            <span class="fast-account-name">{{ account.name }}</span>
            <UiSelect class="fast-select" hold :aria-label="t('How far to trust this source')" :model-value="account.tag" :options="panel.tags" @update:model-value="store.act('setAccountTag', account.did, $event)" />
            <UiButton class="data-toggle-chip" @click="store.act('removeAccount', account.did)">{{ t('REMOVE') }}</UiButton>
          </div>
          <form class="fast-add" @submit.prevent="follow">
            <input v-model="handle" class="fast-input" type="text" :placeholder="t('Bluesky handle or DID')" :aria-label="t('Bluesky handle or DID')" />
            <UiButton class="data-toggle-chip" type="submit">{{ t('FOLLOW') }}</UiButton>
          </form>
          <p v-if="panel.notice" class="fast-notice">{{ panel.notice }}</p>
        </div>
        <button type="button" class="intel-section panel-title intel-rules-toggle fast-section" :aria-expanded="String(healthOpen)" @click="healthOpen = !healthOpen">{{ healthOpen ? '▾' : '▸' }} {{ t('HEALTH AND DELAY') }}</button>
        <div v-if="healthOpen" class="fast-health">
          <ul class="fast-source-list">
            <li v-for="source in panel.sources" :key="source.id" class="fast-source" :class="{ 'fast-warn': source.warn }">
              <span>{{ source.text }}</span>
              <span class="intel-muted">{{ source.meta }}</span>
              <span v-if="source.error" class="fast-notice">{{ source.error }}</span>
              <span v-for="stage in source.stages" :key="stage.id" class="intel-muted">{{ stage.text }}</span>
            </li>
          </ul>
          <p v-if="panel.queue" class="intel-muted">{{ panel.queue }}</p>
          <p v-for="target in panel.targets" :key="target.id" :class="target.missed ? 'fast-notice' : 'intel-muted'">{{ target.text }}</p>
        </div>
      </template>
    </div>
  </RailPanel>
</template>
