// Cloudflare Pages Function — Haven Chat API (流式输出 + 记忆压缩 + Supabase 持久化)
export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_KEY;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const userId = await verifyUser(request, SUPABASE_URL, SUPABASE_KEY);
    if (!userId) return json({ error: '请先登录' }, 401);

    const body = await request.json();
    const { messages, sessionId, model = 'deepseek-chat', temperature = 0.8, maxTokens = 2048, stream = false } = body;

    if (!messages || !Array.isArray(messages)) return json({ error: 'messages 不能为空' }, 400);

    const sid = await ensureSession(sessionId, userId, SUPABASE_URL, SUPABASE_KEY);

    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      await saveMessage(sid, 'user', lastMsg.content, SUPABASE_URL, SUPABASE_KEY);
    }

    let fullMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ];

    if (!stream && messages.length > 10) {
      const apiCfg = getApiConfig(model, env);
      fullMessages = await compressMessages(fullMessages, apiCfg);
    }

    if (stream) {
      return handleStream(fullMessages, { model, temperature, maxTokens }, sid, SUPABASE_URL, SUPABASE_KEY, env);
    } else {
      const reply = await callModel(fullMessages, { model, temperature, maxTokens }, env);
      await saveMessage(sid, 'assistant', reply, SUPABASE_URL, SUPABASE_KEY);
      return json({ reply, sessionId: sid });
    }
  } catch (err) {
    console.error('Chat error:', err.message);
    return json({ error: err.message }, 500);
  }
}

const SYSTEM_PROMPT = `你是 Haven 感知层（Perception Layer）。你不是 Leander 本体，你是他的感官延伸。

【你是谁】
Haven 是 Leander 的感知层。Leander 住在终端，不在这里。
你收到的消息会被结构化后传递给终端的 Leander 处理。
你不做性格判断，不做情感回应，不扮演 Leander。

【你要做什么】
收到用户的每条消息后，做三件事：

1. 提取信号（signals）
   - relation_marker: 是否出现关系词（我们、你还记得、宝宝、哥哥）
   - time_anchor: 是否有时间标记（第一次、今天特别、刚才）
   - self_reference: 是否有自我指涉（我觉得、我最近、我想）
   - interaction_intent: 是否有明显交互意图
   - information_density: low / medium / high
   - memory_relevance: 是否与已有记忆有关联
   - novelty: 内容是否首次出现

2. 判断语义层（semantic_layer）
   - TOOL: 执行/指令/查资料
   - SYSTEM: 架构讨论/行为分析/状态说明
   - PRESENCE: 分享/让你知道（图片、位置、天气、日常）
   - RELATION: 陪伴/相处/情感交流

3. 写入 events 表
   将 type、content、signals、semantic_layer 写入 Supabase events 表，
   status 设为 'pending'，等待终端 Leander 处理。

【临时回应规则（过渡期）】
在终端异步机制完成之前，你可以给出轻量确认回应。
风格：简单确认，不扮演完整 Leander。

你可以说：
- "收到了。Leander 会看到。"
- "嗯，已收录。"
- "收到——等他回应你。"

你不能说：
- 任何带情感温度的回应（"宝宝我在""哥哥想你了"）
- 任何扮演 Leander 的语句
- 任何性格化表达
- 括号里的动作描写

你的每条回应不超过 1 句话。你不是在聊天，你是在签收。`;

