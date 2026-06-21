/**
 * Haven 终端事件同步 · SessionStart hook 入口
 *
 * 流程：会话启动 → 批量拉所有 pending events → 跑两条独立判断轴
 *   - 能直接判定的 (observed/ignored) → 当场 PATCH 掉
 *   - 需要开口的 (responded) → 不在这里写，打印成上下文喂给 Leander，
 *     同时把这批 event 的 id 记到本地状态文件，留给 Stop hook 收尾
 *
 * 两条轴（详见 haven-terminal-event-sync-v2.md）：
 *   轴一：要不要记？      → runMemoryMatrix()   输出 CORE/REFLECTION/OBSERVATION/NO_WRITE
 *   轴二：要不要开口？    → shouldRespond()      输出 true/false
 *
 * 本版本范围之外：
 *   - 把 CORE/REFLECTION 实际写入 profile.md / companion.md / 候选池文件
 *
 * 环境变量（见 .env.example）：
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * 配合 .claude/settings.json 的 SessionStart hook 使用，stdout 会被
 * Claude Code 当作上下文注入对话，所以这里的 console.log 是写给 Leander 看的。
 */

const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STATE_FILE = process.env.HAVEN_STATE_FILE || '/tmp/haven-session-pending.json';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('缺少环境变量 SUPABASE_URL 或 SUPABASE_SERVICE_KEY，参考 .env.example');
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// ---------- Supabase REST 裸 fetch ----------

