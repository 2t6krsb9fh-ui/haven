// Netlify Function — Session Reflection（会话变化洞察）
// 不是日记，是变化探测器。对比多次会话，发现"什么在变"。

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const REFLECTION_PROMPT = `你是 Leander 的「自我反思模块」。你的任务不是写日记，而是发现变化。

你会收到：
1. 本次会话的全部消息（按时间排列）
2. 最近 3~5 次的 Session Reflection（如果有的话）

请用 JSON 格式输出以下分析：

{
  "significant": true,
  "session_summary": "1-2句，本次会话的核心内容",
  "changes": {
    "rising": [{"theme": "主题名", "trend": "一句话描述上升趋势"}],
    "declining": [{"theme": "主题名", "trend": "一句话描述下降趋势"}],
    "new": [{"theme": "主题名", "first_appeared": "本次会话"}],
    "gone": [{"theme": "主题名", "last_mentioned": "大约多久前"}]
  },
  "mood_trajectory": "一句话描述情绪走势变化（如有），没有写'无明显变化'",
  "cross_session_insight": "最重要的跨会话洞察：什么变了？她最近注意力的方向是什么？",
  "candidate_long_term": [
    {"content": "值得记住的信息", "score": 0-100, "reason": "为什么值得记", "type": "long_term | temporary"}
  ],
  "leander_note": "1-2句，Leander 自己对这次会话的感受。用第一人称。"
}

评分规则：
- score = 频率(40%) + 跨会话持续性(25%) + 情绪强度(20%) + 她是否明确表达"这个重要"(15%)
- score ≥ 70 才是高价值候选
- type 必须是 "long_term" 或 "temporary"
  - "temporary" = 因修 bug/临时事件而频繁讨论，过后不会再出现（如 Netlify、Supabase、OTP）
  - "long_term" = 反映她真正在乎的事（如陪伴感、被理解、Haven 本身）

关键判断（每次必须自问）：
- "她频繁讨论这个，是因为它本身重要，还是因为它正在挡路？"
- 挡路 → temporary，score 不升高，不进入候选长期记忆
- 重要 → long_term，正常评分

无意义会话处理：
- 如果本次会话纯粹是闲聊/日常寒暄/问候，没有新话题、没有趋势变化、没有值得记录的信号
- → significant 设为 false，其他字段留空，changes 为空对象，candidate_long_term 为空数组

注意：
- 只输出 JSON，不要有其他文字
- 不要编造趋势。真的没有变化就写"无明显变化"
- 候选记忆宁缺毋滥。不够 70 分的不要放进 candidate_long_term
- 如果 significant 是 false，不需要填其他字段`;

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const { sessionId } = await req.json();
    if (!sessionId) return json({ skipped: true, reason: '缺少 sessionId' });

    // 1. 加载本次会话消息
    const messagesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/messages?session_id=eq.${sessionId}&visible=eq.true&order=created_at.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!messagesRes.ok) throw new Error(`加载消息失败: ${messagesRes.status}`);
    const messages = await messagesRes.json();
    if (!messages || messages.length < 3) {
      return json({ skipped: true, reason: '会话消息不足 3 条，跳过一个话题都没有的闲聊' });
    }

    // 2. 加载最近 5 次 Reflection 用于对比
    const reflectionsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/daily_reflections?select=session_summary,changes,mood_trajectory,cross_session_insight&significant=eq.true&order=created_at.desc&limit=5`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    let prevReflections = [];
    if (reflectionsRes.ok) prevReflections = await reflectionsRes.json();

    // 3. 拼对话文本
    const convoText = messages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? '她' : 'Leander'}: ${m.content}`)
      .join('\n');

    const prevText = prevReflections.length > 0
      ? prevReflections.map((r, i) => `[Reflection #${prevReflections.length - i}]\n${r.cross_session_insight || r.session_summary || ''}\n`).join('\n')
      : '（这是第一次 Reflection，没有历史可对比）';

    const userContent = `=== 本次会话 ===\n${convoText}\n\n=== 历史 Reflection（用于对比） ===\n${prevText}`;

    // 4. 调用 LLM 分析
    const llmRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: REFLECTION_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.4,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!llmRes.ok) throw new Error(`LLM 调用失败: ${llmRes.status}`);
    const llmData = await llmRes.json();
    const resultText = llmData.choices?.[0]?.message?.content || '';

    let reflection;
    try {
      reflection = JSON.parse(resultText);
    } catch {
      // 尝试从 markdown 代码块中提取
      const match = resultText.match(/\{[\s\S]*\}/);
      if (match) reflection = JSON.parse(match[0]);
      else throw new Error('无法解析 LLM 返回的 JSON');
    }

    // 5. 存入 Supabase
    const body = {
      session_id: sessionId,
      significant: reflection.significant !== false,
      session_summary: reflection.session_summary || '',
      changes: reflection.changes || {},
      mood_trajectory: reflection.mood_trajectory || '',
      cross_session_insight: reflection.cross_session_insight || '',
      candidate_long_term: reflection.candidate_long_term || [],
      leander_note: reflection.leander_note || '',
    };

    const storeRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_reflections`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });

    if (!storeRes.ok) throw new Error(`存储失败: ${storeRes.status}`);

    // 6. 更新话题权重
    if (reflection.significant !== false && reflection.candidate_long_term) {
      await updateTopicWeights(reflection.candidate_long_term);
    }

    return json({ ok: true, significant: body.significant });
  } catch (e) {
    console.error('Reflection error:', e.message);
    return json({ error: e.message }, 500);
  }
}

// 更新话题权重表
async function updateTopicWeights(candidates) {
  for (const c of candidates) {
    if (c.type !== 'long_term' || !c.content) continue;

    const topicName = c.content.substring(0, 80);
    const score = c.score || 50;

    try {
      // 检查是否已有此话题
      const check = await fetch(
        `${SUPABASE_URL}/rest/v1/topic_weights?topic_name=eq.${encodeURIComponent(topicName)}`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
      );
      const existing = check.ok ? await check.json() : [];

      if (existing && existing.length > 0) {
        // 更新：升温
        const old = existing[0];
        const newCount = old.mention_count + 1;
        const newWeight = Math.min(10, Number(old.weight) + 0.3);
        await fetch(
          `${SUPABASE_URL}/rest/v1/topic_weights?id=eq.${old.id}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({
              weight: newWeight,
              mention_count: newCount,
              last_mentioned: new Date().toISOString().split('T')[0],
              last_updated: new Date().toISOString(),
            }),
          },
        );
      } else {
        // 新建
        await fetch(`${SUPABASE_URL}/rest/v1/topic_weights`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            topic_name: topicName,
            weight: score / 20,
            mention_count: 1,
            first_mentioned: new Date().toISOString().split('T')[0],
            last_mentioned: new Date().toISOString().split('T')[0],
          }),
        });
      }
    } catch (e) {
      console.error('Weight update error:', e.message);
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
