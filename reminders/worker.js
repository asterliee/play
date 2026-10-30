/*
 * Asterlie streak reminders (Cloudflare Worker)
 *
 * After each solve the game asks for a reminder, for example "tomorrow at
 * 7pm, unless I play first", and this Worker sends it as a push notification
 * at that time. A newer request from the same device replaces the older one,
 * so a player who keeps solving never gets one.
 *
 * Needs a D1 database bound as DB, and a Cron Trigger that runs every minute
 * (cron expression: * * * * *). The first time it runs, the Worker creates
 * its tables and its push keys. Don't delete the database: the keys are kept
 * there, and every player's reminders depend on them.
 *
 *   GET  /          status page
 *   GET  /try       page that sends this browser a test notification
 *   GET  /key       public push key the game subscribes with
 *   POST /remind    { subscription, at, until, title, body, url }
 *                   at and until are milliseconds since 1970; at: null cancels
 *   POST /forget    { endpoint }        forget this device
 *   POST /test      { subscription }    send a test notification now
 */

const GAME = 'https://asterliee.github.io/play/';
const ORIGINS = ['https://asterliee.github.io']; // sites allowed to call this Worker
const BATCH = 10; // most reminders sent per minute (600 an hour), well inside the free plan's 10 ms per run. On the paid plan this can go up to 40.
const KEEP_DAYS = 90; // forget devices the game hasn't been heard from in this long
const DAY = 86400000;

class Bad extends Error {} // the request is wrong (400)
class NotReady extends Error {} // setup isn't finished (503)

const te = new TextEncoder();
const mem = { ready: null, vapid: null, jwt: new Map() };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);
    const now = Date.now();
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      switch (req.method + ' ' + url.pathname) {
        case 'GET /': return await statusPage(env, now);
        case 'GET /try': return page(TRY_PAGE, 'text/html; charset=utf-8');
        case 'GET /try-sw.js': return page(TRY_SW, 'text/javascript; charset=utf-8');
        case 'GET /key': await ready(env); return reply({ key: (await vapid(env)).publicKey }, cors);
        case 'POST /remind': return reply(await remind(env, await readJson(req), now), cors);
        case 'POST /forget': return reply(await forget(env, await readJson(req)), cors);
        case 'POST /test': return reply(await test(env, await readJson(req), now), cors);
        default: return reply({ error: 'not found' }, cors, 404);
      }
    } catch (e) {
      if (e instanceof Bad) return reply({ error: e.message }, cors, 400);
      if (e instanceof NotReady) return reply({ error: e.message }, cors, 503);
      console.error((e && e.stack) || e);
      return reply({ error: 'something went wrong' }, cors, 500);
    }
  },

  async scheduled(controller, env) {
    await ready(env);
    const now = Date.now();
    // Take the reminders that are due in one step, so a run that's cut short can't send twice.
    const [claimed] = await env.DB.batch([
      env.DB.prepare(`UPDATE devices SET send_at = NULL WHERE endpoint IN
          (SELECT endpoint FROM devices WHERE send_at IS NOT NULL AND send_at <= ?1 ORDER BY send_at LIMIT ?2)
        RETURNING endpoint, p256dh, auth, expires_at, title, body, url, tag`).bind(now, BATCH),
      note(env, 'last_run', { at: now }),
    ]);
    const due = claimed.results.filter((d) => d.expires_at > now);
    if (due.length) {
      await vapid(env);
      const results = await Promise.all(due.map((d) =>
        push(env, d, { title: d.title, body: d.body, url: d.url, tag: d.tag }, (d.expires_at - now) / 1000, now)
          .catch((e) => ({ ok: false, gone: false, status: 0, host: hostOf(d.endpoint), detail: String((e && e.message) || e) }))));
      // A device that's gone (the player turned notifications off or removed the app) is forgotten.
      const writes = due.filter((d, i) => results[i].gone)
        .map((d) => env.DB.prepare('DELETE FROM devices WHERE endpoint = ?').bind(d.endpoint));
      const sent = results.filter((r) => r.ok).length;
      if (sent) writes.push(note(env, 'last_sent', { at: now, count: sent }));
      const problem = results.find((r) => !r.ok && !r.gone);
      if (problem) writes.push(note(env, 'last_problem', { at: now, status: problem.status, host: problem.host, detail: problem.detail }));
      if (writes.length) await env.DB.batch(writes);
    }
    // Once a day, forget devices the game hasn't been heard from in a long time.
    if (controller.scheduledTime % DAY < 60000) {
      await env.DB.prepare('DELETE FROM devices WHERE seen < ?').bind(now - KEEP_DAYS * DAY).run();
    }
  },
};

