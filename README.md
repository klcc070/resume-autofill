# 校招简历闪填 ResumeAutofill

隐私优先的 Chrome 扩展(Manifest V3):一键扫描校招网申页面的表单,从**本地简历档案**语义匹配字段(姓名、性别、年龄、教育经历、实习经历、项目经历、筛选题等),在页面内预览确认后自动填充。**数据不出本机、敏感信息脱敏显示、绝不自动提交。**

![效果](docs/screenshot-filled.png)

## 功能

- **语义字段匹配**:中英同义词词典 + 文本归一化,覆盖姓名/性别/出生年月/手机/邮箱/身份证/政治面貌/籍贯/英语等级/GPA/意向城市等 20+ 常见网申字段;年龄由出生日期自动推算。
- **经历分区填充**:教育经历、实习经历、项目经历、获奖经历的表格行逐行映射;档案条目多于表单行数时自动点击页面"添加"按钮增行。
- **筛选题应答**:`qa` 预置答案按题干匹配(支持题干插入修饰语的模糊匹配),radio 选项按语义相似度选择。
- **多种控件兼容**:text/tel/email/number/date/month/textarea/select/radio/checkbox 组;React/Vue 受控组件兼容(原生 setter + 事件派发);formily 表单(得物等字节系网申)自动识别;**自定义下拉框与日历/月份范围选择器**通过模拟点击展开+选项匹配自动填充。
- **AI 智能填充(可选)**:规则识别不了的字段或经历表格存在歧义时,可在弹窗「AI 设置」选择 DeepSeek、智谱 GLM 或自定义 OpenAI 兼容接口,勾选允许后由模型结合网页结构与教育/实习/项目内容生成整页路由计划;联系方式、身份证默认不发送,AI 只输出受限的字段路径和高层控件意图,实际下拉框/日历/输入仍由本地确定性执行器完成,确认过的映射存入站点记忆。
- **防重复填充**:用户已填过的字段自动跳过。
- **预览面板**:页面内 shadow DOM 面板列出"已匹配/无值/未匹配"清单,确认后一键填充,填充报告逐项标注状态。

### 获奖经历档案格式

每条奖项使用固定的四字段记录块,便于按网页行逐条路由:

```json
{
  "name": "国家励志奖学金",
  "date": "2023-09",
  "level": "国家级",
  "description": "用于表彰品学兼优、家庭经济困难的学生。"
}
```

对应网页字段为“奖项名称 → name”、“获奖时间 → date”、“获奖级别 → level”、“奖项描述 → description”。

## 数据脱敏(核心设计)

| 环节 | 策略 |
|------|------|
| 存储 | 档案仅存 `chrome.storage.local`,不使用 `storage.sync`,零网络请求(manifest 无任何 host 权限) |
| 展示 | 预览面板/填充报告/popup 概览中,姓名 `李**`、手机 `138****5678`、邮箱 `l*********@example.com`、身份证 `1101************34` 一律打码,点击单条可临时显示原文 |
| 导出 | 默认导出脱敏档案;勾选"包含敏感原文"才导出全量(文件名区分) |
| 仓库 | `data/profile.example.json` 全为虚构数据;`.gitignore` 排除一切真实档案导出与简历原件 |

## 安装使用

1. 打开 Chrome,访问 `chrome://extensions`,开启右上角"开发者模式"
2. 点击"加载已解压的扩展程序",选择本仓库的 `extension/` 目录
3. 点击工具栏扩展图标 → "载入示例档案" → 把编辑器里的虚构数据改成你的真实信息 → "保存档案"
4. 打开任意网申页面,点击扩展图标 → "扫描并预览当前页"(或按 `Ctrl+Shift+F`)
5. 在页面右侧预览面板核对(敏感信息已脱敏)→ 点击"开始填充" → **人工逐项核对后自行点击网站提交按钮**

> 工具只填充,不提交。网申表单提交前请务必人工核对,尤其是身份证号、联系方式等关键字段。

## 测试

```bash
npm install
npm test          # 单元测试(16 项)+ e2e 端到端(43 项断言)
npm run serve     # 单独启动本地模拟网申表单 http://localhost:8765/mock-form.html
```

- **单元测试**(`test/unit/`):匹配词典的精确/包含/歧义消解/行下标映射,脱敏函数的格式与空值安全。
- **端到端**(`test/e2e/run.mjs`):Playwright 以 `--load-extension` 加载真实浏览器,对 `test/mock-form.html`(仿真网申页:基本信息 + 三类经历表格 + 动态添加行 + 多选城市 + 筛选题)做全链路验证:注入 → 预览脱敏断言 → 填充 → 全字段值断言 → 报告脱敏断言 → 未提交断言,并输出截图到 `test/e2e/output/`。
- e2e 使用一份仅额外授予 `http://localhost:8765/*` 的清单副本(自动化无法模拟 activeTab 的图标点击授权);**生产清单保持零 host 权限**,被测代码与生产完全一致。

## 目录结构

```
extension/            # Chrome 加载此目录
├── manifest.json     # MV3:仅 activeTab + scripting + storage
├── background/       # service worker:扫描编排、快捷键
├── content/          # scanner 扫描 / matcher 词典匹配 / filler 填充 / overlay 预览面板
├── popup/            # 档案管理:编辑、导入导出、脱敏概览
├── shared/mask.js    # 脱敏工具
└── assets/           # 图标与示例档案
data/                 # 示例档案(虚构数据)
test/                 # mock 表单、单测、e2e
docs/DESIGN.md        # 设计文档与开源方案对比
```

## 开源方案参考

设计借鉴了以下开源项目,详见 [docs/DESIGN.md](docs/DESIGN.md):
[OpenJobAutofill](https://github.com/Br1an67/OpenJobAutofill)(隐私优先、按需注入)、[CVflash](https://github.com/DHLbigmonster/CvFlash)(分区填充、防重复)、[AIHawk](https://github.com/Intusar/Auto_Jobs_Applier_AI_Agent)(本地档案单一数据源)、[JobMatchAI](https://github.com/wadekarg/JobMatchAI)(字段扫描 + JSON 档案匹配)、[resume-auto-fill](https://github.com/zhuzhipeng-123/resume-auto-fill)(中文同义词词典)。

