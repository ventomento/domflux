/**
 * httpKit – one door for every request, plus fetch-and-insert.
 *
 * Usage:
 *
 * // Optional: headers computed fresh for every request
 * httpKit.setHeaders(async () => ({ 'x-fingerprint': await fingerprint() }));
 *
 * // Same signature and contract as fetch: any HTTP status resolves
 * const res = await httpKit.get('/api/data');
 *
 * // GET HTML (or JSON + render) and insert it; components in it hydrate
 * await httpKit.load(document.getElementById('content'), '/partial.html');
 */

// Insert HTML with the browser's own parser, so custom elements upgrade and
// hydrate. Scripts in it don't run; inline handlers do.
const INSERT = {
  __proto__: null,
  inner:   (el, html) => { el.innerHTML = html; },
  outer:   (el, html) => {
    if (!el.parentNode) throw new Error('Cannot replace a detached element');
    el.outerHTML = html;
  },
  before:  (el, html) => el.insertAdjacentHTML('beforebegin', html),
  prepend: (el, html) => el.insertAdjacentHTML('afterbegin', html),
  append:  (el, html) => el.insertAdjacentHTML('beforeend', html),
  after:   (el, html) => el.insertAdjacentHTML('afterend', html),
};

const PARSE = {
  __proto__: null,
  'text/html':        (res) => res.text(),
  'application/json': (res) => res.json(),
};

let dynamicHeaders = () => ({});

/**
 * Set the function called before every request. It returns (or resolves to) a
 * plain object of headers: a snapshot for that request.
 * @param {(url: string | URL, options: RequestInit) => object | Promise<object>} provider
 */
function setHeaders(provider) {
  dynamicHeaders = provider;
}

/**
 * fetch(url, options), with the dynamic headers added. Per-call headers win.
 * Headers are plain objects; keep names in one casing (e.g. lowercase).
 * Redirects reject by default so the headers never follow one to another
 * site; pass `redirect: 'follow'` to allow them.
 * @param {string | URL} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function request(url, options = {}) {
  return fetch(url, {
    redirect: 'error',
    ...options,
    headers: { ...(await dynamicHeaders(url, options)), ...options.headers },
  });
}

async function read(res) {
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { response: res });
  const type = res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!PARSE[type]) throw new TypeError(`Expected HTML or JSON, got "${type}"`);
  return PARSE[type](res);
}

/**
 * GET url and insert it at `at` relative to target. JSON responses need `render`.
 * Concurrent loads are not coordinated: abort the previous one via `signal`.
 *
 * @param {Element} target
 * @param {string | URL} url
 * @param {Object} [options]
 * @param {'inner'|'outer'|'before'|'prepend'|'append'|'after'} [options.at='inner']
 * @param {(body: any, response: Response) => string} [options.render] - body is text for HTML, parsed JSON for JSON
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Response | undefined>} undefined if `signal` cancelled it
 */
async function load(target, url, { at = 'inner', render = (body) => body, signal } = {}) {
  if (target?.nodeType !== 1) throw new TypeError('target must be an Element');
  if (!INSERT[at]) throw new RangeError(`Invalid position: ${at}`);

  try {
    const res = await request(url, { signal });
    const body = await read(res);
    if (signal?.aborted) return;
    const html = render(body, res);
    if (typeof html !== 'string') throw new TypeError('Expected an HTML string; JSON needs a render function');
    INSERT[at](target, html);
    return res;
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
}

export const httpKit = {
  setHeaders,
  request,
  get:    (url, options)       => request(url, { ...options, method: 'GET' }),
  delete: (url, options)       => request(url, { ...options, method: 'DELETE' }),
  post:   (url, body, options) => request(url, { ...options, method: 'POST', body }),
  put:    (url, body, options) => request(url, { ...options, method: 'PUT', body }),
  patch:  (url, body, options) => request(url, { ...options, method: 'PATCH', body }),
  load,
};
