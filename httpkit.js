/**
 * httpKit – one door for every request, plus fetch-and-insert.
 *
 * Usage:
 *
 * // Optional: headers computed fresh for every request
 * httpKit.setHeaders(async () => ({ 'x-fingerprint': await fingerprint() }));
 *
 * // Optional: react to every failure in one place (the default logs it)
 * httpKit.setFailureHandler(({ response, error }) => showError(response?.status));
 *
 * // A failure of any kind, an abort included, is a response that isn't ok
 * const res = await httpKit.get('/api/data');
 * if (!res.ok) return;
 *
 * // GET HTML (or JSON + render) and insert it; components in it hydrate
 * await httpKit.load(document.getElementById('content'), '/partial.html');
 */

function attached(el) {
  if (!el.parentNode) throw new Error('Cannot insert next to a detached element');
  return el;
}

const INSERT = {
  __proto__: null,
  inner:   (el, node) => el.replaceChildren(node),
  outer:   (el, node) => attached(el).replaceWith(node),
  before:  (el, node) => attached(el).before(node),
  prepend: (el, node) => el.prepend(node),
  append:  (el, node) => el.append(node),
  after:   (el, node) => attached(el).after(node),
};

const PARSE = {
  __proto__: null,
  'text/html':        (res) => res.text(),
  'application/json': (res) => res.json(),
};

let dynamicHeaders = () => ({});
let onFailure = ({ url, response, error }) => console.error(error ?? `${url}: HTTP ${response.status}`);

/**
 * Set the function called before every request. It returns (or resolves to) a
 * plain object of headers: a snapshot for that request.
 * @param {(url: string | URL, options: RequestInit) => object | Promise<object>} provider
 */
function setHeaders(provider) {
  dynamicHeaders = provider;
}

/**
 * Set the function called on every failed request: a network error (`error`)
 * or a non-2xx response (`response`). It only reacts: the caller still gets
 * its response. To read the body, use `response.clone()`. The default logs.
 * @param {(failure: { url: string | URL, options: RequestInit, response?: Response, error?: Error }) => void} handler
 */
function setFailureHandler(handler) {
  onFailure = handler;
}

/**
 * fetch(url, options), with the dynamic headers added. Per-call headers win.
 * Headers are plain objects; keep names in one casing (e.g. lowercase).
 * Redirects are refused by default so the headers never follow one to another
 * site; pass `redirect: 'follow'` to allow them.
 *
 * Unlike fetch, it never rejects for a failed request: `res.ok` covers every
 * failure. A network error or an abort resolves to `Response.error()`. Only a
 * throwing header provider or failure handler rejects: those are bugs.
 * @param {string | URL} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function request(url, options = {}) {
  // Outside the try: a bug in the provider is not a failed request.
  const headers = { ...(await dynamicHeaders(url, options)), ...options.headers };
  let response;

  try {
    response = await fetch(url, { redirect: 'error', ...options, headers });
  } catch (error) {
    if (error.name !== 'AbortError') onFailure({ url, options, error });
    return Response.error();
  }

  // With redirect: 'manual', the caller asked for the redirect: not a failure.
  if (!response.ok && response.type !== 'opaqueredirect') onFailure({ url, options, response });
  return response;
}

function read(res) {
  const type = res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!PARSE[type]) throw new TypeError(`Expected HTML or JSON, got "${type}"`);
  return PARSE[type](res);
}

// One node to insert. A string is parsed as HTML: its scripts don't run.
function toNode(content) {
  if (content?.nodeType) return content;

  if (typeof content === 'string') {
    const template = document.createElement('template');
    template.innerHTML = content;
    return template.content;
  }

  if (Array.isArray(content)) {
    const fragment = document.createDocumentFragment();
    fragment.append(...content.map(toNode));
    return fragment;
  }

  throw new TypeError('Expected HTML or a Node; JSON needs a render function');
}

/**
 * GET url and insert it at `at` relative to target. JSON responses need `render`.
 * Concurrent loads are not coordinated: abort the previous one via `signal`.
 *
 * @param {Element} target
 * @param {string | URL} url
 * @param {Object} [options]
 * @param {'inner'|'outer'|'before'|'prepend'|'append'|'after'|((target: Element, node: Node) => void)} [options.at='inner'] - a function places the node itself
 * @param {(body: any, response: Response) => string | Node | Array<string | Node>} [options.render] - body is text for HTML, parsed JSON for JSON
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Response | null>} null if nothing was inserted: the request failed or `signal` cancelled it
 */
async function load(target, url, { at = 'inner', render = (body) => body, signal } = {}) {
  if (target?.nodeType !== 1) throw new TypeError('target must be an Element');

  const place = typeof at === 'function' ? at : INSERT[at];
  if (!place) throw new RangeError(`Invalid position: ${at}`);

  try {
    const res = await request(url, { signal });
    if (!res.ok) return null;

    const body = await read(res);
    if (signal?.aborted) return null;

    place(target, toNode(render(body, res)));
    return res;
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
    return null;
  }
}

export const httpKit = {
  setHeaders,
  setFailureHandler,
  request,
  get:    (url, options)       => request(url, { ...options, method: 'GET' }),
  delete: (url, options)       => request(url, { ...options, method: 'DELETE' }),
  post:   (url, body, options) => request(url, { ...options, method: 'POST', body }),
  put:    (url, body, options) => request(url, { ...options, method: 'PUT', body }),
  patch:  (url, body, options) => request(url, { ...options, method: 'PATCH', body }),
  load,
};