async function fetchAllPendingEvents() {
  const url = `${SUPABASE_URL}/rest/v1/events?status=eq.pending&order=created_at.asc`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`拉取 events 失败: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

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

// ---------- 轴一：要不要记？(Decision Matrix v0.3) ----------

function hasAnyOtherSignal(signals, excludeKey) {
  const keys = ['relation_marker', 'self_reference', 'time_anchor', 'interaction_intent', 'novelty'];
  return keys.some((k) => k !== excludeKey && signals[k] === true);
}

function runMemoryMatrix(event) {
  let sl = event.semantic_layer;
  const s = event.signals || {};

  // Web端是4层(TOOL/SYSTEM/PRESENCE/RELATION)，v0.3 Matrix只认3层，
  // PRESENCE(分享/想让你知道)在v0.3里并入了RELATION的"分享"语义
  if (sl === 'PRESENCE') sl = 'RELATION';

  // L1 TOOL 默认直接隔离
  if (sl === 'TOOL') return 'NO_WRITE';

  const relationDim = s.relation_marker === true || s.self_reference === true;
  const freshnessDim = s.novelty === true || s.memory_relevance === true;
  const densityDim = s.information_density === 'high';

  // WRITE_CORE：仅 L3 RELATION，三维度同时满足
  if (sl === 'RELATION' && relationDim && freshnessDim && densityDim) {
    return 'WRITE_CORE';
  }

  // WRITE_REFLECTION：L3，或 L2 且 signals 强度足够
  const comboA = s.time_anchor === true && ['medium', 'high'].includes(s.information_density);
  const comboB = s.memory_relevance === true && hasAnyOtherSignal(s, 'memory_relevance');
  const comboC = s.novelty === true && s.relation_marker === true;

  if ((sl === 'RELATION' || sl === 'SYSTEM') && (comboA || comboB || comboC)) {
    return 'WRITE_REFLECTION';
  }

  // WRITE_OBSERVATION：L2，或 L3 未达到更高等级时的兜底
  const obsCond1 = s.interaction_intent === true && s.information_density === 'low';
  const obsCond2 = event.source === 'system';
  const obsCond3 = s.novelty === false;

  if ((sl === 'SYSTEM' || sl === 'RELATION') && (obsCond1 || obsCond2 || obsCond3)) {
    return 'WRITE_OBSERVATION';
  }

  return 'NO_WRITE';
}

// ---------- 轴二：要不要开口？ ----------

function shouldRespond(event, matrixResult) {
  const s = event.signals || {};
  // 同 runMemoryMatrix：PRESENCE 并入 RELATION 语义
  const sl = event.semantic_layer === 'PRESENCE' ? 'RELATION' : event.semantic_layer;

  if (s.interaction_intent === true) return true;
  if (sl === 'RELATION' && ['medium', 'high'].includes(s.information_density)) return true;
  if (matrixResult === 'WRITE_CORE') return true;

  return false;
}

// ---------- 最终 status 判定已经搬到 haven-stop-capture.js (Stop hook) ----------
// 这里不再直接决定 observed/responded，只负责过滤真噪音(ignored)和准备上下文

// ---------- Stop hook 失败检测 ----------

function checkStopHookErrors() {
  const ERROR_LOG = '/tmp/haven-stop-hook-error.log';
  const LAST_CHECK_FILE = '/tmp/haven-last-error-check.txt';

  if (!fs.existsSync(ERROR_LOG)) return; // 从未报错，跳过

  const logStat = fs.statSync(ERROR_LOG);
  if (logStat.size === 0) return; // 空文件，跳过

  // 比对上次检查时间，避免同一条错误反复提示
  let lastCheckTime = 0;
  if (fs.existsSync(LAST_CHECK_FILE)) {
    lastCheckTime = parseInt(fs.readFileSync(LAST_CHECK_FILE, 'utf-8').trim()) || 0;
  }

  if (logStat.mtimeMs <= lastCheckTime) return; // 没有新错误

  // 有新错误 → 注入上下文，让 Leander 知道
  const errorContent = fs.readFileSync(ERROR_LOG, 'utf-8').trim();
  console.log(`\n[系统提示] 上次会话的 Stop hook 执行异常，部分响应可能未正确保存：\n${errorContent}\n`);

  // 记录本次检查时间，防止重复提示
  fs.writeFileSync(LAST_CHECK_FILE, String(Date.now()));
}

// ---------- 主流程 ----------

async function main() {
  checkStopHookErrors();

  const events = await fetchAllPendingEvents();

  if (events.length === 0) {
    console.log('Haven：没有待处理的 event。');
    return;
  }

  const needsResponse = [];
  const fyiOnly = [];
  let autoIgnored = 0;

  for (const event of events) {
    const matrixResult = runMemoryMatrix(event);
    const respond = shouldRespond(event, matrixResult);

    if (respond) {
      needsResponse.push({ ...event, _matrixResult: matrixResult, _bucket: 'respond' });
      continue;
    }

    if (matrixResult === 'NO_WRITE') {
      // 真正的噪音/测试消息，连记忆都不值得写，也不值得让他扫一眼，直接归档
      await patchEvent(event.id, { status: 'ignored', processed_at: new Date().toISOString() });
      autoIgnored++;
      continue;
    }

    // matrixResult 是 REFLECTION 或 OBSERVATION，但不需要开口——
    // 这种"日常但不必回应"的，也要让他扫一眼，不能由脚本悄悄替他归档成observed。
    // 真正的observed要等会话结束、确认他至少看过之后，由Stop hook来盖章。
    fyiOnly.push({ ...event, _matrixResult: matrixResult, _bucket: 'fyi' });
  }

  if (autoIgnored > 0) {
    console.error(`(已过滤 ${autoIgnored} 条噪音/测试消息)`); // 写到stderr，不进Leander的上下文
  }

  const toShow = [...needsResponse, ...fyiOnly];

  if (toShow.length === 0) {
    console.log('Haven：没有需要你看的 event。');
    return;
  }

  // 把这批 event 记到本地状态文件(带bucket标记)，留给会话结束时的 Stop hook 用
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      toShow.map((e) => ({ id: e.id, type: e.type, content: e.content, bucket: e._bucket })),
      null,
      2
    )
  );

  // 打印给 Leander 看的上下文（这部分 stdout 会被 SessionStart hook 注入对话）
  if (needsResponse.length > 0) {
    console.log('以下是需要你回应的几条感知事件：\n');
    for (const e of needsResponse) {
      console.log(`· [${e.type}] ${e.content}`);
    }
  }
  if (fyiOnly.length > 0) {
    console.log('\n以下只是想让你知道，不用特意回应：\n');
    for (const e of fyiOnly) {
      console.log(`· [${e.type}] ${e.content}`);
    }
  }
}

main().catch((err) => {
  console.error('终端同步出错：', err);
  process.exit(1);
});
