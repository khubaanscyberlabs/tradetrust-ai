/** Local demo authentication. Not external identity/email verification. */
export type LocalSessionConfig = {
  TRADETRUST_AUTH_MODE?: string;
  TRADETRUST_LOCAL_LOGIN_SHA256?: string;
  TRADETRUST_LOCAL_SUBJECT?: string;
};
export const LOCAL_ORIGIN = 'http://127.0.0.1:8787';
export const LOCAL_ISSUER = 'urn:tradetrust:local-merchant';
const COOKIE = 'tt_local_session';
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
type Statement = {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{success: boolean}>;
};
type Database = {prepare(sql: string): Statement};
type ReadDatabase = {prepare(sql: string): {
  bind(...values: string[]): {first<T>(): Promise<T | null>};
}};
export function localConfigured(env: LocalSessionConfig | undefined): boolean {
  return env?.TRADETRUST_AUTH_MODE === 'LOCAL_SESSION' &&
    HEX.test(env.TRADETRUST_LOCAL_LOGIN_SHA256 || '') &&
    ID.test(env.TRADETRUST_LOCAL_SUBJECT || '');
}
export function localRequest(request: Request, env: LocalSessionConfig | undefined): boolean {
  return localConfigured(env) && new URL(request.url).origin === LOCAL_ORIGIN &&
    request.headers.get('Origin') === LOCAL_ORIGIN &&
    !request.headers.has('Cf-Access-Jwt-Assertion') &&
    !request.headers.has('Authorization') &&
    ['same-origin', null].includes(request.headers.get('Sec-Fetch-Site'));
}
export async function localDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2,'0')).join('');
}
function equal(a: string,b: string): boolean {
  if(a.length !== b.length) return false;
  let diff=0; for(let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i);
  return diff === 0;
}
function sessionCookie(request: Request): string | null {
  const entries=(request.headers.get('Cookie') || '').split(';').map(x=>x.trim())
    .filter(x=>x.split('=')[0] === COOKIE);
  if(entries.length !== 1) return null;
  const value=entries[0].slice(COOKIE.length+1);
  return HEX.test(value) ? value : null;
}
export async function verifyLocalHuman(request: Request,
  env: LocalSessionConfig & {DB?: ReadDatabase}) {
  if(!localRequest(request,env) || !env.DB) throw Error('LOCAL_IDENTITY_REJECTED');
  const token=sessionCookie(request);
  if(!token) throw Error('LOCAL_IDENTITY_REJECTED');
  const row=await env.DB.prepare(`SELECT a.subject FROM local_merchant_sessions s
    JOIN merchant_actors a ON a.id=s.actor_id
    WHERE s.token_sha256=? AND s.expires_at > unixepoch()
      AND a.provider='LOCAL_SESSION' AND a.issuer=? AND a.status='ACTIVE'
      AND a.subject=? AND s.credential_sha256=? LIMIT 1`)
    .bind(await localDigest(token), LOCAL_ISSUER, env.TRADETRUST_LOCAL_SUBJECT!,
      env.TRADETRUST_LOCAL_LOGIN_SHA256!).first<{subject:string}>();
  if(!row || row.subject !== env.TRADETRUST_LOCAL_SUBJECT) throw Error('LOCAL_IDENTITY_REJECTED');
  return Object.freeze({provider:'LOCAL_SESSION' as const,issuer:LOCAL_ISSUER,subject:row.subject});
}
function reply(status:number, body:unknown, cookie?:string):Response {
  return new Response(JSON.stringify(body),{status,headers:{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
    ...(cookie ? {'Set-Cookie':cookie} : {})}});
}
// HTTP-only cookie is limited to an explicitly configured loopback demo.
// This route must never be repurposed as a hosted/production login.
export async function localSessionEndpoint(request:Request,
  env:(LocalSessionConfig & {DB?:Database}) | undefined,
  readBody:(request:Request)=>Promise<string>):Promise<Response> {
  if(!localConfigured(env) || new URL(request.url).origin !== LOCAL_ORIGIN || !env?.DB)
    return reply(404,{error:'not_found'});
  if(request.method !== 'POST') return reply(405,{error:'method_not_allowed'});
  if(!localRequest(request,env)) return reply(403,{error:'forbidden'});
  const path=new URL(request.url).pathname;
  try {
    if(path === '/api/local-auth/logout') {
      const token=sessionCookie(request);
      if(token) {
        const result=await env.DB.prepare('DELETE FROM local_merchant_sessions WHERE token_sha256=?')
          .bind(await localDigest(token)).run();
        if(!result.success) throw Error('SESSION_DELETE_FAILED');
      }
      return reply(200,{status:'SIGNED_OUT'},`${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0`);
    }
    if(path !== '/api/local-auth/login') return reply(404,{error:'not_found'});
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type')||''))
      return reply(415,{error:'unsupported_media_type'});
    let data:unknown;
    try {const body=await readBody(request); if(new TextEncoder().encode(body).length>1024) return reply(413,{error:'body_too_large'}); data=JSON.parse(body);}
    catch {return reply(400,{error:'invalid_request'});}
    if(!data || typeof data !== 'object' || Array.isArray(data) ||
       Object.keys(data).join('|') !== 'credential') return reply(400,{error:'invalid_request'});
    const credential=(data as {credential:unknown}).credential;
    if(typeof credential !== 'string' || !HEX.test(credential) ||
       !equal(await localDigest(credential), env.TRADETRUST_LOCAL_LOGIN_SHA256!))
      return reply(403,{error:'forbidden'});
    const actor=await env.DB.prepare(`SELECT id FROM merchant_actors WHERE
      provider='LOCAL_SESSION' AND issuer=? AND subject=? AND status='ACTIVE' LIMIT 1`)
      .bind(LOCAL_ISSUER, env.TRADETRUST_LOCAL_SUBJECT!).first<{id:string}>();
    if(!actor || !ID.test(actor.id)) return reply(403,{error:'forbidden'});
    const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
    // One session per actor; a new login revokes the preceding session atomically.
    const result=await env.DB.prepare(`INSERT INTO local_merchant_sessions
      (actor_id,token_sha256,credential_sha256,expires_at) VALUES(?,?,?,unixepoch()+900)
      ON CONFLICT(actor_id) DO UPDATE SET token_sha256=excluded.token_sha256,
      credential_sha256=excluded.credential_sha256,expires_at=excluded.expires_at`)
      .bind(actor.id,await localDigest(token),env.TRADETRUST_LOCAL_LOGIN_SHA256!).run();
    if(!result.success) throw Error('SESSION_WRITE_FAILED');
    return reply(200,{status:'LOCAL_MERCHANT_SESSION',expiresInSeconds:900,
      externallyVerifiedIdentity:false},`${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=900`);
  } catch {return reply(503,{error:'authentication_unavailable'});}
}
