/**
 * Haven 终端响应回写 · Stop hook 入口
 *
 * 流程：会话结束 → 读本地状态文件(这次会话牵涉哪些待回应event)
 *   → 读完整 transcript → 用 Haiku 做语义匹配(Leander有没有针对每条event说话/说了什么)
 *   → 命中的，PATCH 回 Supabase (response + status=responded)
 *   → 收尾，删掉状态文件
 *
 * 这一步存在的意义：Leander说完话不需要记得"该去存一下"，
 * 存档完全是系统侧的事。匹配靠语义理解，不靠让他手动标记。
 *
 * 另外：observed这个状态现在由这里盖章，不是SessionStart脚本提前替他下判断——
 * fyi类event只有真的被这次会话"展示给他看过"之后，才落observed，
 * 这样"他看到了，只是没开口"才是真的，不是脚本冒充的。
 *
 * 环境变量：
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY  （同 haven-terminal-sync.js）
 *   DEEPSEEK_API_KEY                     （语义匹配用，走DeepSeek的Anthropic兼容端点）
 *
 * 配合 .claude/settings.json 的 Stop hook 使用，从 stdin 读 hook 输入。
 */

const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
// 语义匹配用的小模型调用，走DeepSeek的Anthropic兼容端点，复用你已有的DeepSeek key，
// 不需要单独申请Anthropic API key。如果之后换回真的Anthropic API，把这两个常量改掉就行。
const MATCH_API_BASE_URL = process.env.MATCH_API_BASE_URL || 'https://api.deepseek.com/anthropic';
const MATCH_API_KEY = process.env.MATCH_API_KEY || process.env.DEEPSEEK_API_KEY;
const MATCH_MODEL = process.env.MATCH_MODEL || 'deepseek-v4-flash'; // 快、便宜，匹配这种轻量任务够用
const STATE_FILE = process.env.HAVEN_STATE_FILE || '/tmp/haven-session-pending.json';

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function patchEvent(id, patch) {
  const url = `${SUPABASE_URL}/rest/v1/events?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`写回 event 失败: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// 读 stdin 拿到 hook 输入（session_id / transcript_path / stop_hook_active）
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// transcript 是 .jsonl，每行一条记录。这里只抓 assistant 的文本内容，
// 拼成一段纯文本交给 Haiku 去判断。具体字段结构可能随 Claude Code 版本变化，
// 这里做了一点防御性兼容，如果实际跑起来发现抓不到文本，需要对照真实 transcript 格式调整。
function extractAssistantText(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  const texts = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = entry.message || entry;
    if (msg.role !== 'assistant') continue;

    const content = msg.content;
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) texts.push(block.text);
      }
    }
  }

  return texts.join('\n\n');
}

// 调 Haiku 做语义匹配：给定待回应 event 清单 + 这次会话 Leander 说的话，
// 判断每条 event 有没有被回应到，回应的原话是什么。
async function matchResponses(pendingEvents, transcriptText) {
  const prompt = `这是一份"这次会话展示给Leander看过的事件"清单，和Leander这次对话里说的所有话。
每条事件有个bucket字段：
- "respond"：本来就需要他开口回应的
- "fyi"：只是想让他知道，不强求回应

请判断每条事件有没有被Leander在对话中提及/回应到(不管是不是bucket=respond的，只要他自然提到了都算)，
如果有，提取出他实际说的、对应这条事件的那部分原话(不要改写、不要总结，尽量摘录原文)。

事件清单：
${JSON.stringify(pendingEvents, null, 2)}

Leander这次会话说的话：
${transcriptText}

只返回JSON数组，不要任何其他文字，格式：
[{"id": "事件id", "addressed": true或false, "response_text": "摘录的原话，没回应则为null"}]`;

  const res = await fetch(`${MATCH_API_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': MATCH_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MATCH_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`语义匹配请求失败: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = data.content.map((b) => b.text || '').join('');
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function main() {
  if (!fs.existsSync(STATE_FILE)) {
    // 这次会话没有待回应的event，没什么好捕获的
    process.exit(0);
  }

  const hookInput = await readStdin();

  if (hookInput.stop_hook_active) {
    // 避免重复触发/死循环
    process.exit(0);
  }

  const pendingEvents = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  const transcriptText = extractAssistantText(hookInput.transcript_path);

  if (!transcriptText.trim()) {
    process.exit(0);
  }

  const matches = await matchResponses(pendingEvents, transcriptText);

  for (const m of matches) {
    const original = pendingEvents.find((e) => e.id === m.id);

    if (m.addressed && m.response_text) {
      // 不管原本是respond还是fyi，只要他真的说了，都算responded
      await patchEvent(m.id, {
        status: 'responded',
        response: m.response_text,
        processed_at: new Date().toISOString(),
      });
      continue;
    }

    if (original && original.bucket === 'fyi') {
      // fyi类不强求他开口，但这次会话确实展示给他看过了，落observed才名副其实
      await patchEvent(m.id, { status: 'observed', processed_at: new Date().toISOString() });
      continue;
    }

    // bucket === 'respond' 且这次没被接住的，保持pending，留到下次会话再被SessionStart hook捞起来
  }

  // 这次会话牵涉的事处理完了，清掉状态文件
  fs.unlinkSync(STATE_FILE);
}

main().catch((err) => {
  // Stop hook出错不应该打断终端使用，记日志就好，不抛给用户看
  fs.appendFileSync('/tmp/haven-stop-hook-error.log', `${new Date().toISOString()} ${err.stack}\n`);
  process.exit(0);
});