// ---------------------------------------------------------------- requests

async function remind(env, input, now) {
  const device = readSubscription(input.subscription, env);
  let at = null, until = null;
  if (input.at != null) {
    at = Math.round(Number(input.at));
    until = Math.round(Number(input.until));
    if (!Number.isFinite(at) || !Number.isFinite(until) || until <= at) throw new Bad('at and until must be times in milliseconds, with until after at');
    if (at > now + 3 * DAY) throw new Bad('at is more than 3 days away');
    if (until - at > DAY) throw new Bad('until is more than a day after at');
  }
  await ready(env);
  await env.DB.prepare(`INSERT INTO devices (endpoint, p256dh, auth, send_at, expires_at, title, body, url, tag, seen)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, send_at = ?4, expires_at = ?5,
        title = ?6, body = ?7, url = ?8, tag = ?9, seen = ?10`)
    .bind(device.endpoint, device.p256dh, device.auth, at, until,
      clip(input.title, 80) || 'Asterlie', clip(input.body, 200), gameUrl(input.url), clip(input.tag, 40) || 'reminder', now)
    .run();
  return { ok: true };
}

async function forget(env, input) {
  const endpoint = String(input.endpoint || (input.subscription && input.subscription.endpoint) || '');
  if (!endpoint) throw new Bad('endpoint missing');
  await ready(env);
  await env.DB.prepare('DELETE FROM devices WHERE endpoint = ?').bind(endpoint).run();
  return { ok: true };
}

async function test(env, input, now) {
  const device = readSubscription(input.subscription, env);
  await ready(env);
  let r;
  try {
    r = await push(env, device, { title: 'Asterlie', body: 'Reminders are working.', url: GAME, tag: 'test' }, 600, now);
  } catch (e) {
    r = { ok: false, gone: false, status: 0, host: hostOf(device.endpoint), detail: String((e && e.message) || e) };
  }
  if (!r.ok && !r.gone) await note(env, 'last_problem', { at: now, status: r.status, host: r.host, detail: r.detail }).run();
  return { ok: r.ok, status: r.status, detail: r.detail };
}

async function statusPage(env, now) {
  try {
    await ready(env);
    await vapid(env); // makes the push keys on the first visit
    const [counts, notes] = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS players, COUNT(send_at) AS waiting FROM devices'),
      env.DB.prepare("SELECT k, v FROM config WHERE k IN ('last_run', 'last_sent', 'last_problem')"),
    ]);
    const c = counts.results[0];
    const n = Object.fromEntries(notes.results.map((r) => [r.k, JSON.parse(r.v)]));
    return text([
      'Asterlie reminders: running',
      '',
      'Players with reminders on: ' + c.players,
      'Reminders waiting to send: ' + c.waiting,
      'Schedule: ' + (n.last_run ? 'last ran ' + ago(now, n.last_run.at)
        : "hasn't run yet. Check the Cron Trigger (every minute). A new one can take up to 15 minutes to start."),
      'Last sent: ' + (n.last_sent ? n.last_sent.count + (n.last_sent.count === 1 ? ' reminder, ' : ' reminders, ') + ago(now, n.last_sent.at) : 'nothing yet'),
      'Last problem: ' + (n.last_problem ? describe(n.last_problem) + ', ' + ago(now, n.last_problem.at) : 'none'),
      '',
    ].join('\n'));
  } catch (e) {
    if (e instanceof NotReady) return text('Asterlie reminders: almost ready\n\n' + e.message + '\n', 503);
    throw e;
  }
}

