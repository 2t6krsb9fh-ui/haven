// 通义千问适配器 —— OpenAI 兼容格式（阿里云百炼）
const OpenAI = require('openai');

async function sendMessage(messages, options = {}) {
  const client = new OpenAI({
    apiKey: process.env.QWEN_API_KEY,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  });

  const response = await client.chat.completions.create({
    model: options.model || 'qwen-plus',
    messages,
    temperature: options.temperature ?? 0.8,
    max_tokens: options.max_tokens || 2048,
    stream: options.stream || false,
  });

  return response;
}

module.exports = { sendMessage };
