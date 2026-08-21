/**
 * 의존성 없는 R2(S3 호환) 클라이언트 — SigV4 서명을 직접 한다.
 *
 * 왜 직접 하나: 자산 업로드는 aws CLI 를 쓰지만(upload-site-assets-to-r2.mjs)
 * VM 에는 aws CLI 가 없다. 원문 로그 업로드는 VM 에서도 돌아야 하므로
 * node 내장(crypto·https)만 쓴다. @aws-sdk 는 package.json 에 없다.
 *
 * 자격증명은 .env 의 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY —
 * 반드시 trim (개행 섞이면 서명 불일치, r2 스킬 참고).
 */

import { createHash, createHmac } from 'node:crypto';
import { request } from 'node:https';

export function r2ClientFromEnv(env) {
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const accessKeyId = (env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { host: `${accountId}.r2.cloudflarestorage.com`, accessKeyId, secretAccessKey };
}

export async function putObject(client, bucket, key, body, contentType = 'application/octet-stream') {
  const response = await r2Request(client, {
    method: 'PUT',
    bucket,
    key,
    body,
    extraHeaders: { 'content-type': contentType },
  });
  if (response.status !== 200) {
    throw new Error(`PUT ${bucket}/${key} 실패 (HTTP ${response.status}): ${response.body.toString('utf8').slice(0, 300)}`);
  }
}

export async function getObject(client, bucket, key) {
  const response = await r2Request(client, { method: 'GET', bucket, key });
  if (response.status !== 200) {
    throw new Error(`GET ${bucket}/${key} 실패 (HTTP ${response.status}): ${response.body.toString('utf8').slice(0, 300)}`);
  }
  return response.body;
}

export async function deleteObject(client, bucket, key) {
  const response = await r2Request(client, { method: 'DELETE', bucket, key });
  if (response.status !== 204 && response.status !== 200) {
    throw new Error(`DELETE ${bucket}/${key} 실패 (HTTP ${response.status})`);
  }
}

export async function listObjects(client, bucket, prefix) {
  const keys = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const response = await r2Request(client, { method: 'GET', bucket, query });
    if (response.status !== 200) {
      throw new Error(`LIST ${bucket}/${prefix} 실패 (HTTP ${response.status}): ${response.body.toString('utf8').slice(0, 300)}`);
    }
    const xml = response.body.toString('utf8');
    for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(match[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? unescapeXml((xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/) || [])[1] || '')
      : null;
  } while (token);
  return keys;
}

// ---------------------------------------------------------------- 내부

function r2Request(client, { method, bucket, key = '', query = {}, body = null, extraHeaders = {} }) {
  const payload = body == null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);

  const canonicalUri = `/${bucket}${key ? `/${key.split('/').map(encodeRfc3986).join('/')}` : ''}`;
  const canonicalQuery = Object.keys(query).sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(String(query[name]))}`)
    .join('&');
  const canonicalHeaders = `host:${client.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = ['auto', 's3', 'aws4_request']
    .reduce((k, part) => hmac(k, part), hmac(`AWS4${client.secretAccessKey}`, dateStamp));
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const headers = {
    host: client.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${client.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'content-length': payload.length,
    ...extraHeaders,
  };

  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({
      host: client.host,
      method,
      path: canonicalQuery ? `${canonicalUri}?${canonicalQuery}` : canonicalUri,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(120000, () => req.destroy(new Error('R2 요청 타임아웃(120초)')));
    req.on('error', rejectPromise);
    req.end(payload);
  });
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function unescapeXml(value) {
  return value
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function loadDotEnv(readFileSync, dotEnvPath) {
  const out = {};
  let text = '';
  try {
    text = readFileSync(dotEnvPath, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}
