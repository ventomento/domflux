/**
 * httpKit – Minimal fetch wrapper + HTML-to-DOM insertion helper
 *
 * Features:
 *  - Configurable dynamic header injection (fingerprints, tokens, CSRF, etc.),
 *    sent to the page's own origin only
 *  - Consistent defaults + full override support
 *  - resourceIntoTarget: fetch HTML → insert/replace in the DOM
 *  - AbortSignal support for cancellation
 *
 * Usage:
 *
 * // Optional: set header provider once
 * httpKit.setHeaderProvider(async () => ({
 *   'X-Device-Fingerprint': await getFingerprint(),
 *   'X-CSRF-Token': getCsrfToken(),
 * }));
 *
 * // Simple request
 * const res = await httpKit.get('/api/data');
 *
 * // Insert HTML (custom element components inside it hydrate automatically)
 * await httpKit.resourceIntoTarget('/partial.html', document.getElementById('content'), {
 *   replace: 'inner'
 * });
 */

const isSameOrigin = (url) => new URL(url, location.href).origin === location.origin;

// target → AbortController of its current resourceIntoTarget load
const inflight = new WeakMap();

export const httpKit = {
  // Overridable header provider (called fresh on every same-origin request)
  async getDynamicHeaders() {
    return {};
  },

  /**
   * Set custom async header provider. Its headers are only sent to the page's
   * own origin. Cache expensive values (e.g. fingerprints) inside the provider.
   * @param {() => Promise<HeadersInit>} provider
   */
  setHeaderProvider(provider) {
    if (typeof provider !== 'function') {
      throw new TypeError('Header provider must be a function');
    }
    this.getDynamicHeaders = provider;
  },

  /**
   * Core fetch wrapper.
   *
   * Same-origin requests get `X-Requested-With` and the dynamic headers, and
   * use mode 'same-origin' so a redirect to another origin fails instead of
   * carrying those headers along. Cross-origin requests only get the headers
   * passed in `options`. Header precedence: defaults < dynamic < options.headers.
   *
   * @param {string | URL} url
   * @param {RequestInit} [options]
   * @returns {Promise<Response>}
   */
  async request(url, options = {}) {
    const sameOrigin = isSameOrigin(url);
    const headers = new Headers();

    if (sameOrigin) {
      headers.set('X-Requested-With', 'XMLHttpRequest');
      new Headers(await this.getDynamicHeaders()).forEach((value, name) => headers.set(name, value));
    }
    new Headers(options.headers).forEach((value, name) => headers.set(name, value));

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      ...(sameOrigin && { mode: 'same-origin' }),
      ...options,
      headers,
    });

    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        response,
        status: response.status,
        statusText: response.statusText,
      });
    }

    return response;
  },

  // Shorthands
  get(url, options = {}) {
    return this.request(url, { ...options, method: 'GET' });
  },

  post(url, body, options = {}) {
    return this.request(url, { ...options, method: 'POST', body });
  },

  put(url, body, options = {}) {
    return this.request(url, { ...options, method: 'PUT', body });
  },

  delete(url, body, options = {}) {
    return this.request(url, { ...options, method: 'DELETE', body });
  },

  /**
   * Fetch HTML and insert it relative to / replace the target element.
   *
   * The HTML is inserted as-is (inline event handlers in it will run), so the
   * endpoint must return trusted markup. Cross-origin URLs are refused unless
   * `allowCrossOrigin` is set, and responses must be `text/html`.
   *
   * Starting a new load into the same target cancels the previous one.
   * Cancelled loads resolve silently.
   *
   * @param {string | URL} url - URL returning HTML
   * @param {Element} target - reference element
   * @param {Object} [options]
   * @param {'beforebegin'|'afterbegin'|'beforeend'|'afterend'} [options.position='beforeend']
   *   - ignored when `replace` is set
   * @param {false|'inner'|'outer'} [options.replace=false]
   *   - false     → insert at `position` without removing anything
   *   - 'inner'   → replace the target's contents
   *   - 'outer'   → replace the target itself
   * @param {boolean} [options.throwOnError=false]
   * @param {boolean} [options.allowCrossOrigin=false]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<void>}
   */
  async resourceIntoTarget(url, target, options = {}) {
    const {
      position = 'beforeend',
      replace = false,
      throwOnError = false,
      allowCrossOrigin = false,
      signal,
    } = options;

    if (target?.nodeType !== 1) {
      throw new TypeError('target must be a valid DOM Element');
    }

    const validPositions = ['beforebegin', 'afterbegin', 'beforeend', 'afterend'];
    if (!validPositions.includes(position)) {
      throw new RangeError(`Invalid position: ${position}. Must be one of: ${validPositions.join(', ')}`);
    }

    if (!allowCrossOrigin && !isSameOrigin(url)) {
      throw new Error(`Refusing to insert HTML from another origin: ${url}`);
    }

    inflight.get(target)?.abort();
    const controller = new AbortController();
    inflight.set(target, controller);

    try {
      const response = await this.request(url, {
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });

      const type = response.headers.get('Content-Type') ?? '';
      if (!type.toLowerCase().includes('text/html')) {
        throw new TypeError(`Expected text/html from ${url}, got "${type}"`);
      }

      const html = await response.text();
      if (controller.signal.aborted || signal?.aborted) return;

      if (replace === 'inner') {
        target.innerHTML = html;
      } else if (replace === 'outer') {
        if (!target.parentNode) {
          throw new Error('Cannot replace outer: target has no parent');
        }
        target.outerHTML = html;
      } else {
        target.insertAdjacentHTML(position, html);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (throwOnError) throw err;
      console.warn(`Failed to load ${url} into target:`, err);
    } finally {
      if (inflight.get(target) === controller) inflight.delete(target);
    }
  },
};
