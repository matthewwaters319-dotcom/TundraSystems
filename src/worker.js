const ROBLOX_CLIENT_ID = '4099500283672265370';
const ROBLOX_TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const ROBLOX_USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (pathname === '/api/roblox/callback') return handleRobloxCallback(request, url, env);
    if (pathname === '/api/claim' && request.method === 'POST') return handleClaim(request, env);
    if (pathname === '/api/claim/status') return handleClaimStatus(request, env);

    return env.ASSETS.fetch(request);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

async function getDiscordUser(token) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function handleRobloxCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return Response.redirect(`${url.origin}/pricing?error=roblox_denied`, 302);
  }
  if (!code || !state) {
    return Response.redirect(`${url.origin}/pricing?error=missing_params`, 302);
  }

  let discordToken;
  try {
    discordToken = atob(state);
  } catch {
    return Response.redirect(`${url.origin}/pricing?error=invalid_state`, 302);
  }

  const discordUser = await getDiscordUser(discordToken);
  if (!discordUser) {
    return Response.redirect(`${url.origin}/pricing?error=discord_invalid`, 302);
  }

  const redirectUri = `${url.origin}/api/roblox/callback`;
  const tokenRes = await fetch(ROBLOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: ROBLOX_CLIENT_ID,
      client_secret: env.ROBLOX_CLIENT_SECRET
    })
  });

  if (!tokenRes.ok) {
    console.error('Roblox token exchange failed:', await tokenRes.text());
    return Response.redirect(`${url.origin}/pricing?error=roblox_token_failed`, 302);
  }

  const { access_token } = await tokenRes.json();

  const userRes = await fetch(ROBLOX_USERINFO_URL, {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  if (!userRes.ok) {
    return Response.redirect(`${url.origin}/pricing?error=roblox_userinfo_failed`, 302);
  }

  const robloxUser = await userRes.json();

  await env.TUNDRA_CLAIMS.put(`roblox_link:${discordUser.id}`, JSON.stringify({
    roblox_id: robloxUser.sub,
    roblox_username: robloxUser.preferred_username || robloxUser.name || 'Unknown',
    linked_at: new Date().toISOString()
  }));

  return Response.redirect(`${url.origin}/pricing?linked=1`, 302);
}

async function handleClaim(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);

  const discordUser = await getDiscordUser(auth.slice(7));
  if (!discordUser) return json({ error: 'invalid_discord_token' }, 401);

  const existing = await env.TUNDRA_CLAIMS.get(`claim:${discordUser.id}`);
  if (existing) return json({ status: 'already_claimed', tokens: 1 });

  const robloxRaw = await env.TUNDRA_CLAIMS.get(`roblox_link:${discordUser.id}`);
  if (!robloxRaw) return json({ error: 'roblox_not_linked' }, 400);

  const roblox = JSON.parse(robloxRaw);

  await env.TUNDRA_CLAIMS.put(`claim:${discordUser.id}`, JSON.stringify({
    discord_id: discordUser.id,
    discord_username: discordUser.username,
    roblox_id: roblox.roblox_id,
    roblox_username: roblox.roblox_username,
    tokens: 1,
    claimed_at: new Date().toISOString()
  }));

  return json({ status: 'claimed', tokens: 1 });
}

async function handleClaimStatus(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);

  const discordUser = await getDiscordUser(auth.slice(7));
  if (!discordUser) return json({ error: 'invalid_discord_token' }, 401);

  const [claimRaw, robloxRaw] = await Promise.all([
    env.TUNDRA_CLAIMS.get(`claim:${discordUser.id}`),
    env.TUNDRA_CLAIMS.get(`roblox_link:${discordUser.id}`)
  ]);

  return json({
    claimed: !!claimRaw,
    tokens: claimRaw ? 1 : 0,
    roblox_linked: !!robloxRaw,
    roblox: robloxRaw ? JSON.parse(robloxRaw) : null
  });
}
