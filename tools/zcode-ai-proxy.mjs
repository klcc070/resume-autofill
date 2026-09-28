// zcode-ai-proxy.mjs — 本地 OpenAI→Anthropic 转换代理(供简历闪填扩展复用 ZCode 套餐)
// 用法:node tools/zcode-ai-proxy.mjs [端口,默认 8787]
// 从 ~/.zcode/cli/config.json 读取 coding-plan 的 baseURL/apiKey,不打印密钥。
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { join } from 'path';
import { homedir } from 'os';

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const zcfgPath = join(homedir(), '.zcode', 'cli', 'config.json');

let upstream = null;
try {
  const cfg = JSON.parse(readFileSync(zcfgPath, 'utf8'));
  const prov = cfg.provider || {};
  const entry = Object.entries(prov).find(([, p]) => p?.options?.baseURL && p?.options?.apiKey)
    || Object.entries(prov).find(([, p]) => p?.options?.apiKey);
  if (entry) upstream = { name: entry[0], ...entry[1].options };
} catch (e) { console.error('读取 ZCode 配置失败:', e.message); }
if (!upstream) { console.error('未找到可用的 provider 配置'); process.exit(1); }
console.log('上游:', upstream.baseURL, '| 模型:', process.env.MODEL || '(跟随请求)');

function toAnthropic(body) {
  const msgs = body.messages || [];
  const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n') || undefined;
  const messages = msgs.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  return {
    model: body.model,
    max_tokens: body.max_tokens || 2048,
    temperature: body.temperature,
    system,
    messages,
  };
}
function toOpenAI(resp, model) {
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    id: resp.id || 'proxy', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: resp.usage ? {
      prompt_tokens: resp.usage.input_tokens, completion_tokens: resp.usage.output_tokens,
      total_tokens: (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
    } : undefined,
    model,
  };
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: process.env.MODEL || 'glm-4-flash', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !/chat\/completions$/.test(req.url)) {
    res.writeHead(404); res.end('not found'); return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const openai = JSON.parse(body);
      const anth = toAnthropic(openai);
      const base = (process.env.UPSTREAM_BASE || upstream.baseURL).replace(/\/$/, '');
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': upstream.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anth),
      });
      const text = await r.text();
      if (!r.ok) {
        console.error('[proxy] 上游错误', r.status, text.slice(0, 200));
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: text.slice(0, 300) } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(toOpenAI(JSON.parse(text), anth.model)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(e.message || e) } }));
    }
  });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`zcode-ai-proxy 监听 http://127.0.0.1:${PORT}/v1/chat/completions`);
});
