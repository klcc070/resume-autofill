# 设计文档:校招简历闪填 ResumeAutofill

## 1. 目标与边界

帮助应届生在校招网申系统(公司自有网申、牛客/实习僧投递页等)快速、一致地填写重复性简历信息。

**边界(刻意不做)**:
- 不自动提交任何表单——填充后必须由用户人工核对并手动提交;
- 不上传任何数据——无服务器、无遥测、无 LLM API 调用;
- 不破解验证码/登录——由用户自行登录后使用。

## 2. 开源方案对比与借鉴

| 方案 | 核心思路 | 借鉴点 | 未采纳部分 |
|------|---------|--------|-----------|
| [OpenJobAutofill](https://github.com/Br1an67/OpenJobAutofill) | AI 辅助、隐私优先的网申填写插件 | 隐私优先定位;能填的填、不能填的标记待处理;数据仅存本机 | 未接 LLM(语义匹配用本地词典即可覆盖常见字段,且避免数据外发) |
| [CVflash](https://github.com/DHLbigmonster/CvFlash) | PDF 简历解析 + 分区精准填充 | 分区(基本/教育/实习/项目)填充思想;防重复填充 | PDF 解析(v1 用结构化 JSON 档案,见 §6 扩展点) |
| [AIHawk](https://github.com/Intusar/Auto_Jobs_Applier_AI_Agent) | 全自动投递 agent,档案 YAML 单一数据源 | 档案作为单一数据源,填充与档案管理解耦 | 全自动投递(法律/账号风险,违背"不自动提交"边界) |
| [JobMatchAI](https://github.com/wadekarg/JobMatchAI) | 扫描页面全部字段,连同档案与预置问答发给 AI | "扫描全字段 → 匹配 → 报告未匹配"三段式;预置 Q&A | AI 匹配(同上) |
| [resume-auto-fill](https://github.com/zhuzhipeng-123/resume-auto-fill) | 控制台脚本 + 中文同义词表填充 | 中文网申同义词词典思路 | 控制台脚本形态(一次性,无预览,不可维护) |

## 3. 架构

```
┌─ popup(档案管理 UI)────┐
│  编辑/导入/导出 JSON      │  chrome.runtime.sendMessage({type:'scan'})
│  脱敏概览(Mask)         │──────────────▶┌─ service worker ─────────────┐
└─────────────────────────┘               │ 从 storage.local 读档案       │
                                          │ chrome.scripting 注入内容脚本  │
┌─ 快捷键 Ctrl+Shift+F ───────────────────▶│ (activeTab,按需注入)          │
└─────────────────────────┘               └──────────────┬───────────────┘
                                                         ▼
   页面隔离世界(isolated world)中依次求值:
   mask.js → matcher.js → scanner.js → filler.js → overlay.js
   Scanner.scan() → ResumeAutofill.preview(profile) → 用户点"开始填充"
                  → ResumeAutofill.fill() → 报告渲染(shadow DOM 面板)
```

### 3.1 manifest 权限(最小化)

- `activeTab` + `scripting`:仅当用户点击图标/按快捷键时获得当前页注入权;不声明 `content_scripts` 与任何 `host_permissions`,扩展在用户动作前对任何页面都不可读。
- `storage`:仅 `storage.local`(不用 `storage.sync`,避免数据经 Google 账号同步出本机)。
- 网络请求:零(manifest 无 host 权限,代码无 fetch/XHR)。

### 3.2 内容脚本加载

`chrome.scripting.executeScript({files:[...]})` 依次注入无模块化的脚本,通过 `globalThis.{Mask,Matcher,Scanner,Filler,ResumeAutofill}` 共享。每个文件带 `module.exports` 守卫,同一份代码可在 Node 单测中加载。

## 4. 核心算法

### 4.1 文本归一化(normalize)

小写 → 去空白与全半角标点(含中文冒号/括号/顿号)→ 去尾部"必填/请填写"等噪声词。`'*手机号码(必填)'` 与 `'手机号码'` 归一。

### 4.2 字段匹配(matchField)

- **词典**:全局 20+ 字段(个人信息)+ 三类经历行词典(学校/专业/学历/公司/职位/起止时间/描述等)。
- **评分**:归一化后精确相等 = 100 + 同义词长度(长词更可信);包含 = 80 + 长度差惩罚。歧义靠"精确 > 包含、长同义词 > 短同义词"消解:`紧急联系电话` 命中紧急联系人电话而非手机号;`项目名称` 不会误判为 `姓名`。
- **行上下文**:scanner 识别经历行容器(`<tr>` 等)并用**区块标题**(向上遍历兄弟标题节点)判定行类型,行内字段映射到 `education[<下标>].school` 等;下标按同类容器文档序编号。无行上下文时回退第 0 行(单组经历字段)。
- **label 提取优先级**:`label[for]` → 包裹 label → aria → **表格表头同列 th**(网申表单大量使用 table 布局)→ 表单组容器字段标签 → placeholder → name → 前置兄弟文本。
  教训:placeholder 是输入示例不是标签——表头/组标签必须先于 placeholder,否则 `intern_start` 会被当成名为"2024-03"的字段(e2e 发现并修复)。
- **筛选题(qa)**:题干 ≥8 字的 radio 组视为筛选题,与 `profile.qa` 键互包含匹配;包含失败时退化为**有序子序列匹配**(容忍"是否服从**全国范围的**工作地点调剂"这类插入修饰语),要求键长 ≥6 防误报。

### 4.3 填充(filler)

- **框架兼容**:`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)` + 派发 `input`/`change`,绕过 React 受控组件的值拦截;radio/checkbox 用原生 `click()` 走完整事件链。
- **类型适配**:`input[type=date]` 补齐 `yyyy-MM-dd`;`month` 用 `yyyy-MM`;文本日期框按词典类型(`month`)输出 `yyyy-MM`;select/radio 选项按归一化相似度(精确 > 包含)选择。
- **增行**:档案条目数 > 现有行数时,从行容器逐级向上(含后续兄弟节点)查找"添加/新增/+…"按钮,点击增行后**重新扫描**再统一填充(pass1 填基本信息与选项组 → 增行 → 重扫 → pass2 填全部行)。两阶段填充避免在过期 DOM 引用上操作。
- **防重复**:已有非空值的字段跳过(状态 `kept`),绝不覆盖用户手填内容。

### 4.4 脱敏(mask)

路径感知:`personal.{name,phone,email,idCard}` 等敏感叶字段在预览/报告/概览/导出中经 `maskPhone/maskEmail/maskIdCard/maskName` 打码;非敏感字段(学校、项目名等)明文展示以便核对。点击单条临时显示原文,再次点击恢复。`maskProfile` 深拷贝脱敏,原档案不受影响。

## 5. 测试策略

| 层 | 内容 | 结果 |
|----|------|------|
| 单元(node --test) | 归一化、精确/包含/歧义匹配、行下标映射、qa 模糊匹配、脱敏格式与空值安全 | 16/16 |
| e2e(Playwright + 真实浏览器) | 加载扩展 → storage 种入档案 → SW 注入扫描 → 预览脱敏断言(含"不泄露原文"反向断言)→ 填充 → 45 项全字段值断言(含经历行整行、增行、防覆盖、词典外字段留白)→ 报告脱敏 → 未提交断言 → popup 脱敏概断言 → 截图存证 | 43/43(两轮稳定) |

**e2e 特殊处理**:生产 manifest 无 host 权限,而自动化无法模拟"点击工具栏图标"触发 activeTab 授权,故 e2e 构建一份仅追加 `http://localhost:8765/*` 的清单副本;被测 JS 与生产逐字节一致,隐私属性(零 host 权限)在生产清单中保持。

**e2e 发现并修复的真实缺陷**:
1. "添加"按钮在表格外部时找不到 → 改为从行容器逐级向外(含后续兄弟)搜索;
2. 表格列 label 被 placeholder 抢占 → 调整提取优先级(表头 > placeholder);
3. 增行后在过期 DOM 引用上填充 → 两阶段填充 + 重扫;
4. 面板统计"匹配 24/共 20"分母遗漏经历行 → 计数修正。

## 6. 扩展点(未实现,留作后续)

- **简历文件导入**:接 document-skills 的 pdf/docx 解析,从简历原件自动生成 `profile.json`;
- **LLM 兜底匹配**:词典未命中的字段可本地(或用户明确同意后远程)用小模型二次匹配;
- **站点适配配置**:`mappings` 字段已预留站点级 label→路径手工映射;
- **更多控件**:富文本(contenteditable)、日期选择器弹层、分步表单(向导式网申)。