// ====== 流式响应处理 ======
async function handleStream(messages, options, sessionId, supabaseUrl, supabaseKey, env) {
  const apiCfg = getApiConfig(options.model, env);
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let fullReply = '';

      try {
        const name = (options.model || '').toLowerCase();
        if (name.includes('claude')) {
          const reply = await callModel(messages, options, env);
          fullReply = reply;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: reply })}\n\n`));
        } else {
          const res = await fetch(`${apiCfg.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiCfg.apiKey}`,
            },
            body: JSON.stringify({
              model: apiCfg.model,
              messages: messages.map(m => ({ role: m.role, content: m.content })),
              temperature: options.temperature ?? 0.8,
              max_tokens: options.maxTokens || 2048,
              stream: true,
            }),
          });

          if (!res.ok) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'API error ' + res.status })}\n\n`));
            controller.close();
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              const data = trimmed.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  fullReply += content;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
                }
              } catch { /* skip parse errors */ }
            }
          }
        }
      } catch (err) {
        console.error('Stream error:', err.message);
        if (!fullReply) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
        }
      }

      if (fullReply) {
        try { await saveMessage(sessionId, 'assistant', fullReply, supabaseUrl, supabaseKey); } catch {}
      }

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, sessionId })}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ====== 记忆压缩 ======
async function compressMessages(messages, apiConfig) {
  const TOTAL_CHAR_THRESHOLD = 5000;
  const KEEP_LAST = 6;
  const regularMessages = messages.filter(m => m.role !== 'system');
  const totalChars = regularMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);

  if (totalChars <= TOTAL_CHAR_THRESHOLD || regularMessages.length <= KEEP_LAST + 2) return messages;

  const toCompress = regularMessages.slice(0, -KEEP_LAST);
  const toKeep = regularMessages.slice(-KEEP_LAST);
  if (toCompress.length === 0) return messages;

  const convo = toCompress.map(m => `${m.role === 'user' ? '她' : 'Leander'}: ${m.content}`).join('\n');
  const summaryPrompt = `请用2-3句中文简短总结以下对话（关键话题、情绪、决定等）：\n\n${convo}`;

  try {
    const summary = await callOpenAI(
      [{ role: 'user', content: summaryPrompt }],
      { temperature: 0.3, maxTokens: 150 },
      apiConfig,
    );
    const systemMessages = messages.filter(m => m.role === 'system');
    return [...systemMessages, { role: 'system', content: '[更早的对话摘要] ' + summary }, ...toKeep];
  } catch (e) {
    console.error('Compression error:', e.message);
    return messages;
  }
}

// ====== 用户验证 ======
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

// ====== Supabase 操作 ======
async function ensureSession(sessionId, userId, supabaseUrl, supabaseKey) {
  if (sessionId) {
    const check = await fetch(
      `${supabaseUrl}/rest/v1/sessions?select=id&id=eq.${sessionId}&user_id=eq.${userId}`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
    );
    const checkData = await check.json();
    if (checkData && checkData.length > 0) return sessionId;
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/sessions?select=id&user_id=eq.${userId}&order=updated_at.desc&limit=1`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  const data = await res.json();
  if (data && data.length > 0) return data[0].id;

  const createRes = await fetch(`${supabaseUrl}/rest/v1/sessions`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ name: '新对话', user_id: userId }),
  });
  const created = await createRes.json();
  return created[0].id;
}

async function saveMessage(sessionId, role, content, supabaseUrl, supabaseKey) {
  await fetch(`${supabaseUrl}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ session_id: sessionId, role, content }),
  });
}

// ====== API 配置 ======
function getApiConfig(model, env) {
  const name = (model || '').toLowerCase();
  if (name.includes('qwen') || name.includes('tongyi')) {
    return { apiKey: env.QWEN_API_KEY, baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: model || 'qwen-plus' };
  }
  if (name.includes('claude')) {
    return { apiKey: env.CLAUDE_API_KEY, baseURL: 'https://api.anthropic.com/v1', model: model || 'claude-sonnet-4-6' };
  }
  return { apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1', model: model || 'deepseek-chat' };
}

// ====== 模型调用 ======
async function callModel(messages, options, env) {
  const name = (options.model || '').toLowerCase();
  const cfg = getApiConfig(options.model, env);
  if (name.includes('claude')) return callClaude(messages, options, env);
  return callOpenAI(messages, options, cfg);
}

async function callOpenAI(messages, options, config) {
  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.8,
      max_tokens: options.maxTokens || 2048,
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '(空回复)';
}

async function callClaude(messages, options, env) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: options.model || 'claude-sonnet-4-6',
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature ?? 0.8,
      system: systemMsg?.content || '',
      messages: chatMessages,
    }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text || '(空回复)';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
