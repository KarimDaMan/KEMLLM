// kemllmbackend — KEMLLM backend Cloudflare Worker
// Handles GitHub OAuth + cross-device sync (chats, settings, custom models)
// via Cloudflare KV.
//
// Bindings (set in wrangler.toml or via the Cloudflare API):
//   SYNC                  → KV namespace for per-user sync data
//   GITHUB_CLIENT_ID      → secret, public part of OAuth app
//   GITHUB_CLIENT_SECRET  → secret, private part of OAuth app
//
// Endpoints:
//   GET  /github/callback        OAuth code exchange. Issues a sync_token
//                                that's stored in KV next to the user's data
//                                and used by the frontend to authenticate
//                                future /sync requests without exposing the
//                                GitHub access token.
//   POST /sync                   Replace the entire user's sync blob.
//                                Body: { user: 'github-login', token: '...', data: {...} }
//   GET  /sync?user=...&token=... Fetch the user's sync blob.
//   GET  /                       Health check.

const SITE = 'https://karimdaman.github.io/KEMLLM/';
const TOKEN_TTL = 60 * 60 * 24 * 365; // 1 year

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Accept',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyToken(env, user, token) {
  if (!user || !token) return false;
  const stored = await env.SYNC.get('token:' + user);
  return stored === token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ===== GitHub OAuth =====
    if (url.pathname === '/github/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400, headers: CORS });
      if (!env.GITHUB_CLIENT_SECRET) {
        return Response.redirect(SITE + '?gh_error=worker_missing_secret', 302);
      }
      try {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID || 'Ov23li20jlCBobnJjusT',
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
          }),
        });
        const data = await tokenRes.json();
        if (!data.access_token) {
          return Response.redirect(SITE + '?gh_error=' + encodeURIComponent(data.error || 'auth_failed'), 302);
        }
        const userRes = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': 'Bearer ' + data.access_token,
            'User-Agent': 'KEMLLM',
            'Accept': 'application/vnd.github+json',
          },
        });
        if (!userRes.ok) {
          return Response.redirect(SITE + '?gh_error=user_fetch_failed', 302);
        }
        const user = await userRes.json();
        // Mint a sync token, store it in KV keyed by github login
        const login = user.login || '';
        let syncToken = '';
        if (login && env.SYNC) {
          syncToken = randomToken();
          await env.SYNC.put('token:' + login, syncToken, { expirationTtl: TOKEN_TTL });
        }
        return Response.redirect(
          SITE +
            '?gh_user=' + encodeURIComponent(login) +
            '&gh_name=' + encodeURIComponent(user.name || login) +
            '&gh_avatar=' + encodeURIComponent(user.avatar_url || '') +
            '&sync_token=' + encodeURIComponent(syncToken),
          302
        );
      } catch (e) {
        return Response.redirect(SITE + '?gh_error=' + encodeURIComponent(String(e)), 302);
      }
    }

    // ===== Sync: read =====
    if (url.pathname === '/sync' && request.method === 'GET') {
      const user = url.searchParams.get('user') || '';
      const token = url.searchParams.get('token') || '';
      if (!env.SYNC) return json({ error: 'KV not bound' }, 500);
      if (!(await verifyToken(env, user, token))) return json({ error: 'unauthorized' }, 401);
      const raw = await env.SYNC.get('data:' + user);
      return json({ ok: true, data: raw ? JSON.parse(raw) : null });
    }

    // ===== Sync: write =====
    if (url.pathname === '/sync' && request.method === 'POST') {
      if (!env.SYNC) return json({ error: 'KV not bound' }, 500);
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'bad json' }, 400); }
      const { user, token, data } = body || {};
      if (!(await verifyToken(env, user, token))) return json({ error: 'unauthorized' }, 401);
      if (data == null) return json({ error: 'missing data' }, 400);
      const serialized = JSON.stringify(data);
      // KV value limit is 25 MB; refuse anything wildly bigger than expected
      if (serialized.length > 5 * 1024 * 1024) {
        return json({ error: 'data too large (>5 MB)' }, 413);
      }
      await env.SYNC.put('data:' + user, serialized);
      return json({ ok: true, bytes: serialized.length });
    }

    // ===== Sync: delete (sign out cleanup) =====
    if (url.pathname === '/sync' && request.method === 'DELETE') {
      if (!env.SYNC) return json({ error: 'KV not bound' }, 500);
      const user = url.searchParams.get('user') || '';
      const token = url.searchParams.get('token') || '';
      if (!(await verifyToken(env, user, token))) return json({ error: 'unauthorized' }, 401);
      await env.SYNC.delete('data:' + user);
      await env.SYNC.delete('token:' + user);
      return json({ ok: true });
    }

    // ===== Replicate proxy =====
    // Forwards /replicate/* → https://api.replicate.com/*
    // (same behavior as the legacy kemllmx worker). The client passes its
    // own Authorization: Bearer r8_... header; we just relay it.
    if (url.pathname.startsWith('/replicate/')) {
      const target = 'https://api.replicate.com/' + url.pathname.slice('/replicate/'.length) + url.search;
      const fwdHeaders = new Headers();
      const auth = request.headers.get('Authorization');
      if (auth) fwdHeaders.set('Authorization', auth);
      const ct = request.headers.get('Content-Type');
      if (ct) fwdHeaders.set('Content-Type', ct);
      const pref = request.headers.get('Prefer');
      if (pref) fwdHeaders.set('Prefer', pref);
      fwdHeaders.set('User-Agent', 'KEMLLM-worker');
      let body;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        body = await request.arrayBuffer();
      }
      const upstream = await fetch(target, { method: request.method, headers: fwdHeaders, body });
      const respHeaders = new Headers(upstream.headers);
      for (const [k, v] of Object.entries(CORS)) respHeaders.set(k, v);
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }

    // ===== Health =====
    return json({
      service: 'kemllm-backend',
      ok: true,
      sync: !!env.SYNC,
      auth: !!env.GITHUB_CLIENT_SECRET,
    });
  },
};
