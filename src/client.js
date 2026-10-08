// Local-only HTTP client for the frozen v1 wire contract. Never embed bearer
// secrets in a public website bundle; use a trusted local process or gateway.
const MAX_EVENT_CHARS = 16 * 1024 * 1024;

export class PreviewAPIError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PreviewAPIError';
    this.status = status;
  }
}

function localRoot(input) {
  let url;
  try { url = new URL(input); }
  catch { throw new Error('Invalid Core address'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Preview client requires a loopback HTTP Core address');
  }
  return url.origin;
}

function sessionPath(id, action = '') {
  if (typeof id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)) {
    throw new Error('Invalid session ID');
  }
  return `/sessions/${id}${action ? `/${action}` : ''}`;
}

export class PreviewClient {
  constructor({ baseURL = 'http://127.0.0.1:4177', token, fetchImpl = fetch } = {}) {
    this.baseURL = localRoot(baseURL);
    if (typeof token !== 'string' || token.length < 24 || /[\r\n]/.test(token)) {
      throw new Error('A valid bearer token is required');
    }
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', json, signal } = {}) {
    const response = await this.fetchImpl(`${this.baseURL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      cache: 'no-store',
      redirect: 'error',
      signal
    });
    if (!response.ok) {
      let detail;
      try { detail = (await response.json()).error; } catch {}
      throw new PreviewAPIError(response.status, typeof detail === 'string' ? detail : `Core HTTP ${response.status}`);
    }
    return response;
  }

  async create(options, { signal } = {}) {
    return (await this.request('/sessions', { method: 'POST', json: options, signal })).json();
  }
  async resize(id, dimensions, { signal } = {}) {
    return (await this.request(sessionPath(id, 'resize'), { method: 'POST', json: dimensions, signal })).json();
  }
  async navigate(id, url, { signal } = {}) {
    return (await this.request(sessionPath(id, 'navigate'), { method: 'POST', json: { url }, signal })).json();
  }
  async input(id, event, { signal } = {}) {
    return (await this.request(sessionPath(id, 'input'), { method: 'POST', json: event, signal })).json();
  }
  async screenshot(id, { signal } = {}) {
    const response = await this.request(sessionPath(id, 'screenshot'), { signal });
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('image/png')) {
      throw new Error('Core did not return a PNG screenshot');
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  async close(id, { signal } = {}) {
    return (await this.request(sessionPath(id), { method: 'DELETE', signal })).json();
  }

  // Native EventSource cannot supply the required Authorization header.
  // Use a fetch-based async iterator instead. Calling return()/breaking out of
  // a for-await loop cancels the stream and releases its network reader.
  async *stream(id, { signal } = {}) {
    const response = await this.request(sessionPath(id, 'stream'), { signal });
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
      throw new Error('Core did not return an event stream');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let eventType = '';
    let data = [];
    let dataChars = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        let pos;
        while ((pos = pending.indexOf('\n')) !== -1) {
          if (pos > MAX_EVENT_CHARS) throw new Error('Core stream line too large');
          const line = pending.slice(0, pos).replace(/\r$/, '');
          pending = pending.slice(pos + 1);
          if (!line) {
            if (eventType === 'error') {
              let message = 'Core stream error';
              try { message = JSON.parse(data.join('\n')).error || message; } catch {}
              throw new Error(message);
            }
            if (eventType === 'frame' && data.length) {
              let frame;
              try { frame = JSON.parse(data.join('\n')); }
              catch { throw new Error('Malformed stream frame'); }
              if (frame?.mime !== 'image/jpeg' || typeof frame.data !== 'string' || !frame.data) {
                throw new Error('Invalid stream frame');
              }
              yield frame;
            }
            eventType = '';
            data = [];
            dataChars = 0;
          } else if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const value = line.slice(5).replace(/^ /, '');
            dataChars += value.length;
            if (dataChars > MAX_EVENT_CHARS) throw new Error('Core stream event too large');
            data.push(value);
          }
        }
        if (pending.length > MAX_EVENT_CHARS) throw new Error('Core stream line too large');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
