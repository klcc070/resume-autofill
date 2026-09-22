/**
 * e2e — 以真实 Chrome(通过 Playwright 控制的 chromium)加载扩展,对本地模拟网申表单
 * 做端到端验证:注入 → 扫描预览(脱敏断言)→ 填充 → 全字段断言 → 未提交断言 → 截图。
 *
 * 测试副本说明:生产 manifest 不含任何 host 权限(隐私优先,依赖 activeTab)。
 * 自动化无法模拟"点击工具栏图标"的 activeTab 授权,因此 e2e 使用一份仅额外授予
 * http://localhost:8765/* 的清单副本;被测代码与生产完全一致。
 *
 * 用法:node test/e2e/run.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT_SRC = join(ROOT, 'extension');
const OUT = join(ROOT, 'test', 'e2e', 'output');
const EXT_TEST = join(OUT, 'ext-test');
const USER_DATA = join(OUT, 'user-data');
const PORT = 8765;
const BASE = `http://localhost:${PORT}`;
const CONTENT_FILES = [
  'shared/mask.js',
  'shared/ai.js',
  'content/matcher.js',
  'content/components.js',
  'content/scanner.js',
  'content/filler.js',
  'content/overlay.js',
];

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${label}`);
  }
}

async function startServer() {
  const srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, BASE);
      const rel = url.pathname === '/' ? '/mock-form.html' : url.pathname;
      const body = await readFile(join(ROOT, 'test', rel));
      res.writeHead(200, { 'Content-Type': rel.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('nf');
    }
  });
  await new Promise((r) => srv.listen(PORT, r));
  return srv;
}

/** 构建测试扩展副本:仅给 localhost 授予 host 权限。 */
async function buildTestExtension() {
  await rm(EXT_TEST, { recursive: true, force: true });
  await cp(EXT_SRC, EXT_TEST, { recursive: true });
  const mf = JSON.parse(await readFile(join(EXT_TEST, 'manifest.json'), 'utf8'));
  mf.host_permissions = [`http://localhost:${PORT}/*`];
  await writeFile(join(EXT_TEST, 'manifest.json'), JSON.stringify(mf, null, 2));
  return EXT_TEST;
}

