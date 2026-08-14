/**
 * 관리자 페이지 로그인.
 *
 * 어드민은 계정 ID·도메인·배정 IP 같은 운영 데이터를 전부 보여준다.
 * 도메인을 붙여 밖에 내놓으므로 로그인 없이는 아무것도 안 보이게 한다.
 *
 * 설계 메모
 *   - 외부 인증 라이브러리를 쓰지 않는다. node:crypto 의 scrypt 로 충분하고,
 *     의존성이 늘면 이 저장소에서 관리할 것만 는다.
 *   - 세션 토큰은 DB 에 그대로 저장하지 않고 sha256 만 저장한다. DB 가 새도
 *     그 값으로는 로그인할 수 없다.
 *   - 가입은 열어두되 승인 전에는 데이터를 못 본다. 주소만 알면 누구나
 *     가입해서 운영 데이터를 보는 상황을 막는다. 첫 가입자만 자동 승인되고,
 *     나머지는 DB 에서 직접 승인한다. 승인 화면은 만들지 않는다.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number
) => Promise<Buffer>;

const SESSION_DAYS = 30;
const COOKIE = 'admin_session';

export type DbQuery = (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;

export interface SessionUser {
  id: number;
  username: string;
  name: string | null;
  status: 'pending' | 'approved' | 'blocked';
  role: 'owner' | 'member';
}

// ---------------------------------------------------------------- 비밀번호

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  // 길이가 다르면 timingSafeEqual 이 던진다. 먼저 막는다.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- 요청 유틸

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** 클라이언트 IP. Cloudflare 터널을 거치므로 원본은 CF-Connecting-IP 에 온다. */
export function clientIp(req: IncomingMessage): string | null {
  const header = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const raw = header('cf-connecting-ip')
    || (header('x-forwarded-for') || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || '';
  // ::ffff:1.2.3.4 형태를 벗긴다. inet 컬럼이 그대로는 안 받는다.
  const cleaned = raw.replace(/^::ffff:/, '');
  return /^[0-9a-fA-F.:]+$/.test(cleaned) && cleaned ? cleaned : null;
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function send(res: ServerResponse, status: number, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sessionCookie(token: string, maxAgeSec: number) {
  // Secure 를 항상 켠다. 실제 접속은 Cloudflare 를 거쳐 https 로만 들어온다.
  // localhost 개발에서도 브라우저가 http://localhost 는 예외로 받아준다.
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSec}`;
}

// ---------------------------------------------------------------- 세션

export async function currentUser(query: DbQuery, req: IncomingMessage): Promise<SessionUser | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const { rows } = await query(
    `select u.id, u.username, u.name, u.status, u.role
       from public.admin_sessions s
       join public.admin_users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

async function logEvent(query: DbQuery, req: IncomingMessage, username: string, event: string, userId?: number) {
  await query(
    `insert into public.admin_login_events (user_id, username, event, ip, user_agent)
     values ($1, $2, $3, nullif($4,'')::inet, $5)`,
    [userId ?? null, username, event, clientIp(req) ?? '', String(req.headers['user-agent'] || '').slice(0, 300)],
  ).catch(() => { /* 기록 실패로 로그인을 막지는 않는다 */ });
}

// ---------------------------------------------------------------- 엔드포인트

/**
 * /api/auth/* 를 처리한다. 처리했으면 true.
 */
export async function handleAuth(query: DbQuery, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url || '').split('?')[0];
  const path = url.replace(/^\/api\/auth/, '') || '/';

  // ---- 내 정보 ----
  if (path === '/me' && req.method === 'GET') {
    const user = await currentUser(query, req);
    send(res, 200, { user });
    return true;
  }

  // ---- 가입 ----
  if (path === '/signup' && req.method === 'POST') {
    const { username, password, name } = await readJson(req);
    // 대소문자를 섞어 같은 아이디를 두 번 만들지 못하게 소문자로 통일한다.
    const id = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,30}$/.test(id)) {
      return send(res, 400, { error: '아이디는 영문 소문자·숫자·_- 조합 3~30자입니다.' }), true;
    }
    if (String(password || '').length < 8) return send(res, 400, { error: '비밀번호는 8자 이상이어야 합니다.' }), true;

    const dup = await query('select 1 from public.admin_users where username = $1', [id]);
    if (dup.rowCount) return send(res, 409, { error: '이미 쓰이는 아이디입니다.' }), true;

    // 첫 가입자만 자동 승인. 나머지는 DB 에서 직접 승인한다.
    const count = await query('select count(*)::int n from public.admin_users');
    const first = count.rows[0].n === 0;

    const { rows } = await query(
      `insert into public.admin_users (username, password_hash, name, status, role, created_ip, approved_at)
       values ($1, $2, $3, $4, $5, nullif($6,'')::inet, $7)
       returning id, username, name, status, role`,
      [id, await hashPassword(String(password)), String(name || '').trim() || null,
        first ? 'approved' : 'pending', first ? 'owner' : 'member',
        clientIp(req) ?? '', first ? new Date() : null],
    );
    await logEvent(query, req, id, 'signup', rows[0].id);
    send(res, 201, {
      user: rows[0],
      message: first
        ? '첫 관리자로 등록됐습니다. 바로 로그인하세요.'
        : '가입 신청이 접수됐습니다. 관리자 승인 후 이용할 수 있습니다.',
    });
    return true;
  }

  // ---- 로그인 ----
  if (path === '/login' && req.method === 'POST') {
    const { username, password } = await readJson(req);
    const id = String(username || '').trim().toLowerCase();

    const { rows } = await query(
      'select id, username, name, status, role, password_hash from public.admin_users where username = $1', [id]);
    const user = rows[0];

    // 아이디가 없든 비밀번호가 틀리든 같은 문구를 준다. 어느 쪽이 틀렸는지
    // 알려주면 가입된 아이디를 찾아낼 수 있다.
    if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
      await logEvent(query, req, id, user ? 'login-bad-password' : 'login-unknown-user', user?.id);
      return send(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }), true;
    }
    if (user.status !== 'approved') {
      await logEvent(query, req, id, 'login-not-approved', user.id);
      return send(res, 403, {
        error: user.status === 'pending'
          ? '아직 승인되지 않은 계정입니다. 관리자 승인을 기다려 주세요.'
          : '차단된 계정입니다.',
      }), true;
    }

    const token = randomBytes(32).toString('base64url');
    const maxAge = SESSION_DAYS * 24 * 3600;
    await query(
      `insert into public.admin_sessions (token_hash, user_id, expires_at, ip, user_agent)
       values ($1, $2, now() + ($3 || ' seconds')::interval, nullif($4,'')::inet, $5)`,
      [sha256(token), user.id, String(maxAge), clientIp(req) ?? '',
        String(req.headers['user-agent'] || '').slice(0, 300)],
    );
    await query(
      `update public.admin_users set last_login_at = now(), last_login_ip = nullif($2,'')::inet where id = $1`,
      [user.id, clientIp(req) ?? '']);
    await logEvent(query, req, id, 'login-ok', user.id);

    delete user.password_hash;
    send(res, 200, { user }, sessionCookie(token, maxAge));
    return true;
  }

  // ---- 로그아웃 ----
  if (path === '/logout' && req.method === 'POST') {
    const token = readCookie(req, COOKIE);
    if (token) await query('delete from public.admin_sessions where token_hash = $1', [sha256(token)]);
    send(res, 200, { ok: true }, sessionCookie('', 0));
    return true;
  }

  // 승인은 DB 에서 직접 한다. 화면을 만들지 않는다.
  //   update public.admin_users set status = 'approved' where username = '...';
  return false;
}

/**
 * 데이터 API 앞에 세우는 문지기.
 * 승인된 사용자가 아니면 401/403 을 주고 true 를 돌려준다(= 여기서 끝).
 */
export async function requireApproved(query: DbQuery, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const user = await currentUser(query, req);
  if (!user) return send(res, 401, { error: '로그인이 필요합니다.' }), true;
  if (user.status !== 'approved') return send(res, 403, { error: '승인 대기 중인 계정입니다.' }), true;
  return false;
}
