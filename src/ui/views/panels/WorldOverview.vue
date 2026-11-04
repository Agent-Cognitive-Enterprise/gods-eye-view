<script setup>
import { storeToRefs } from 'pinia';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatNumber, t } from '../../../i18n/index.js';
import WORLD from '../../../intel/overviewWorld.json' with { type: 'json' };
import { project, routeSegments, segmentsPath } from '../../../intel/mercator.js';
import { useWorldOverviewStore } from '../../stores/worldOverview.js';
import WorldOverviewCamera from './WorldOverviewCamera.vue';

// WORLD OVERVIEW (fork feature): a 2D Mercator map below AUTOPILOT. Red marks the
// Autopilot: the shot on screen blinks, every other stop on its way is a faded red
// dot. The crosshair is the camera itself, which a zoom-out moves on its own. Read
// only: a click asks the console to show that event, the same as clicking its row.
const store = useWorldOverviewStore();
const { model, open } = storeToRefs(store);
const SIZE = WORLD.grid;
// A full Mercator world is square; the overview shows 75°N to 60°S for a 2:1 map.
const TOP = Math.round(project(75, 0).y * SIZE);
const BOTTOM = Math.round(project(-60, 0).y * SIZE);
const HEIGHT = BOTTOM - TOP;
const viewBox = `0 ${TOP} ${SIZE} ${HEIGHT}`;

const graticule = (() => {
  const lines = [];
  for (let lon = -150; lon <= 150; lon += 30) lines.push(`M${((lon + 180) / 360) * SIZE} ${TOP}V${BOTTOM}`);
  for (const lat of [-30, 0, 30, 60]) {
    const y = (project(lat, 0).y * SIZE).toFixed(1);
    lines.push(`M0 ${y}H${SIZE}`);
  }
  return lines.join('');
})();

/** A model point on the map, held inside the visible band when it lies beyond it. */
const place = (p) => {
  const at = project(p.lat, p.lon);
  if (!at) return null;
  const y = at.y * SIZE;
  return {
    ...p,
    cx: (at.x * SIZE).toFixed(1),
    cy: Math.min(BOTTOM - 8, Math.max(TOP + 8, y)).toFixed(1),
    beyond: y < TOP || y > BOTTOM,
  };
};
const current = computed(() => (model.value?.current ? place(model.value.current) : null));
const visited = computed(() => (model.value?.visited ?? []).map(place).filter(Boolean));
const next = computed(() => (model.value?.next ?? []).map(place).filter(Boolean));
// Where it has been, oldest first, into the shot on screen; then, dashed, the likely next stop.
// Lines end where their dots are drawn: inside the band, like the dots themselves.
const inBand = (p) => ({ ...p, lat: Math.min(74, Math.max(-59, p.lat)) });
const pastPath = computed(() => {
  if (!model.value) return '';
  const points = [...model.value.visited].reverse();
  if (model.value.current) points.push(model.value.current);
  return segmentsPath(routeSegments(points.map(inBand)), SIZE, SIZE);
});
const nextPath = computed(() => {
  const m = model.value;
  if (!m?.current || !m.next.length) return '';
  return segmentsPath(routeSegments([m.current, m.next[0]].map(inBand)), SIZE, SIZE);
});

const STATUS = {
  auto: () => t('AUTO'),
  paused: () => t('PAUSED'),
  off: () => t('OFF'),
};
const status = computed(() => {
  const m = model.value;
  if (!m) return '';
  if (m.status === 'unknown_position') return t('POSITION UNKNOWN');
  if (m.status === 'no_targets') return t('NO TARGETS');
  return m.next.length ? t('LIKELY NEXT: {count}', { count: formatNumber(m.next.length) }) : '';
});
const describe = (p, kind) =>
  [
    kind,
    p.title,
    p.regional ? t('REGIONAL') : null,
    p.beyond ? t('beyond the edge of this map') : null,
    model.value?.demo ? t('DEMO') : null,
  ]
    .filter(Boolean)
    .join(' · ');
const label = computed(() => {
  const m = model.value;
  if (!m) return t('World overview');
  return [
    t('World overview'),
    STATUS[m.mode]?.(),
    m.current ? t('Now: {title}', { title: m.current.title }) : t('No event on screen'),
    status.value,
  ]
    .filter(Boolean)
    .join('. ');
});

const root = ref(null);
let observer = null;
onMounted(() => {
  if (typeof IntersectionObserver !== 'function') {
    store.setVisible(true);
    return;
  }
  observer = new IntersectionObserver(([entry]) => store.setVisible(entry.isIntersecting));
  observer.observe(root.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  store.setVisible(false);
});
</script>

<template>
  <section ref="root" id="world-overview" class="world-overview" :aria-label="t('World overview')">
    <div class="world-overview__head">
      <span class="panel-title">{{ t('WORLD OVERVIEW') }}</span>
      <template v-if="open && model">
        <span class="wo-badge" :class="`wo-badge--${model.mode}`">{{ STATUS[model.mode]?.() }}</span>
        <span v-if="model.demo" class="wo-badge wo-badge--demo">{{ t('DEMO') }}</span>
        <span class="wo-status">{{ status }}</span>
      </template>
      <button type="button" class="wo-toggle" :aria-expanded="String(open)" :aria-label="open ? t('Hide map') : t('Show map')" :title="open ? t('Hide map') : t('Show map')" @click="store.act('toggle')">{{ open ? '▾' : '▸' }}</button>
    </div>
    <svg v-if="open && model" class="world-overview__map" :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" role="group" :aria-label="label">
      <g aria-hidden="true">
        <path class="wo-land" :d="WORLD.path" />
        <path class="wo-graticule" :d="graticule" />
        <path v-if="pastPath" class="wo-route" :d="pastPath" />
        <path v-if="nextPath" class="wo-route wo-route--next" :d="nextPath" />
      </g>
      <circle v-for="p in visited" :key="`v:${p.key}`" class="wo-point wo-point--visited" :cx="p.cx" :cy="p.cy" r="9" tabindex="0" role="button" :aria-label="describe(p, t('VISITED'))" @click="store.act('select', p.key)" @keydown.enter="store.act('select', p.key)" @keydown.space.prevent="store.act('select', p.key)"><title>{{ describe(p, t('VISITED')) }}</title></circle>
      <circle v-for="p in next" :key="`n:${p.key}`" class="wo-point wo-point--next" :cx="p.cx" :cy="p.cy" r="9" tabindex="0" role="button" :aria-label="describe(p, t('LIKELY NEXT'))" @click="store.act('select', p.key)" @keydown.enter="store.act('select', p.key)" @keydown.space.prevent="store.act('select', p.key)"><title>{{ describe(p, t('LIKELY NEXT')) }}</title></circle>
      <circle v-if="current" class="wo-point wo-point--current" :class="{ 'wo-point--regional': current.regional }" :cx="current.cx" :cy="current.cy" r="15" tabindex="0" role="button" :aria-label="describe(current, t('NOW'))" @click="store.act('select', current.key)" @keydown.enter="store.act('select', current.key)" @keydown.space.prevent="store.act('select', current.key)"><title>{{ describe(current, t('NOW')) }}</title></circle>
      <WorldOverviewCamera :width="SIZE" :height="SIZE" :top="TOP + 8" :bottom="BOTTOM - 8" />
    </svg>
    <p v-if="open && model?.unplaced" class="wo-note intel-muted">{{ t('{count} without a map position', { count: formatNumber(model.unplaced) }) }}</p>
  </section>
</template>
