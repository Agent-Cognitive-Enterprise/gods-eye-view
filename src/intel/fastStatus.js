// How far along an event is from a first report to an established fact, in the
// words of an alert card. Derived from the engine's verification state and
// never stored, so it cannot disagree with it. Pure and portable.

/** A claim must suggest at least this severity to be drawn before corroboration. */
export const PROVISIONAL_MIN_SEVERITY = 50;

/** Weakest to strongest, then the two ways a claim ends. */
export const FAST_STATUSES = Object.freeze([
  'candidate',
  'provisional',
  'corroborated',
  'official',
  'contested',
  'retracted',
  'resolved',
]);

const FROM_VERIFICATION = Object.freeze({
  corroborated: 'corroborated',
  officially_reported: 'official',
  disputed: 'contested',
  retracted: 'retracted',
  resolved: 'resolved',
});

const located = (event) =>
  (event.location?.lat ?? null) !== null || Boolean(event.location?.bounds);

/**
 * `candidate`: held in the queue, not drawn. `provisional`: unconfirmed but
 * located and serious enough to be drawn, unmistakably as a claim.
 */
export function fastStatus(event) {
  const settled = FROM_VERIFICATION[event.verification];
  if (settled) return settled;
  return located(event) && (event.severity ?? 0) >= PROVISIONAL_MIN_SEVERITY
    ? 'provisional'
    : 'candidate';
}

/** Whether a map marker may be drawn for this event at all. */
export const fastStatusDrawn = (status) => status !== 'candidate';
