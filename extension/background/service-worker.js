/**
 * service-worker.js — 扫描编排与 AI 网络请求
 * 两个入口:popup 发来 {type:'scan'} / 用户按快捷键 Ctrl+Shift+F(commands)。
 * 档案一律从 chrome.storage.local 读取(单一数据源,不经过消息体,避免敏感信息多处流转)。
 * 网申页面依赖 activeTab；AI 接口域名由用户在设置页按需授权。
 */
const CONTENT_FILES = [
  'shared/mask.js',
  'shared/ai.js',
  'content/matcher.js',
  'content/components.js',
  'content/scanner.js',
  'content/filler.js',
  'content/agent.js',
  'content/overlay.js',
];

async function getProfile() {
  const { profile } = await chrome.storage.local.get('profile');
  return profile || null;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.id : null;
}

/** 注入内容脚本并在页面内执行预览。 */
async function scanTab(tabId) {
  const profile = await getProfile();
  if (!profile || !profile.personal) throw new Error('尚未导入简历档案,请先在插件弹窗中保存档案');
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (p) => await globalThis.ResumeAutofill.preview(p),
    args: [profile],
  });
  if (injection && injection.result) return injection.result;
  throw new Error('扫描失败:页面未返回结果');
}

async function runOnActiveTab() {
  try {
    const tabId = await getActiveTabId();
    if (tabId == null) return;
    const summary = await scanTab(tabId);
    // 更新角标提示匹配数量
    chrome.action.setBadgeText({ text: String(summary.counts.matched || 0) });
    chrome.action.setBadgeBackgroundColor({ color: '#00b42a' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 8000);
  } catch (err) {
    console.warn('[ResumeAutofill] 扫描失败:', err && err.message);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ai-request') {
    (async () => {
      try {
        if (sender.id !== chrome.runtime.id || !sender.tab) throw new Error('AI 请求来源无效');
        const { aiConfig } = await chrome.storage.local.get('aiConfig');
        if (!aiConfig?.apiKey || !aiConfig?.endpoint) throw new Error('AI 未配置');
        const url = new URL(aiConfig.endpoint);
        // 本机回环(本地代理)允许 HTTP,其余强制 HTTPS
        const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !loopback) throw new Error('AI 接口必须使用 HTTPS(本机代理可用 http://127.0.0.1)');
        const payload = msg.payload;
        const encoded = JSON.stringify(payload);
        if (!payload || !Array.isArray(payload.messages) || encoded.length > 280000) throw new Error('AI 请求内容无效或过大');
        payload.model = aiConfig.model;
        const res = await fetch(url.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aiConfig.apiKey },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
        sendResponse({ ok: true, data: await res.json() });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'scan') {
    (async () => {
      try {
        const tabId = typeof msg.tabId === 'number' ? msg.tabId : await getActiveTabId();
        if (tabId == null) throw new Error('未找到活动标签页');
        const summary = await scanTab(tabId);
        sendResponse({ ok: true, summary });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true; // 异步 sendResponse
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'scan-preview') runOnActiveTab();
});
