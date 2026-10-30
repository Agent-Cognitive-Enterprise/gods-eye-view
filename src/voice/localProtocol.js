// Local voice protocol (fork feature): what the local model may answer for a
// spoken or typed command, and the strict checks every proposed call must pass
// before anything runs. Calls name either an existing app action (validated
// against its own schema in actionSchemas.js and then executed by the existing
// action runner) or one of the Autopilot console tools below. The model never
// produces code, URLs to fetch or free-form commands. Pure and portable.

import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';

export const LOCAL_TURN_PROMPT_VERSION = 'local-turn-1';
export const MAX_CALLS = 3;
const MAX_REPLY = 400;

/** Autopilot console tools; executed by the console, never by the app runner. */
export const AUTOPILOT_TOOL_SCHEMAS = Object.freeze([
  Object.freeze({
    name: 'autopilot_control',
    description:
      'Control the early-warning Autopilot: turn it on or off, pause or resume it, skip to the next event, explain why the current event is shown, or list its sources.',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: Object.freeze({
        action: Object.freeze({
          enum: ['on', 'off', 'pause', 'resume', 'next', 'explain', 'sources'],
        }),
      }),
    }),
  }),
  Object.freeze({
    name: 'find_events',
    description:
      'Find early-warning events in the queue and show the most significant one. Filter by category, by ISO 3166 two-letter country codes, and by how many hours back.',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        categories: Object.freeze({
          type: 'array',
          maxItems: 7,
          items: Object.freeze({
            enum: [
              'natural_disaster',
              'armed_conflict',
              'civil_unrest',
              'economic_stress',
              'infrastructure_disruption',
              'public_health',
              'breaking_news',
            ],
          }),
        }),
        countries: Object.freeze({
          type: 'array',
          maxItems: 40,
          items: Object.freeze({ type: 'string', pattern: '^[A-Z]{2}$' }),
        }),
        hours: Object.freeze({ type: 'integer', minimum: 1, maximum: 720 }),
      }),
    }),
  }),
]);

/**
 * The app actions offered to the local model: the ones people speak. Every
 * extra tool costs prompt time on a local model (about 180 tokens/s here), so
 * the catalogue stays small; typed and cloud voice keep the full set.
 */
export const LOCAL_VOICE_ACTIONS = Object.freeze([
  'fly_to_location',
  'adjust_camera_zoom',
  'zoom_to_globe',
  'set_layer_visibility',
  'track_entity',
  'stop_tracking',
  'frame_overhead',
  'set_visual_style',
  'move_camera',
]);

export const LOCAL_TOOL_SCHEMAS = Object.freeze([
  ...GEV_ACTION_SCHEMAS.filter((schema) =>
    LOCAL_VOICE_ACTIONS.includes(schema.name),
  ),
  ...AUTOPILOT_TOOL_SCHEMAS,
]);
const BY_NAME = new Map(
  LOCAL_TOOL_SCHEMAS.map((schema) => [schema.name, schema]),
);
export const AUTOPILOT_TOOL_NAMES = new Set(
  AUTOPILOT_TOOL_SCHEMAS.map((s) => s.name),
);

/** Output schema for constrained decoding: a reply and at most three calls. */
export const LOCAL_TURN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['language', 'reply', 'calls'],
  properties: {
    language: { enum: ['en', 'ru'] },
    reply: { type: 'string', maxLength: MAX_REPLY },
    calls: {
      type: 'array',
      maxItems: MAX_CALLS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'arguments'],
        properties: {
          name: { enum: LOCAL_TOOL_SCHEMAS.map((schema) => schema.name) },
          arguments: { type: 'object' },
        },
      },
    },
  },
});

const typeOf = (value) =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : Number.isInteger(value)
        ? 'integer'
        : typeof value;

/**
 * Validate a value against the JSON-schema subset the action schemas use
 * (type, enum, const, properties, required, additionalProperties, items,
 * min/max, min/maxLength, min/maxItems, pattern, anyOf). Returns error paths.
 */
export function schemaErrors(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some(
      (option) => !schemaErrors(value, option, path).length,
    );
    return ok ? [] : [`${path}: matches no allowed form`];
  }
  const errors = [];
  if ('const' in schema && value !== schema.const)
    errors.push(`${path}: must be ${schema.const}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    errors.push(`${path}: not an allowed value`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = types.some(
      (t) => t === actual || (t === 'number' && actual === 'integer'),
    );
    if (!ok) return [...errors, `${path}: expected ${types.join('|')}`];
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum)
      errors.push(`${path}: below minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum)
      errors.push(`${path}: above maximum`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength)
      errors.push(`${path}: too short`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength)
      errors.push(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      errors.push(`${path}: bad format`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems)
      errors.push(`${path}: too few items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems)
      errors.push(`${path}: too many items`);
    if (schema.items)
      value.forEach((item, i) =>
        errors.push(...schemaErrors(item, schema.items, `${path}[${i}]`)),
      );
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    // Own keys only: `constructor`, `toString` or `__proto__` must never pass
    // as declared properties through Object.prototype.
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key))
        errors.push(...schemaErrors(child, properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false)
        errors.push(`${path}.${key}: not allowed`);
    }
  }
  return errors.slice(0, 20);
}

/** Strip `<think>` blocks and code fences, then parse. */
function parseJson(text) {
  return JSON.parse(
    String(text ?? '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim(),
  );
}

/**
 * Validate a model reply. Any invalid call rejects the whole reply, so a
 * half-understood command never runs partially.
 * @returns {{ok: true, turn: {language: string, reply: string,
 *   calls: Array<{name: string, arguments: object}>}} | {ok: false, errors: string[]}}
 */
export function validateLocalTurn(text) {
  let value;
  try {
    value = parseJson(text);
  } catch {
    return { ok: false, errors: ['malformed_json'] };
  }
  const shape = schemaErrors(value, LOCAL_TURN_SCHEMA);
  if (shape.length) return { ok: false, errors: shape };
  const errors = [];
  value.calls.forEach((call, index) => {
    const schema = BY_NAME.get(call.name);
    if (!schema) errors.push(`calls[${index}]: unknown tool`);
    else
      errors.push(
        ...schemaErrors(
          call.arguments,
          schema.parameters ?? { type: 'object' },
          `calls[${index}].${call.name}`,
        ),
      );
  });
  if (/\bhttps?:\/\//i.test(value.reply)) errors.push('reply: contains a link');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    turn: {
      language: value.language,
      reply: value.reply.trim(),
      calls: value.calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
    },
  };
}

/** Argument structure without per-field prose: types, enums, bounds, required. */
function compactSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(compactSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' || key === 'additionalProperties') continue;
    out[key] =
      key === 'properties'
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, compactSchema(v)]),
          )
        : compactSchema(value);
  }
  return out;
}

/**
 * Compact catalogue for the prompt: name, first sentence of the purpose and
 * the argument structure. `described` supplies wording for app actions (the
 * server's tool descriptions); Autopilot tools carry their own.
 */
export function toolCatalogText(described = []) {
  const wording = new Map(
    described.map((tool) => [tool.name, tool.description]),
  );
  return LOCAL_TOOL_SCHEMAS.map((schema) => {
    const text = String(wording.get(schema.name) ?? schema.description ?? '')
      .replace(/\s+/g, ' ')
      .split(/(?<=\.)\s/)[0]
      .slice(0, 200);
    const args = JSON.stringify(compactSchema(schema.parameters ?? {}));
    return `- ${schema.name}: ${text}\n  arguments: ${args}`;
  }).join('\n');
}
