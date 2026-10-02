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
let defaultModel = process.env.MODEL || '';
try {
  const cfg = JSON.parse(readFileSync(zcfgPath, 'utf8'));
  const prov = cfg.provider || {};
  const entry = Object.entries(prov).find(([, p]) => p?.options?.baseURL && p?.options?.apiKey)
    || Object.entries(prov).find(([, p]) => p?.options?.apiKey);
  if (entry) upstream = { name: entry[0], ...entry[1].options };
  // 套餐主模型:builtin:xxx/GLM-5.3-Flash → GLM-5.3-Flash
  const main = cfg.model && cfg.model.main || '';
  const short = main.split('/').pop();
  if (!defaultModel && short) defaultModel = short;
} catch (e) { console.error('读取 ZCode 配置失败:', e.message); }
if (!upstream) { console.error('未找到可用的 provider 配置'); process.exit(1); }
console.log('上游:', upstream.baseURL, '| 模型:', defaultModel || '(跟随请求)');

function toAnthropic(body) {
  const msgs = body.messages || [];
  const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n') || undefined;
  const messages = msgs.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  return {
    model: body.model,
    // GLM-5.3 等思考模型会先消耗 thinking token,预算不足时 text 块为空
    max_tokens: body.max_tokens || 4096,
    temperature: body.temperature,
    system,
    messages,
  };
}
function toOpenAI(resp, model) {
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    id: resp.id || 'proxy', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: resp.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
    usage: resp.usage ? {
      prompt_tokens: resp.usage.input_tokens, completion_tokens: resp.usage.output_tokens,
      total_tokens: (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
    } : undefined,
    model,
  };
}

const TEST_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>ZCode 套餐代理 · 连通性测试</title>
<style>
  body { font: 15px/1.7 "Microsoft YaHei", system-ui, sans-serif; background: #f0f4fa; display: flex; justify-content: center; padding-top: 12vh; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 4px 18px rgba(0,0,0,.08); padding: 28px 32px; width: 460px; }
  h1 { font-size: 17px; margin: 0 0 6px; }
  .sub { color: #86909c; font-size: 12.5px; margin-bottom: 18px; word-break: break-all; }
  input { width: 100%; padding: 8px 10px; border: 1px solid #dcdfe6; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
  .row { display: flex; gap: 10px; margin-top: 10px; align-items: center; }
  button { flex: 1; padding: 10px 0; border: none; border-radius: 8px; background: #165dff; color: #fff; font-size: 14px; cursor: pointer; }
  button:disabled { background: #94bfff; cursor: wait; }
  pre { background: #f7f8fa; border-radius: 8px; padding: 12px; font-size: 12.5px; white-space: pre-wrap; word-break: break-all; margin-top: 14px; min-height: 20px; max-height: 260px; overflow: auto; }
  .ok { color: #00b42a; font-weight: 600; } .bad { color: #f53f3f; font-weight: 600; }
</style></head><body>
<div class="card">
  <h1>ZCode 套餐代理 · 连通性测试</h1>
  <div class="sub" id="meta">…</div>
  <div class="row"><input id="model" value="GLM-5.3-Flash" placeholder="模型名" /></div>
  <div class="row"><input id="prompt" value="回复两个字:成功" placeholder="测试消息" /></div>
  <div class="row"><button id="btn" onclick="run()">测试连接</button></div>
  <pre id="out">点上面的按钮,经本代理向上游套餐端点发一次真实调用。</pre>
</div>
<script>
  fetch('/v1/models').then(r => r.json()).then(j => {
    const m = j.data && j.data[0] && j.data[0].id;
    if (m && m !== 'glm-4-flash') document.getElementById('model').value = m;
  }).catch(() => {});
  async function run() {
    const btn = document.getElementById('btn'), out = document.getElementById('out');
    const model = document.getElementById('model').value.trim() || 'GLM-5.3-Flash';
    const prompt = document.getElementById('prompt').value.trim() || 'hello';
    btn.disabled = true; btn.textContent = '调用中…';
    out.textContent = '请求中:model=' + model + ' …';
    const t0 = performance.now();
    try {
      const r = await fetch('/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      });
      const ms = Math.round(performance.now() - t0);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        out.innerHTML = '<span class="bad">✘ HTTP ' + r.status + '(耗时 ' + ms + 'ms)</span>\\n' + JSON.stringify(j, null, 1);
      } else {
        const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        out.innerHTML = '<span class="ok">✔ HTTP 200(耗时 ' + ms + 'ms)</span>\\n模型回复: ' + content.slice(0, 200) + '\\n\\n用量: ' + JSON.stringify(j.usage);
      }
    } catch (e) {
      out.innerHTML = '<span class="bad">✘ 请求失败:' + e.message + '</span>(代理可能已停止)';
    }
    btn.disabled = false; btn.textContent = '测试连接';
  }
</script></body></html>`;

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/test' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE.replace('id="meta">…', 'id="meta">' + upstream.baseURL + ' · 监听 127.0.0.1:' + PORT));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: defaultModel || 'GLM-5.3-Flash', object: 'model' }] }));
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
