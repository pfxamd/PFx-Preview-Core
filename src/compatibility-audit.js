// A successful screenshot proves only that Chromium rendered *something*.
// Explicitly reject common anti-bot/interstitial responses before describing
// an external site as compatible. This is a conservative diagnostic heuristic,
// not an attempt to bypass website access controls.
const challengeTitles = [
  /^just a moment(?:\.{1,3}|…)?$/i,
  /^attention required!?\s*(?:\|\s*cloudflare)?$/i,
  /^checking your browser\b/i,
  /^verify (?:you are|that you are) (?:a )?human\b/i,
  /^(?:security|bot|human) verification\b/i,
  /^access denied(?:\s*\|.*)?$/i,
  /^robot check\b/i
];

export function auditCompatibility({ title, finalUrl, httpStatus, challengeMarkers = false } = {}) {
  if (!title || typeof title !== 'string' || !title.trim()) return { compatible: false, reason: 'Document has no title' };
  if (httpStatus != null && (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300)) {
    return { compatible: false, reason: `HTTP status ${httpStatus}` };
  }
  if (challengeTitles.some(pattern => pattern.test(title.trim()))) {
    return { compatible: false, reason: 'Website returned a security challenge or access-denied page' };
  }
  if (typeof finalUrl !== 'string') return { compatible: false, reason: 'No final URL' };
  let url;
  try { url = new URL(finalUrl); } catch { return { compatible: false, reason: 'Invalid final URL' }; }
  if (/^(?:challenges\.cloudflare\.com|www\.google\.com|recaptcha\.net)$/i.test(url.hostname) ||
      /\/cdn-cgi\/(?:challenge-platform|l\/challenge)/i.test(url.pathname)) {
    return { compatible: false, reason: 'Redirected to a browser/security challenge' };
  }
  if (challengeMarkers) return { compatible: false, reason: 'Security challenge DOM detected' };
  return { compatible: true, reason: null };
}