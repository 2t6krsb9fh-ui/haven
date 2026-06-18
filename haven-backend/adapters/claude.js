// Claude 适配器 —— Anthropic 原生格式
const Anthropic = require('@anthropic-ai/sdk');

async function sendMessage(messages, options = {}) {
  const client = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY,
  });

  // 提取 system 消息（Anthropic 格式要求 system 单独传入）
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const response = await client.messages.create({
    model: options.model || 'claude-sonnet-4-6',
    max_tokens: options.max_tokens || 2048,
    temperature: options.temperature ?? 0.8,
    system: systemMsg?.content || '',
    messages: chatMessages,
    stream: options.stream || false,
  });

  return response;
}

module.exports = { sendMessage };
