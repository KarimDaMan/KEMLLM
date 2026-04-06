// Cloudflare Worker for KEMLLM — static assets + GitHub OAuth exchange
//
// REQUIRED SECRETS (set in Cloudflare dashboard → Settings → Variables):
//   GITHUB_CLIENT_ID     = Ov23li20jlCBobnJjusT
//   GITHUB_CLIENT_SECRET = <your rotated secret — NEVER commit this>
//
// This worker handles:
//   POST /api/github-exchange   → exchanges OAuth code for access_token + user info
//   Everything else             → served as static assets from the repo

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // GitHub OAuth code exchange
    if (url.pathname === '/api/github-exchange' && request.method === 'POST') {
      try {
        const { code } = await request.json();
        if (!code) {
          return json({ error: 'Missing code' }, 400);
        }
        if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
          return json({ error: 'Worker missing GITHUB_CLIENT_ID/SECRET env vars' }, 500);
        }

        // Exchange code for access token
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: 'https://kemllmx.karimghannam2014.workers.dev/'
          })
        });
        const tokenData = await tokenRes.json();
        if (tokenData.error || !tokenData.access_token) {
          return json({ error: tokenData.error_description || 'Token exchange failed' }, 400);
        }

        // Fetch user info
        const userRes = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': 'Bearer ' + tokenData.access_token,
            'User-Agent': 'KEMLLM',
            'Accept': 'application/vnd.github+json'
          }
        });
        if (!userRes.ok) {
          return json({ error: 'Failed to fetch GitHub user' }, 400);
        }
        const user = await userRes.json();

        return json({
          login: user.login,
          name: user.name,
          email: user.email,
          avatar_url: user.avatar_url,
          access_token: tokenData.access_token
        });
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    // Fall through to static assets (index.html, css/, js/)
    return env.ASSETS.fetch(request);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
