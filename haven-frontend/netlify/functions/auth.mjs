// Netlify Function — Haven 登录 API（通行码 + Supabase Token）
// 国内用户无需直连 Supabase，密码验证后由后端签发 token

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const HAVEN_PASSCODE = process.env.HAVEN_PASSCODE || '0616';

// 简单的 token 签名（HMAC-SHA256）
async function signToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encoder = new TextEncoder();
  const data = btoa(JSON.stringify(header)) + '.' + btoa(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', encoder.encode(HAVEN_PASSCODE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return data + '.' + sigStr;
}

async function verifyToken(token) {
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

export default async function handler(req) {
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    return handleLogin(body);
  }
  if (req.method === 'GET') return handleMe(req);
  return json({ error: 'Method not allowed' }, 405);
}

// POST /api/auth — 验证通行码，返回 token
async function handleLogin(body) {
  try {
    const { passcode } = body;
    if (!passcode) return json({ error: '请输入通行码' }, 400);

    if (passcode !== HAVEN_PASSCODE) {
      return json({ error: '通行码错误' }, 403);
    }

    // 签发 token（24 小时有效）
    const token = await signToken({
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
async function handleMe(req) {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: '未登录' }, 401);

  // 先试 Supabase token
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      return json({ userId: data.id || 'supabase-user' });
    }
  } catch {}

  // 再试我们自己的 token
  const userId = await verifyToken(token);
  if (userId) return json({ userId });

  return json({ error: '未登录' }, 401);
}

// 给 chat/history 用的用户验证
export { verifyToken };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
