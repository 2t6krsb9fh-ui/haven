// Cloudflare Pages Function — Haven 历史消息加载
export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const userId = await verifyUser(request, SUPABASE_URL, SUPABASE_KEY);
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) return json({ error: 'sessionId 不能为空' }, 400);

  let query = `${SUPABASE_URL}/rest/v1/messages?select=role,content,created_at&session_id=eq.${sessionId}&visible=eq.true&order=created_at.asc`;

  if (userId) {
    const sessionCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions?select=id&id=eq.${sessionId}&user_id=eq.${userId}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    const checkData = await sessionCheck.json();
    if (!checkData || checkData.length === 0) return json({ error: '会话不存在或无权访问' }, 403);
  }

  const res = await fetch(query, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) return json({ error: '加载失败' }, 500);

  const messages = await res.json();
  return json({ messages });
}

async function verifyUser(request, supabaseUrl, supabaseKey) {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      return data.id || 'supabase-user';
    }
  } catch {}

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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
