import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
const secretValid = value => typeof value === 'string' && /^[\x21-\x7e]{24,512}$/.test(value);

// Tenant credentials never travel in URLs or session state. All candidates
// are compared using fixed-length digests; session access is separately checked.
export function createAuthenticator({ token, tenants } = {}) {
  if (tenants !== undefined && tenants !== null) {
    if (token !== undefined && token !== null) throw new Error('Shared token cannot be combined with tenants');
    if (!tenants || typeof tenants !== 'object' || Array.isArray(tenants)) throw new Error('Invalid tenant credentials');
    const list = Object.entries(tenants);
    if (!list.length || list.length > 64) throw new Error('Invalid tenant credentials');
    const used = new Set();
    const entries = list.map(([id, secret]) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || !secretValid(secret)) throw new Error('Invalid tenant credentials');
      const hash = digest(secret);
      const fingerprint = hash.toString('hex');
      if (used.has(fingerprint)) throw new Error('Duplicate tenant credential');
      used.add(fingerprint);
      return { id, hash };
    });
    return authorization => {
      if (typeof authorization !== 'string' || !/^Bearer [\x21-\x7e]{24,512}$/.test(authorization)) return null;
      const supplied = digest(authorization.slice(7));
      let owner = null;
      for (const entry of entries) if (timingSafeEqual(entry.hash, supplied)) owner = entry.id;
      return owner === null ? null : { owner };
    };
  }
  if (!secretValid(token)) throw new Error('A secret token of at least 24 characters is required');
  const expected = digest(token);
  return authorization => {
    if (typeof authorization !== 'string' || !/^Bearer [\x21-\x7e]{24,512}$/.test(authorization)) return null;
    return timingSafeEqual(expected, digest(authorization.slice(7))) ? { owner: null } : null;
  };
}
