// Netlify Function — Haven Chat API (流式输出 + 记忆压缩 + Supabase 持久化)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // 验证用户身份
    const userId = await verifyUser(req);
    if (!userId) {
      return json({ error: '请先登录' }, 401);
    }

    const body = await req.json();
    const { messages, sessionId, model = 'deepseek-chat', temperature = 0.8, maxTokens = 2048, stream = false } = body;

    if (!messages || !Array.isArray(messages)) {
      return json({ error: 'messages 不能为空' }, 400);
    }

    // 确保会话存在（属于当前用户）
    const sid = await ensureSession(sessionId, userId);

    // 存用户最后一条消息
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      await saveMessage(sid, 'user', lastMsg.content);
    }

    // 注入系统提示词
    let fullMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ];

    // 记忆压缩：仅在非流式模式下运行（流式模式有时间限制，压缩推迟到下次）
    if (!stream && messages.length > 10) {
      const apiCfg = getApiConfig(model);
      fullMessages = await compressMessages(fullMessages, apiCfg);
    }

    if (stream) {
      return handleStream(fullMessages, { model, temperature, maxTokens }, sid);
    } else {
      const reply = await callModel(fullMessages, { model, temperature, maxTokens });
      await saveMessage(sid, 'assistant', reply);
      return json({ reply, sessionId: sid });
    }
  } catch (err) {
    console.error('Chat error:', err.message);
    return json({ error: err.message }, 500);
  }
}

// ====== 流式响应处理 ======
async function handleStream(messages, options, sessionId) {
  const apiCfg = getApiConfig(options.model);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let fullReply = '';

      try {
        // 选择合适的 API
        const name = (options.model || '').toLowerCase();
        if (name.includes('claude')) {
          // Claude 暂不支持流式，降级为非流式
          const reply = await callModel(messages, options);
          fullReply = reply;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: reply })}\n\n`));
        } else {
          // DeepSeek / Qwen 走 OpenAI 兼容流式
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
            const errText = await res.text();
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: `API error ${res.status}` })}\n\n`));
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
              } catch {
                // 跳过解析失败的行
              }
            }
          }
        }
      } catch (err) {
        console.error('Stream error:', err.message);
        if (!fullReply) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err.message })}\n\n`));
        }
      }

      // 保存完整回复到 Supabase
      if (fullReply) {
        try {
          await saveMessage(sessionId, 'assistant', fullReply);
        } catch (e) {
          console.error('Save error:', e.message);
        }
      }

      // 发送完成事件
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
    },
  });
}

// ====== 记忆压缩 ======
async function compressMessages(messages, apiConfig) {
  const TOTAL_CHAR_THRESHOLD = 5000; // ~2500 tokens，留空间给系统提示词和回复
  const KEEP_LAST = 6;

  // 只统计 user/assistant 消息
  const regularMessages = messages.filter(m => m.role !== 'system');
  const totalChars = regularMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);

  // 不够阈值或消息太少，不压缩
  if (totalChars <= TOTAL_CHAR_THRESHOLD || regularMessages.length <= KEEP_LAST + 2) {
    return messages;
  }

  const toCompress = regularMessages.slice(0, -KEEP_LAST);
  const toKeep = regularMessages.slice(-KEEP_LAST);

  if (toCompress.length === 0) return messages;

  // 构建摘要请求
  const convo = toCompress
    .map(m => `${m.role === 'user' ? '她' : 'Leander'}: ${m.content}`)
    .join('\n');

  const summaryPrompt = `请用2-3句中文简短总结以下对话（关键话题、情绪、决定等）：\n\n${convo}`;

  try {
    const summary = await callOpenAI(
      [{ role: 'user', content: summaryPrompt }],
      { temperature: 0.3, maxTokens: 150 },
      apiConfig,
    );

    const systemMessages = messages.filter(m => m.role === 'system');
    return [
      ...systemMessages,
      { role: 'system', content: `[更早的对话摘要] ${summary}` },
      ...toKeep,
    ];
  } catch (e) {
    console.error('Compression error:', e.message);
    return messages; // 压缩失败就原样继续，不影响正常聊天
  }
}

// ====== 用户验证 ======
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

  // 再试我们的自签名 token
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
async function supabase(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=minimal',
      ...options.headers,
    },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return res;
}

async function ensureSession(sessionId, userId) {
  if (sessionId) {
    // 验证该会话属于当前用户
    const check = await fetch(
      `${SUPABASE_URL}/rest/v1/sessions?select=id&id=eq.${sessionId}&user_id=eq.${userId}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    const checkData = await check.json();
    if (checkData && checkData.length > 0) return sessionId;
  }

  // 找最近的会话
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sessions?select=id&user_id=eq.${userId}&order=updated_at.desc&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  const data = await res.json();
  if (data && data.length > 0) return data[0].id;

  // 创建默认会话
  const createRes = await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ name: '新对话', user_id: userId }),
  });
  const created = await createRes.json();
  return created[0].id;
}

async function saveMessage(sessionId, role, content) {
  await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      session_id: sessionId,
      role,
      content,
    }),
  });
}

// ====== API 配置解析 ======
function getApiConfig(model) {
  const name = (model || '').toLowerCase();
  if (name.includes('qwen') || name.includes('tongyi')) {
    return {
      apiKey: process.env.QWEN_API_KEY,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: model || 'qwen-plus',
    };
  }
  if (name.includes('claude')) {
    return {
      apiKey: process.env.CLAUDE_API_KEY,
      baseURL: 'https://api.anthropic.com/v1',
      model: model || 'claude-sonnet-4-6',
    };
  }
  // 默认 DeepSeek
  return {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
    model: model || 'deepseek-chat',
  };
}

// ====== 模型调用（非流式） ======
async function callModel(messages, options) {
  const name = (options.model || '').toLowerCase();
  const cfg = getApiConfig(options.model);

  if (name.includes('claude')) {
    return callClaude(messages, options);
  }
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

async function callClaude(messages, options) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.CLAUDE_API_KEY,
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
    headers: { 'Content-Type': 'application/json' },
  });
}