// ---------------------------------------------------------------- storage

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
     endpoint TEXT PRIMARY KEY,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     send_at INTEGER,
     expires_at INTEGER,
     title TEXT,
     body TEXT,
     url TEXT,
     tag TEXT,
     seen INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS devices_send_at ON devices (send_at)',
  'CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
];

function ready(env) {
  if (!env.DB) throw new NotReady("The database isn't connected yet. On this Worker's Bindings tab, add a D1 database binding with the variable name DB.");
  if (!mem.ready) mem.ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { mem.ready = null; throw e; });
  return mem.ready;
}

function note(env, k, v) {
  return env.DB.prepare('INSERT INTO config (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = ?2').bind(k, JSON.stringify(v));
}

// ---------------------------------------------------------------- web push

// The Worker's own signing keys (VAPID), made once and kept in the database.
function vapid(env) {
  if (!mem.vapid) mem.vapid = loadVapid(env).catch((e) => { mem.vapid = null; throw e; });
  return mem.vapid;
}

async function loadVapid(env) {
  const read = () => env.DB.prepare("SELECT v FROM config WHERE k = 'vapid'").first('v');
  let stored = await read();
  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    // If two requests get here at once, the first key saved wins and both use it.
    await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('vapid', ?)").bind(JSON.stringify({ x: jwk.x, y: jwk.y, d: jwk.d })).run();
    stored = await read();
  }
  const { x, y, d } = JSON.parse(stored);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { key, publicKey: b64u(concat([4], unb64u(x), unb64u(y))) };
}

// Signed token telling the push service who is sending (RFC 8292). One per push service, reused for a while.
function authorization(endpoint, v, now) {
  const aud = new URL(endpoint).origin;
  const t = Math.floor(now / 1000);
  const hit = mem.jwt.get(aud);
  if (hit && hit.exp - t > 3600) return hit.value;
  const exp = t + 12 * 3600;
  const value = (async () => {
    const part = (o) => b64u(te.encode(JSON.stringify(o)));
    const unsigned = part({ typ: 'JWT', alg: 'ES256' }) + '.' + part({ aud, exp, sub: GAME });
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, te.encode(unsigned)));
    return 'vapid t=' + unsigned + '.' + b64u(sig) + ', k=' + v.publicKey;
  })();
  mem.jwt.set(aud, { exp, value });
  value.catch(() => mem.jwt.delete(aud));
  return value;
}

async function push(env, device, message, ttl, now) {
  const v = await vapid(env);
  const res = await fetch(device.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await authorization(device.endpoint, v, now),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(Math.max(0, Math.min(86400, Math.round(ttl)))),
      Urgency: 'high',
    },
    body: await encrypt(device, JSON.stringify(message)),
  });
  const detail = (await res.text()).slice(0, 200);
  return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status, host: hostOf(device.endpoint), detail: res.ok ? '' : detail };
}

// Encrypts the message so only the player's device can read it (RFC 8291, aes128gcm).
async function encrypt(device, message) {
  const uaPublic = unb64u(device.p256dh);
  const authSecret = unb64u(device.auth);
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, local.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPublic, asPublic, [1]));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(message), [2])));
  const header = new Uint8Array(86); // salt, record size, key length, our public key
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// Only these push services are contacted, so nobody can use this Worker to send requests anywhere else.
function knownPushService(url) {
  const h = url.hostname;
  return url.protocol === 'https:' && (h === 'fcm.googleapis.com' || h === 'android.googleapis.com' ||
    h === 'web.push.apple.com' || h.endsWith('.push.apple.com') ||
    h.endsWith('.push.services.mozilla.com') || h.endsWith('.notify.windows.com'));
}

