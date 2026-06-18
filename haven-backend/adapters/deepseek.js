// DeepSeek 适配器 —— OpenAI 兼容格式
const OpenAI = require('openai');

async function sendMessage(messages, options = {}) {
  const client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
  });

  const response = await client.chat.completions.create({
    model: options.model || 'deepseek-chat',
    messages,
    temperature: options.temperature ?? 0.8,
    max_tokens: options.max_tokens || 2048,
    stream: options.stream || false,
  });

  return response;
}

module.exports = { sendMessage };
