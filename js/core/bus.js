/**
 * Tiny app-wide event bus. Event names and payloads are listed in docs/CONTRACT.md.
 */
export const bus = new EventTarget();

/**
 * Emit an event with a detail payload.
 * @param {string} name
 * @param {object} [detail]
 */
export function emit(name, detail = {}) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Subscribe to an event.
 * @param {string} name
 * @param {(detail: object) => void} fn
 * @returns {() => void} unsubscribe
 */
export function on(name, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(name, handler);
  return () => bus.removeEventListener(name, handler);
}