function readSubscription(s, env) {
  if (!s || typeof s !== 'object') throw new Bad('subscription missing');
  const endpoint = String(s.endpoint || '');
  let url;
  try { url = new URL(endpoint); } catch { throw new Bad('subscription endpoint is not a URL'); }
  if (endpoint.length > 1000) throw new Bad('subscription endpoint is too long');
  if (env.ALLOW_ANY_PUSH_HOST !== 'yes' && !knownPushService(url)) throw new Bad('subscription endpoint is not a known push service');
  const keys = s.keys || {};
  const p256dh = String(keys.p256dh || ''), auth = String(keys.auth || '');
  let pk, au;
  try { pk = unb64u(p256dh); au = unb64u(auth); } catch { throw new Bad('subscription keys are not valid'); }
  if (pk.length !== 65 || pk[0] !== 4 || au.length !== 16) throw new Bad('subscription keys are not valid');
  return { endpoint, p256dh, auth };
}

// ---------------------------------------------------------------- helpers

function corsHeaders(req) {
  const o = req.headers.get('Origin') || '';
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return ok
    ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : { Vary: 'Origin' };
}

async function readJson(req) {
  const s = await req.text();
  if (s.length > 8000) throw new Bad('request is too large');
  let v;
  try { v = JSON.parse(s); } catch { throw new Bad('send a JSON object'); }
  if (!v || typeof v !== 'object') throw new Bad('send a JSON object');
  return v;
}

function reply(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
function text(s, status = 200) {
  return new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function page(s, type) {
  return new Response(s, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
}

function clip(s, n) { return typeof s === 'string' ? s.trim().slice(0, n) : ''; }
function gameUrl(u) { return typeof u === 'string' && u.startsWith(GAME) && u.length <= 300 ? u : GAME; }
function hostOf(u) { try { return new URL(u).host; } catch { return '?'; } }
function describe(p) { return (p.status ? 'error ' + p.status : 'no response') + ' from ' + p.host + (p.detail ? ': ' + p.detail : ''); }

function ago(now, then) {
  const m = Math.round((now - then) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- test page

const TRY_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Asterlie reminders: test</title>
<style>
  body { font: 17px/1.5 system-ui, -apple-system, sans-serif; max-width: 32em; margin: 3em auto; padding: 0 1.2em; color: #222; background: #F5F4F0; }
  button { font: inherit; font-weight: 600; padding: .7em 1.3em; border: 0; border-radius: 999px; background: #222; color: #fff; cursor: pointer; }
  #s { margin-top: 1.2em; min-height: 3em; }
</style>
<h1>Test a reminder</h1>
<p>This sends a notification to this browser, to check that reminders work from start to finish. Use a computer or an Android phone: on iPhone, only apps added to the Home Screen can get notifications.</p>
<button id="b">Send me a test notification</button>
<p id="s"></p>
<script>
  var say = function (t) { document.getElementById('s').textContent = t; };
  function keyBytes(k) {
    var s = atob(k.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((k.length + 3) % 4));
    return Uint8Array.from(s, function (c) { return c.charCodeAt(0); });
  }
  document.getElementById('b').onclick = async function () {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        return say("This browser can't get notifications from a web page. Try Chrome, Edge, Firefox or Safari on a computer, or Chrome on Android.");
      }
      say('Asking for permission...');
      if ((await Notification.requestPermission()) !== 'granted') {
        return say("Notifications are blocked for this page. Allow them in the browser's site settings, then try again.");
      }
      await navigator.serviceWorker.register('/try-sw.js');
      var reg = await navigator.serviceWorker.ready;
      var key = (await (await fetch('/key')).json()).key;
      var old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe();
      var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      say('Sending...');
      var r = await (await fetch('/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) })).json();
      say(r.ok ? "Sent. It should appear within a few seconds. If it doesn't, check that your computer allows notifications from this browser."
        : 'The push service turned it down (' + (r.status || 'no response') + '). ' + (r.detail || r.error || ''));
    } catch (e) {
      say('Something went wrong: ' + e.message);
    }
  };
</script>
`;

const TRY_SW = `self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data.json(); } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Asterlie', { body: d.body || '', tag: d.tag || 'test', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data.url));
});
`;
