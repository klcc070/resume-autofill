// 调试:打印实习/项目行填充报告,定位日期列未填原因
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, cp, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'test', 'e2e', 'output');
const EXT_TEST = join(OUT, 'ext-test');
const USER_DATA = join(OUT, 'user-data-dbg');
const PORT = 8765;
const FILES = ['shared/mask.js', 'content/matcher.js', 'content/scanner.js', 'content/filler.js', 'content/overlay.js'];

const srv = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const rel = url.pathname === '/' ? '/mock-form.html' : url.pathname;
    res.end(await readFile(join(ROOT, 'test', rel)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(PORT, r));

await rm(USER_DATA, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(USER_DATA, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT_TEST}`, `--load-extension=${EXT_TEST}`, '--no-first-run'],
});
const sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
const profile = JSON.parse(await readFile(join(ROOT, 'data', 'profile.example.json'), 'utf8'));
delete profile._comment;
await sw.evaluate((p) => new Promise((res) => chrome.storage.local.set({ profile: p }, res)), profile);

const page = await context.newPage();
await page.goto(`http://localhost:${PORT}/mock-form.html`, { waitUntil: 'load' });

const out = await sw.evaluate(async ({ files, profile }) => {
  const [tab] = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (p) => globalThis.ResumeAutofill.preview(p),
    args: [profile],
  });
  const summary = inj.result;
  const fillRes = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => globalThis.ResumeAutofill.fill(),
  });
  const scan = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => JSON.stringify(
      {
        rows: globalThis.ResumeAutofillDebug ? null : undefined,
        labels: Array.from(document.querySelectorAll('#intern-rows tr:first-child input, #proj-rows tr:first-child input')).map((e) => ({
          name: e.name, value: e.value,
          label: globalThis.Scanner.extractLabel(e),
          m: globalThis.Matcher.matchField(globalThis.Scanner.extractLabel(e), { array: e.name.startsWith('intern') ? 'internship' : 'project', index: 0 }),
        })),
      }
    ),
  });
  return { summary, report: fillRes[0].result, scan: scan[0].result };
}, { files: FILES, profile });

console.log('=== 扫描 counts ===');
console.log(JSON.stringify(out.summary.counts));
console.log('=== 填充报告(实习/项目行相关)===');
for (const r of out.report.report) {
  if (/开始|结束|描述|公司|职位|项目|角色/.test(r.label || '') || r.path) console.log(JSON.stringify(r));
}
console.log('=== 行内标签/匹配调试 ===');
console.log(out.scan.result || out.scan);

await context.close();
srv.close();
