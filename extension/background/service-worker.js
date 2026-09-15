/**
 * service-worker.js — 扫描编排
 * 两个入口:popup 发来 {type:'scan'} / 用户按快捷键 Ctrl+Shift+F(commands)。
 * 档案一律从 chrome.storage.local 读取(单一数据源,不经过消息体,避免敏感信息多处流转)。
 * 生产清单不申请任何 host 权限:仅依赖 activeTab(用户点击图标/快捷键后授权当前页)。
 */
const CONTENT_FILES = [
  'shared/mask.js',
  'shared/ai.js',
  'content/matcher.js',
  'content/components.js',
  'content/scanner.js',
  'content/filler.js',
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
