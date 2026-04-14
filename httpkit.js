/**
 * httpKit – Minimal fetch wrapper + HTML-to-DOM insertion helper
 *
 * Features:
 *  - Configurable dynamic header injection (fingerprints, tokens, CSRF, etc.)
 *  - Consistent defaults + full override support
 *  - resourceIntoTarget: fetch HTML → insert/replace using native insertAdjacentHTML
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
 * // Insert HTML
 * await httpKit.resourceIntoTarget('/partial.html', document.getElementById('content'), {
 *   position: 'beforeend',
 *   replace: 'inner'
 * });
 */

export const httpKit = {
  // Overridable header provider (called fresh on every request)
  async getDynamicHeaders() {
    return {};
  },

  /**
   * Set custom async header provider
   * @param {() => Promise<Record<string, string>>} provider
   */
  setHeaderProvider(provider) {
    if (typeof provider !== 'function') {
      throw new TypeError('Header provider must be a function');
    }
    this.getDynamicHeaders = provider;
  },

  /**
   * Core fetch wrapper
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Promise<Response>}
   */
  async request(url, options = {}) {
    const dynamicHeaders = await this.getDynamicHeaders();

    const merged = {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        ...dynamicHeaders,
        ...options.headers,
      },
      ...options,
    };

    const response = await fetch(url, merged);

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
   * Fetch HTML and insert it relative to / replace target element
   * using only native insertAdjacentHTML.
   *
   * @param {string} url - URL returning HTML
   * @param {HTMLElement} target - reference element
   * @param {Object} [options]
   * @param {'beforebegin'|'afterbegin'|'beforeend'|'afterend'} [options.position='beforeend']
   * @param {false|'inner'|'outer'} [options.replace=false]
   *   - false     → insert without removing anything
   *   - 'inner'   → clear target.innerHTML first
   *   - 'outer'   → remove target, insert at its former position
   * @param {boolean} [options.throwOnError=false]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<void>}
   */
  async resourceIntoTarget(url, target, options = {}) {
    const {
      position = 'beforeend',
      replace = false,
      throwOnError = false,
      signal,
    } = options;

    if (!target || !(target instanceof Element)) {
      throw new TypeError('target must be a valid DOM Element');
    }

    const validPositions = ['beforebegin', 'afterbegin', 'beforeend', 'afterend'];
    if (!validPositions.includes(position)) {
      throw new RangeError(`Invalid position: ${position}. Must be one of: ${validPositions.join(', ')}`);
    }

    try {
      const response = await this.request(url, { signal });
      const html = await response.text();

      if (replace === 'inner') {
        target.innerHTML = '';
        target.insertAdjacentHTML(position, html);
        return;
      }

      if (replace === 'outer') {
        const parent = target.parentNode;
        if (!parent) {
          throw new Error('Cannot replace outer: target has no parent');
        }
        const next = target.nextElementSibling;
        target.remove();
        (next || parent).insertAdjacentHTML(next ? 'beforebegin' : 'beforeend', html);
        return;
      }

      // Default: no replace
      target.insertAdjacentHTML(position, html);

    } catch (err) {
      if (throwOnError) throw err;
      console.warn(`Failed to load ${url} into target:`, err);
      // Optional fallback (uncomment if desired):
      // target.insertAdjacentHTML(position, '<div class="error">Failed to load content</div>');
    }
  },

  /**
   * Create AbortController for cancelling requests
   * @returns {AbortController}
   */
  createAbortController() {
    return new AbortController();
  },
};