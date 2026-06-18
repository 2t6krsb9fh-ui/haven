require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// ============ 多模型适配器路由 ============
const adapters = {
  deepseek: require('./adapters/deepseek'),
  qwen: require('./adapters/qwen'),
  claude: require('./adapters/claude'),
};

function getAdapter(modelName) {
  // 根据模型名自动分发到对应适配器
  const name = (modelName || '').toLowerCase();
  if (name.includes('deepseek')) return adapters.deepseek;
  if (name.includes('qwen') || name.includes('tongyi')) return adapters.qwen;
  if (name.includes('claude')) return adapters.claude;
  // 默认 DeepSeek
  return adapters.deepseek;
}

// ============ CORS 白名单 ============
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.FRONTEND_URL, // Vercel 部署后填域名
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // 开发时允许无 origin 请求（如 Postman）
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS blocked: ' + origin));
    }
  },
  credentials: true,
}));

app.use(express.json());

// ============ 健康检查 / 保活 ============
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ 对话接口（流式） ============
app.post('/api/chat', async (req, res) => {
  const { messages, model = 'deepseek-chat', temperature, maxTokens } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages 数组不能为空' });
  }

  const adapter = getAdapter(model);

  // 设置 SSE 流式响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲

  try {
    const response = await adapter.sendMessage(messages, {
      model,
      temperature: temperature ?? 0.8,
      max_tokens: maxTokens || 2048,
      stream: true,
    });

    // 处理流式响应
    // OpenAI 兼容格式（DeepSeek / Qwen / 通义千问）
    if (response[Symbol.asyncIterator]) {
      for await (const chunk of response) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
    }
    // Anthropic 格式（Claude）
    else if (response.stream) {
      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta?.text) {
          res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
    }
  } catch (err) {
    console.error('模型调用失败:', err.message);
    res.write(`data: [ERROR] ${err.message}\n\n`);
  } finally {
    res.end();
  }
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`🏠 Haven 后端已启动 → http://localhost:${PORT}`);
  console.log(`   CORS 白名单: ${ALLOWED_ORIGINS.join(', ') || '(仅本地)'}`);
});
