// Cloudflare Pages Function — Haven 登录 API（通行码 + Supabase Token）
export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;
  const HAVEN_PASSCODE = env.HAVEN_PASSCODE || '0616';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    return handleLogin(body, HAVEN_PASSCODE);
  }
  if (request.method === 'GET') return handleMe(request, SUPABASE_URL, SUPABASE_KEY, HAVEN_PASSCODE);
  return json({ error: 'Method not allowed' }, 405);
}

// POST /api/auth — 验证通行码，返回 token
async function handleLogin(body, passcode) {
  try {
    if (!body.passcode) return json({ error: '请输入通行码' }, 400);
    if (body.passcode !== passcode) return json({ error: '通行码错误' }, 403);

    const token = await signToken(passcode, {
      sub: 'haven-user',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    });
    return json({ access_token: token });
  } catch (e) {
    console.error('Login error:', e.message);
    return json({ error: e.message }, 500);
  }
}

// GET /api/auth — 验证 token
async function handleMe(request, supabaseUrl, supabaseKey, passcode) {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: '未登录' }, 401);

  // 先试 Supabase token
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      return json({ userId: data.id || 'supabase-user' });
    }
  } catch {}

  // 再试自签名 token
  const userId = await verifyToken(passcode, token);
  if (userId) return json({ userId });

  return json({ error: '未登录' }, 401);
}

async function signToken(secret, payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encoder = new TextEncoder();
  const data = btoa(JSON.stringify(header)) + '.' + btoa(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return data + '.' + sigStr;
}

async function verifyToken(secret, token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub || null;
  } catch {
    return null;
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
