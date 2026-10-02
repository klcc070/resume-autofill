/**
 * popup.js — 档案管理与扫描入口
 * 档案仅存 chrome.storage.local(不同步、不上传);
 * 概览/导出默认脱敏;?tab=<id> 为自动化测试钩子,指定扫描的目标标签页。
 */
'use strict';

const STORAGE_KEY = 'profile';
const EXAMPLE_URL = '../assets/profile.example.json';

const $ = (id) => document.getElementById(id);

async function loadProfile() {
  const { [STORAGE_KEY]: profile } = await chrome.storage.local.get(STORAGE_KEY);
  return profile || null;
}

async function saveProfile(profile) {
  await chrome.storage.local.set({ [STORAGE_KEY]: profile });
}

function setStatus(id, text, isError) {
  const n = $(id);
  n.textContent = text;
  n.classList.toggle('err', !!isError);
}

/** 概览:始终脱敏展示。 */
function renderOverview(profile) {
  const state = $('profile-state');
  const body = $('overview-body');
  if (!profile || !profile.personal) {
    state.textContent = '(未导入)';
    state.className = 'state miss';
    body.textContent = '尚未导入档案';
    return;
  }
  const m = globalThis.Mask.maskProfile(profile);
  const p = m.personal;
  const line = [
    `姓名:${p.name || '—'}`,
    `手机:${p.phone || '—'}   邮箱:${p.email || '—'}`,
    `教育经历 ${count(profile.education)} 段 · 实习经历 ${count(profile.internships)} 段 · 项目经历 ${count(profile.projects)} 个 · 获奖经历 ${count(profile.awards)} 条`,
  ];
  body.textContent = line.join('\n');
  state.textContent = '(已就绪,展示为脱敏)';
  state.className = 'state ok';
}

function count(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

function validProfile(obj) {
  return obj && typeof obj === 'object' && obj.personal && typeof obj.personal === 'object';
}

async function initOverview() {
  renderOverview(await loadProfile());
}

/** 扫描当前活动标签页:档案由 service worker 从 storage 读取。 */
async function scanAndPreview() {
  const profile = await loadProfile();
  if (!validProfile(profile)) {
    setStatus('scan-status', '请先导入或编辑档案', true);
    return;
  }
  setStatus('scan-status', '扫描中…');
  chrome.runtime.sendMessage({ type: 'scan' }, (res) => {
    if (chrome.runtime.lastError) {
      setStatus('scan-status', '通信失败:' + chrome.runtime.lastError.message, true);
      return;
    }
    if (!res || !res.ok) {
      setStatus('scan-status', '无法扫描此页面:' + ((res && res.error) || '未知错误') + '\n(浏览器内置页与商店页不支持注入)', true);
      return;
    }
    const c = res.summary && res.summary.counts;
    setStatus('scan-status', `已扫描,匹配 ${c.matched}/${c.total} 项,请在页面右侧预览面板中确认后填充。`);
    window.close();
  });
}

async function loadExample() {
  const res = await fetch(EXAMPLE_URL);
  const profile = await res.json();
  $('profile-json').value = JSON.stringify(profile, null, 2);
  setStatus('edit-status', '示例档案(虚构数据)已载入编辑器,点击"保存档案"生效。');
}

function importFile() {
  $('file-import').click();
}

async function onFileChosen(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    if (!validProfile(obj)) throw new Error('缺少 personal 字段');
    $('profile-json').value = JSON.stringify(obj, null, 2);
    setStatus('edit-status', `已读取 ${file.name},确认无误后点击"保存档案"。`);
  } catch (e) {
    setStatus('edit-status', '导入失败:' + e.message, true);
  } finally {
    ev.target.value = '';
  }
}

async function exportFile() {
  const profile = await loadProfile();
  if (!validProfile(profile)) {
    setStatus('edit-status', '暂无档案可导出', true);
    return;
  }
  const includeRaw = $('export-raw').checked;
  const data = includeRaw ? profile : globalThis.Mask.maskProfile(profile);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = includeRaw ? 'profile.export.json' : 'profile.export.masked.json';
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('edit-status', includeRaw ? '已导出(含敏感原文,请妥善保管,勿外传)' : '已导出脱敏档案');
}

async function saveFromEditor() {
  try {
    const obj = JSON.parse($('profile-json').value);
    if (!validProfile(obj)) throw new Error('缺少 personal 字段');
    await saveProfile(obj);
    renderOverview(obj);
    setStatus('edit-status', '档案已保存(仅存本机 chrome.storage.local)。');
  } catch (e) {
    setStatus('edit-status', '保存失败:' + e.message, true);
  }
}

function formatEditor() {
  try {
    $('profile-json').value = JSON.stringify(JSON.parse($('profile-json').value), null, 2);
    setStatus('edit-status', '');
  } catch (e) {
    setStatus('edit-status', 'JSON 解析失败:' + e.message, true);
  }
}

$('btn-scan').addEventListener('click', scanAndPreview);
$('btn-load-example').addEventListener('click', loadExample);
$('btn-import').addEventListener('click', importFile);
$('btn-export').addEventListener('click', exportFile);
$('file-import').addEventListener('change', onFileChosen);
$('btn-save').addEventListener('click', saveFromEditor);
$('btn-format').addEventListener('click', formatEditor);

// —— AI 设置 ——
const AI_DEFAULT_PROVIDER = 'glm';
const AI_PROVIDERS = Object.freeze({
  glm: {
    label: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
  },
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
  },
  custom: { label: '自定义接口', endpoint: '', model: '' },
});

