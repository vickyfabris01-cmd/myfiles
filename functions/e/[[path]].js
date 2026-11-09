// functions/e/[[path]].js  (Cloudflare Pages Function, runs for every /e/<TOKEN> share link)
// Serves the normal event page, but first writes the event's title, description and preview image
// into <head>, because WhatsApp/Telegram/Slack/iMessage crawlers do not run JavaScript.
// If anything goes wrong (event unavailable, API down) the plain page is served unchanged.
import { CONFIG } from '../../js/config.js';

// Same protections as the /e/* block in _headers. Pages does not always apply _headers to function
// responses, so these are only used when the asset response did not already carry them.
const FALLBACK_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://*.r2.cloudflarestorage.com; media-src 'self' blob: https://*.r2.cloudflarestorage.com; connect-src 'self' https://*.workers.dev https://*.r2.cloudflarestorage.com; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function loadPage(env, url) {
  let target = new URL('/event', url); // _redirects maps /e/* to /event; fetch the page itself
  for (let i = 0; i < 3; i++) {
    const res = await env.ASSETS.fetch(new Request(target.toString()));
    if (res.status >= 300 && res.status < 400 && res.headers.get('Location')) {
      target = new URL(res.headers.get('Location'), target);
      continue;
    }
    return res;
  }
  return env.ASSETS.fetch(new Request(new URL('/event.html', url).toString()));
}

async function fetchPreview(token) {
  try {
    const res = await fetch(`${CONFIG.API_URL}/event/${encodeURIComponent(token)}/preview`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json && json.success ? json.data : null;
  } catch {
    return null;
  }
}

function metaTags(p, pageUrl) {
  const t = [
    `<meta name="description" content="${esc(p.description || '')}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="MyFiles">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    `<meta property="og:description" content="${esc(p.description || '')}">`,
    `<meta property="og:url" content="${esc(pageUrl)}">`,
    `<meta name="twitter:title" content="${esc(p.title)}">`,
    `<meta name="twitter:description" content="${esc(p.description || '')}">`,
  ];
  if (p.image && p.image.url) {
    t.push(
      `<meta property="og:image" content="${esc(p.image.url)}">`,
      `<meta property="og:image:secure_url" content="${esc(p.image.url)}">`,
      `<meta property="og:image:type" content="image/jpeg">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:image" content="${esc(p.image.url)}">`,
    );
    if (p.image.width && p.image.height) {
      t.push(`<meta property="og:image:width" content="${p.image.width}">`, `<meta property="og:image:height" content="${p.image.height}">`);
    }
  } else {
    t.push(`<meta name="twitter:card" content="summary">`);
  }
  return t.join('\n  ');
}

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  const page = await loadPage(env, url);
  const token = Array.isArray(params.path) ? params.path[0] : params.path;
  const preview = token ? await fetchPreview(token) : null;

  const headers = new Headers(page.headers);
  for (const [k, v] of Object.entries(FALLBACK_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  headers.delete('Content-Length'); // body length changes after rewriting

  if (!preview) return new Response(page.body, { status: page.status, headers });

  const rewritten = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(preview.title); } })
    .on('head', { element(el) { el.append(`\n  ${metaTags(preview, `${url.origin}${url.pathname}`)}\n`, { html: true }); } })
    .transform(new Response(page.body, { status: page.status, headers }));
  return rewritten;
}
