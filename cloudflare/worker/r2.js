// cloudflare/worker/r2.js
// SigV4 presigned URLs for the R2 S3 endpoint. Browsers upload and download directly with these.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

let skCache = { id: null, key: null };
async function signingKey(secret, date, region, service) {
  const id = `${secret}|${date}|${region}|${service}`;
  if (skCache.id === id) return skCache.key;
  const kDate = await hmac(enc.encode('AWS4' + secret), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const key = await hmac(kService, 'aws4_request');
  skCache = { id, key };
  return key;
}

// Pure signer (path must already be URI-encoded). Exported for tests.
export async function signUrl({ host, path, method, query = {}, expires, date, region, service = 's3', accessKeyId, secretAccessKey }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`).join('&');
  const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256hex(canonicalRequest)].join('\n');
  const sig = hex(await hmac(await signingKey(secretAccessKey, day, region, service), stringToSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

// stable: signs at the top of the hour so the same thumbnail URL repeats and browsers can cache it.
export async function presign(env, method, key, { expires = 3600, query = {}, stable = false } = {}) {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${env.R2_BUCKET_NAME}/${key.split('/').map(rfc3986).join('/')}`;
  let date = new Date();
  if (stable) {
    date = new Date(Math.floor(date.getTime() / 3600000) * 3600000);
    expires = 7200;
  }
  return signUrl({
    host, path, method, query, expires, date, region: 'auto',
    accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}

// ListParts of a multipart upload (the Worker binding has no list call, so use the S3 API).
export async function listParts(env, key, uploadId) {
  const parts = [];
  let marker = 0;
  for (let guard = 0; guard < 20; guard++) {
    const query = { uploadId, 'max-parts': '1000' };
    if (marker) query['part-number-marker'] = String(marker);
    const res = await fetch(await presign(env, 'GET', key, { expires: 120, query }));
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`ListParts failed: ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const body = m[1];
      const num = /<PartNumber>(\d+)<\/PartNumber>/.exec(body);
      const etag = /<ETag>([\s\S]*?)<\/ETag>/.exec(body);
      const size = /<Size>(\d+)<\/Size>/.exec(body);
      if (num && etag && size) {
        parts.push({
          partNumber: Number(num[1]),
          etag: etag[1].replace(/&quot;|"/g, ''),
          size: Number(size[1]),
        });
      }
    }
    const next = /<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/.exec(xml);
    if (/<IsTruncated>true<\/IsTruncated>/.test(xml) && next) marker = Number(next[1]);
    else break;
  }
  return parts;
}
