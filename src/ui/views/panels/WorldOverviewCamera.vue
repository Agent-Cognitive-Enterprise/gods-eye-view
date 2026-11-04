<script setup>
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { t } from '../../../i18n/index.js';
import { useWorldOverviewStore } from '../../stores/worldOverview.js';

// The camera's own marker: a crosshair with a heading arrow. A separate component, so
// a moving camera re-renders only this, never the map or the Autopilot markers.
const props = defineProps({ width: { type: Number, required: true }, height: { type: Number, required: true } });
const { camera } = storeToRefs(useWorldOverviewStore());
const transform = computed(() =>
  camera.value ? `translate(${(camera.value.x * props.width).toFixed(1)} ${(camera.value.y * props.height).toFixed(1)}) rotate(${camera.value.heading})` : '',
);
</script>

<template>
  <g v-if="camera" class="wo-camera" :transform="transform">
    <title>{{ t('Camera') }}</title>
    <path class="wo-camera__cross" d="M-14 0H-5M5 0H14M0 -14V-5M0 5V14" />
    <path class="wo-camera__arrow" d="M0 -22L5 -13H-5Z" />
  </g>
</template>