async function launchWithExtension(extPath, headless) {
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless,
    channel: 'chromium', // 新版 headless 才支持加载扩展
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--disable-features=ExtensionDisableUnsupportedDeveloper',
    ],
  });
  let sw = context.serviceWorkers().find((s) => s.url().startsWith('chrome-extension://'));
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    } catch {
      await context.close();
      return null;
    }
  }
  return { context, sw };
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const profile = JSON.parse(await readFile(join(ROOT, 'data', 'profile.example.json'), 'utf8'));
  delete profile._comment;

  const srv = await startServer();
  const extPath = await buildTestExtension();

  let launched = await launchWithExtension(extPath, true);
  let headed = false;
  if (!launched) {
    console.log('  … headless 下未检测到扩展 service worker,回退有头模式重试');
    await rm(USER_DATA, { recursive: true, force: true });
    launched = await launchWithExtension(extPath, false);
    headed = true;
  }
  const { context, sw } = launched;
  const extId = new URL(sw.url()).host;
  console.log(`[e2e] 扩展已加载 id=${extId} (headed=${headed})`);

  // 1. 种入档案(走扩展 storage,与真实使用一致)
  await sw.evaluate((p) => new Promise((res) => chrome.storage.local.set({ profile: p }, res)), profile);
  console.log('[e2e] 档案已写入 chrome.storage.local');

  // 2. 打开模拟网申页
  const page = await context.newPage();
  await page.goto(`${BASE}/mock-form.html`, { waitUntil: 'load' });

  // 3. 通过 service worker 扫描注入(与生产代码同路径)
  const scanResult = await sw.evaluate(async ({ files, profile, port }) => {
    const [tab] = await chrome.tabs.query({ url: `http://localhost:${port}/*` });
    if (!tab) return { error: '未找到 mock 表单标签页' };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (p) => await globalThis.ResumeAutofill.preview(p),
        args: [profile],
      });
      return inj.result;
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }, { files: CONTENT_FILES, profile, port: PORT });
  ok(!scanResult.error, `扫描注入成功${scanResult.error ? ':' + scanResult.error : ''}`);
  ok(scanResult.counts && scanResult.counts.total > 0, `扫描到 ${scanResult.counts?.total} 个字段`);

  await page.screenshot({ path: join(OUT, '01-preview.png'), fullPage: false });

  // 4. 预览面板脱敏断言(页面 DOM 中是原始值?不——此时尚未填充;断言面板不泄露原文)
  const previewText = await page.evaluate(() => document.getElementById('__resume_autofill_host__').shadowRoot.textContent);
  ok(previewText.includes('138****5678'), '预览面板手机号已脱敏(138****5678)');
  ok(previewText.includes('l*********@example.com'), '预览面板邮箱已脱敏');
  ok(previewText.includes('李**'), '预览面板姓名已脱敏');
  ok(!previewText.includes('13812345678'), '预览面板未泄露完整手机号');
  ok(!previewText.includes('110101200306151234'), '预览面板未泄露完整身份证号');
  ok(previewText.includes('华中科技大学'), '预览面板展示教育经历(非敏感字段明文)');

  // 5. 点击"开始填充"(穿透 shadow DOM)
  await page.locator('#__resume_autofill_host__ #btn-fill').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, '02-filled.png'), fullPage: true });

  // 6. 全字段值断言
  const v = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    gender: document.querySelector('input[name=gender]:checked')?.value || '',
    birth: document.getElementById('birth').value,
    age: document.getElementById('age').value,
    phone: document.getElementById('phone').value,
    email: document.getElementById('email').value,
    idcard: document.getElementById('idcard').value,
    political: document.getElementById('political').value,
    ethnicity: document.getElementById('ethnicity').value,
    origin: document.getElementById('origin').value,
    address: document.getElementById('address').value,
    english: document.getElementById('english').value,
    gpa: document.getElementById('gpa').value,
    salary: document.getElementById('salary').value,
    referral: document.getElementById('referral').value,
    internDesc: document.getElementById('intern-desc').value,
    projDesc: document.getElementById('proj-desc').value,
    cities: Array.from(document.querySelectorAll('input[name=city]:checked')).map((c) => c.value),
    qAdjust: document.querySelector('input[name=q_adjust]:checked')?.value || '',
    qRelative: document.querySelector('input[name=q_relative]:checked')?.value || '',
    eduRows: Array.from(document.querySelectorAll('#edu-rows tr')).map((tr) => ({
      fields: Array.from(tr.querySelectorAll('input:not([type=radio]), select')).map((e) => e.value),
      fullTime: tr.querySelector('input[type=radio]:checked')?.value || '',
    })),
    internRows: Array.from(document.querySelectorAll('#intern-rows tr')).map((tr) =>
      Array.from(tr.querySelectorAll('input')).map((e) => e.value)
    ),
    projRows: Array.from(document.querySelectorAll('#proj-rows tr')).map((tr) =>
      Array.from(tr.querySelectorAll('input')).map((e) => e.value)
    ),
    addedRows: window.__addedRows,
  }));

  ok(v.name === '李明远', `姓名 = ${v.name}`);
  ok(v.gender === '男', `性别 = ${v.gender}`);
  ok(v.birth === '2003-06-15', `出生日期 = ${v.birth}`);
  ok(Number(v.age) === 23, `年龄(由出生日期推算)= ${v.age}`);
  ok(v.phone === '13812345678', `手机号写入完整原文 = ${v.phone}`);
  ok(v.email === 'limingyuan@example.com', `邮箱 = ${v.email}`);
  ok(v.idcard === '110101200306151234', `身份证 = ${v.idcard}`);
  ok(v.political === '共青团员', `政治面貌 = ${v.political}`);
  ok(v.ethnicity === '汉族', `民族 = ${v.ethnicity}`);
  ok(v.origin === '北京市', `籍贯 = ${v.origin}`);
  ok(v.address === '北京市海淀区', `现居住地 = ${v.address}`);
  ok(v.english === 'CET-6', `英语等级 = ${v.english}`);
  ok(v.gpa === '3.6/4.0', `绩点 = ${v.gpa}`);

  ok(v.eduRows.length === 2, `教育经历 ${v.eduRows.length} 行(自动点击"添加"增行)`);
  ok(JSON.stringify(v.eduRows[0]) === JSON.stringify({ fields: ['2021-09', '2025-06', '华中科技大学', '计算机学院', '计算机科学与技术', '本科'], fullTime: '全日制' }),
    `教育第 1 行 = ${JSON.stringify(v.eduRows[0])}`);
  ok(JSON.stringify(v.eduRows[1]) === JSON.stringify({ fields: ['2018-09', '2021-06', '北京市第一中学', '高中部', '理科', '高中'], fullTime: '全日制' }),
    `教育第 2 行 = ${JSON.stringify(v.eduRows[1])}`);

  ok(v.internRows.length === 2, `实习经历 ${v.internRows.length} 行`);
  ok(JSON.stringify(v.internRows[0]) === JSON.stringify(['2024-03', '2024-09', '云帆科技有限公司', '后端开发实习生']),
    `实习第 1 行 = ${JSON.stringify(v.internRows[0])}`);
  ok(JSON.stringify(v.internRows[1]) === JSON.stringify(['2023-06', '2023-09', '星河数据集团', '数据分析实习生']),
    `实习第 2 行 = ${JSON.stringify(v.internRows[1])}`);
  ok(v.internDesc.includes('订单服务重构'), '实习描述(textarea)已填');

  ok(v.projRows.length === 2, `项目经历 ${v.projRows.length} 行`);
  ok(JSON.stringify(v.projRows[0]) === JSON.stringify(['2023-10', '2024-04', '校园二手交易平台', '负责人']),
    `项目第 1 行 = ${JSON.stringify(v.projRows[0])}`);
  ok(JSON.stringify(v.projRows[1]) === JSON.stringify(['2024-05', '至今', '开源项目 QueryLens', '核心贡献者']),
    `项目第 2 行 = ${JSON.stringify(v.projRows[1])}`);
  ok(v.projDesc.includes('协同过滤'), '项目描述(textarea)已填');

  ok(JSON.stringify(v.cities) === JSON.stringify(['北京', '上海', '杭州']), `意向城市 = ${JSON.stringify(v.cities)}`);
  ok(v.qAdjust === '服从调剂', `筛选题1 = ${v.qAdjust}`);
  ok(v.qRelative === '否', `筛选题2 = ${v.qRelative}`);
  ok(v.salary === '面议', '期望薪资被档案值覆盖(档案为唯一事实源),原值见报告 kept-mismatch');
  ok(v.referral === '', '词典外字段(招聘信息来源)保持空白');

  // 7. 填充报告脱敏断言
  const reportText = await page.evaluate(() => document.getElementById('__resume_autofill_host__').shadowRoot.textContent);
  ok(reportText.includes('138****5678'), '填充报告手机号已脱敏');
  ok(!reportText.includes('13812345678'), '填充报告未泄露完整手机号');

  // 8. 未提交断言(工具绝不自动提交)
  const submitted = await page.evaluate(() => window.__submitted);
  ok(submitted === false, '表单未被自动提交');

  await page.screenshot({ path: join(OUT, '03-final.png'), fullPage: true });

  // 9. popup UI:概览脱敏 + 示例档案载入
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForTimeout(300);
  const overviewText = await popup.evaluate(() => document.body.textContent);
  ok(overviewText.includes('138****5678'), 'popup 概览手机号已脱敏');
  ok(!overviewText.includes('13812345678'), 'popup 概览未泄露完整手机号');
  await popup.selectOption('#ai-provider', 'deepseek');
  ok(await popup.inputValue('#ai-endpoint') === 'https://api.deepseek.com/chat/completions', 'popup 可一键切换 DeepSeek API');
  ok(await popup.inputValue('#ai-model') === 'deepseek-v4-flash', 'popup 自动填入 DeepSeek 当前模型');
  await popup.click('#btn-load-example');
  await popup.waitForFunction(() => document.getElementById('profile-json').value.includes('李明远'), null, { timeout: 5000 });
  const editorVal = await popup.evaluate(() => document.getElementById('profile-json').value);
  ok(editorVal.includes('李明远'), 'popup 可载入示例档案到编辑器');
  await popup.screenshot({ path: join(OUT, '04-popup.png') });

  // 汇总
  console.log(`\n[e2e] 通过 ${passed} / 失败 ${failed}`);
  await context.close();
  srv.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('[e2e] 异常退出:', e);
  process.exit(1);
});