function inferAiProvider(cfg) {
  if (cfg.provider && AI_PROVIDERS[cfg.provider]) return cfg.provider;
  const endpoint = String(cfg.endpoint || '');
  if (/api\.deepseek\.com/i.test(endpoint)) return 'deepseek';
  if (/open\.bigmodel\.cn/i.test(endpoint)) return 'glm';
  return endpoint ? 'custom' : AI_DEFAULT_PROVIDER;
}

function applyAiProvider(provider, overwrite) {
  const preset = AI_PROVIDERS[provider] || AI_PROVIDERS.custom;
  if (provider === 'custom') return;
  if (overwrite || !$('ai-endpoint').value.trim()) $('ai-endpoint').value = preset.endpoint;
  if (overwrite || !$('ai-model').value.trim()) $('ai-model').value = preset.model;
}

async function loadAiSettings() {
  try {
    const st = await chrome.storage.local.get('aiConfig');
    const cfg = st.aiConfig || {};
    const provider = inferAiProvider(cfg);
    const preset = AI_PROVIDERS[provider];
    $('ai-provider').value = provider;
    $('ai-share-profile').checked = cfg.includeProfile !== false;
    $('ai-share-sensitive').checked = cfg.includeSensitive !== false;
    $('ai-endpoint').value = cfg.endpoint || preset.endpoint;
    $('ai-model').value = cfg.model || preset.model;
    $('ai-key').value = cfg.apiKey || '';
    $('ai-status').textContent = cfg.apiKey ? (cfg.includeProfile ? 'AI 已配置：扫描时自动规划' : 'AI 已配置：勾选启用后自动规划') : '未配置：仍可使用本地填充';
  } catch (e) {
    $('ai-status').textContent = '读取设置失败:' + e.message;
  }
}

async function saveAiSettings() {
  try {
    const provider = $('ai-provider').value || AI_DEFAULT_PROVIDER;
    const preset = AI_PROVIDERS[provider] || AI_PROVIDERS.custom;
    const endpoint = ($('ai-endpoint').value || preset.endpoint).trim();
    const model = ($('ai-model').value || preset.model).trim();
    const apiKey = $('ai-key').value.trim();
    if (!endpoint || !model) throw new Error('请填写 API 地址和模型名');
    const u = new URL(endpoint);
    const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !isLoopback) throw new Error('AI 接口必须使用 HTTPS(本机代理可用 http://127.0.0.1)');
    if (apiKey) {
      const origin = new URL(endpoint).origin + '/*';
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) {
        setStatus('ai-status', '未授予该 API 地址的访问权限,已保存但 AI 调用会失败', true);
      }
    }
    await chrome.storage.local.set({
      aiConfig: {
        provider,
        endpoint,
        model,
        apiKey,
        enabled: !!apiKey,
        includeProfile: $('ai-share-profile').checked,
        includeSensitive: $('ai-share-sensitive').checked,
      },
    });
    $('ai-key').value = apiKey ? '••••••••(已保存)' : '';
    setStatus('ai-status', apiKey ? 'AI 设置已保存(仅存本机)' : '已保存空配置(相当于关闭 AI)');
    loadAiSettings();
  } catch (e) {
    setStatus('ai-status', '保存失败:' + e.message, true);
  }
}

async function clearAiSettings() {
  await chrome.storage.local.set({ aiConfig: { enabled: false } });
  $('ai-key').value = '';
  setStatus('ai-status', '已清除 AI 配置');
  loadAiSettings();
}


// —— AI 连接测试:按当前表单配置发一次最小真实调用 ——
async function testAiConnection() {
  const status = $('ai-status');
  const btn = $('btn-ai-test');
  const provider = $('ai-provider').value || 'glm';
  const preset = AI_PROVIDERS[provider] || AI_PROVIDERS.custom;
  const endpoint = ($('ai-endpoint').value || preset.endpoint).trim();
  const model = ($('ai-model').value || preset.model).trim();
  let key = $('ai-key').value.trim();
  // 输入框可能是保存后的占位符或空,回退到已保存配置
  if (!key || /^•/.test(key)) {
    try { key = ((await chrome.storage.local.get('aiConfig')).aiConfig || {}).apiKey || ''; } catch {}
  }
  if (!endpoint || !model) { setStatus('ai-status', '请先填写 API 地址和模型名', true); return; }
  // 确保该地址的访问权限(点击即用户手势)
  try {
    const origin = new URL(endpoint).origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) { setStatus('ai-status', '未授予 ' + origin + ' 的访问权限,无法测试', true); return; }
    }
  } catch (e) { /* contains 在部分环境不可用时继续尝试 */ }
  btn.disabled = true;
  btn.textContent = '调用中…';
  status.classList.remove('err');
  status.textContent = '测试中:' + model + ' @ ' + new URL(endpoint).host + ' …';
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (key || 'local') },
      body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: '回复两个字:成功' }] }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch {}
    if (!r.ok) {
      setStatus('ai-status', '✘ HTTP ' + r.status + '(' + ms + 'ms):' + (j.error && j.error.message || text).slice(0, 120), true);
    } else {
      const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      const usage = j.usage ? '(' + (j.usage.total_tokens || '?') + ' tokens)' : '';
      setStatus('ai-status', '✔ 连接成功(' + ms + 'ms)' + usage + ' 回复:' + String(content).slice(0, 40));
    }
  } catch (e) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    setStatus('ai-status', '✘ ' + (e.name === 'AbortError' ? '超时(60s)' : e.message) + '(' + ms + 'ms)', true);
  }
  btn.disabled = false;
  btn.textContent = '测试连接';
}

$('btn-ai-test').addEventListener('click', testAiConnection);
$('btn-ai-save').addEventListener('click', saveAiSettings);
$('btn-ai-clear').addEventListener('click', clearAiSettings);
$('ai-provider').addEventListener('change', (ev) => applyAiProvider(ev.target.value, true));

initOverview();
loadAiSettings();
