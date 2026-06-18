// Netlify Function — Haven 历史消息加载（含身份验证）

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // 验证用户身份
  const userId = await verifyUser(req);

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    return json({ error: 'sessionId 不能为空' }, 400);
  }

  // 加载消息（如果已登录则验证所有权，未登录则兼容旧数据）
  let query = `${SUPABASE_URL}/rest/v1/messages?select=role,content,created_at&session_id=eq.${sessionId}&visible=eq.true&order=created_at.asc`;

  // 如果用户已登录，额外验证 session 所有权
  if (userId) {
    const sessionCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions?select=id&id=eq.${sessionId}&user_id=eq.${userId}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    const checkData = await sessionCheck.json();
    if (!checkData || checkData.length === 0) {
      return json({ error: '会话不存在或无权访问' }, 403);
    }
  }

  const res = await fetch(query, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });

  if (!res.ok) {
    return json({ error: '加载失败' }, 500);
  }

  const messages = await res.json();
  return json({ messages });
}

async function verifyUser(req) {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  // 先试 Supabase token
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      return data.id || 'supabase-user';
    }
  } catch {}

  // 再试自签名 token
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1]));
      if (payload.sub && payload.exp && payload.exp > Math.floor(Date.now() / 1000)) {
        return payload.sub;
      }
    }
  } catch {}

  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
