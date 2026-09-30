/**
 * ai.js — AI 整页规划、受限交互动作与旧版字段映射接口。
 * 整页规划会发送页面局部 HTML、现值和简历；后台负责实际模型请求。
 * 输出路径与动作经过本地白名单校验，不接收模型生成的任意脚本。
 * 兼容:扩展各上下文(globalThis.AIMapping)与 Node 测试(module.exports)。
 */
(function (root) {
  'use strict';

  /** 可用档案路径目录(带中文说明,喂给模型) */
  const PATH_CATALOG = [
    ['personal.name', '姓名'], ['personal.gender', '性别(男/女)'], ['personal.birthDate', '出生日期(YYYY-MM-DD)'],
    ['personal.phone', '手机号'], ['personal.email', '邮箱'], ['personal.idCard', '身份证号'],
    ['personal.politicalStatus', '政治面貌'], ['personal.ethnicity', '民族'], ['personal.origin', '籍贯/生源地'],
    ['personal.hukou', '户口/户籍所在地'], ['personal.address', '现居住地/通讯地址'], ['personal.englishLevel', '英语等级(CET-4/CET-6等)'],
    ['personal.gpa', '绩点GPA'], ['personal.expectedSalary', '期望薪资'], ['personal.desiredCities', '意向工作城市(数组)'],
    ['personal.website', '个人主页'], ['personal.github', 'GitHub主页'], ['personal.emergencyContact', '紧急联系人'],
    ['personal.emergencyContactPhone', '紧急联系人电话'], ['personal.ethnicity', '民族'],
    ['education[i].school', '第i段教育的学校(从0编号)'], ['education[i].college', '学院/院系'], ['education[i].major', '专业'], ['education[i].degree', '学历/学位(高中/本科/硕士/博士)'],
    ['education[i].fullTime', '学习形式(全日制/非全日制)'],
    ['education[i].startDate', '教育开始时间(YYYY-MM)'], ['education[i].endDate', '教育结束/毕业时间'],
    ['internships[i].company', '第i段实习的公司'], ['internships[i].role', '实习职位'], ['internships[i].department', '实习部门'],
    ['internships[i].startDate', '实习开始时间'], ['internships[i].endDate', '实习结束时间'], ['internships[i].description', '实习内容描述'],
    ['employment[i].company', '第i段正式工作的公司'], ['employment[i].role', '正式工作职位'], ['employment[i].department', '正式工作部门'],
    ['employment[i].startDate', '正式工作开始时间'], ['employment[i].endDate', '正式工作结束时间'], ['employment[i].description', '正式工作职责描述'],
    ['projects[i].name', '第i个项目的名称'], ['projects[i].role', '项目中担任的角色'], ['projects[i].techStack', '项目技术栈'],
    ['projects[i].startDate', '项目开始时间'], ['projects[i].endDate', '项目结束时间'], ['projects[i].description', '项目描述'],
    ['awards[i].name', '第i个奖项名称'], ['awards[i].date', '第i个奖项获奖时间(YYYY-MM)'], ['awards[i].level', '第i个奖项获奖级别'], ['awards[i].description', '第i个奖项描述'],
    ['summary.selfIntroduction', '自我评价/自我介绍'],
  ];

  const SYSTEM_PROMPT =
    '你是网申表单字段映射助手。给你若干表单字段的结构化描述(标签、区块、记录下标、组件类型、选项等,不含任何用户数据)' +
    '和一份简历档案的可用路径目录。请为每个字段选择最合适的路径;' +
    '优先依据 section、itemIndex、semanticName 判断经历类型和下标;employment 表示正式工作,internships 表示实习,二者不可混用;' +
    '目录里的 [i] 是占位符，输出时必须按 itemIndex 改成具体数字，例如 internships[1].company，禁止原样输出 [i];' +
    'componentType 只描述页面控件形态，不改变字段语义；模型只负责映射，不负责生成点击或脚本;' +
    '确定不属于任何路径的字段,path 填 null。只输出 JSON 对象,不要输出任何解释:' +
    '{"mappings":[{"i":0,"path":"personal.name","confidence":0.9}]}';

  const TABLE_SYSTEM_PROMPT =
    '你是网申表格结构理解助手。输入是一组教育、实习、正式工作或项目经历表格,每张表包含多个记录行,每行包含字段描述。' +
    '请结合表名、行号、字段标签、组件类型、已有候选路径和 semanticName,为每个字段路由到简历档案路径。' +
    '最重要的约束:同一行的字段必须属于同一条记录;实习只能路由 internships,正式工作只能路由 employment,教育只能路由 education,项目只能路由 projects;' +
    '不要把不同记录的公司、职位、内容或日期串联;不要因为所有行标签相同而只返回第一行。' +
    'path 必须使用具体下标,例如 internships[1].company,不能输出 [i];无法确定时 path 填 null。' +
    '只输出 JSON 对象,不要输出解释,格式为 {"mappings":[{"tableId":"internships","row":0,"field":0,"path":"internships[0].company","confidence":0.95}]}。';

  const SMART_SYSTEM_PROMPT =
    '你是网申智能填充规划器。输入包含网页字段/表格结构和用户简历档案,请做全局语义匹配并为每个可填目标生成操作计划。' +
    '优先依据档案内容、网页区块、已有值、附近 HTML 和字段标签进行整体对齐;网页行号不等于简历记录下标。' +
    '同一经历行的公司、职位、内容、开始时间、结束时间必须来自同一条档案记录,同一表内不同网页行应匹配不同简历记录。' +
    'operation 只能是 text、textarea、native-select、custom-select、radio、checkbox、date-input、month-picker、date-range-picker 或 auto;' +
    'operation 是高层控件意图,不要输出 CSS 选择器、JavaScript 或点击步骤;日期只输出档案路径,不要改写日期值。' +
    '无法确定的字段不要猜,可以省略。只输出 JSON 对象,不要输出解释,格式为 ' +
    '{"actions":[{"targetId":"...","profilePath":"internships[0].company","operation":"text","confidence":0.95}]}。';

  function isCatalogPath(path) {
    const template = String(path || '').replace(/\[\d+\]/g, '[i]');
    return PATH_CATALOG.some(([candidate]) => candidate === template);
  }

  function parseJsonMappings(content) {
    const jsonText = String(content || '').replace(/```json|```/gi, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      const start = jsonText.indexOf('[');
      const end = jsonText.lastIndexOf(']');
      if (start < 0 || end < start) throw new Error('AI 返回中未找到 JSON');
      parsed = JSON.parse(jsonText.slice(start, end + 1));
    }
    if (Array.isArray(parsed)) return parsed;
    for (const key of ['mappings', 'plans', 'fields', 'actions']) {
      if (Array.isArray(parsed?.[key])) return parsed[key];
    }
    throw new Error('AI 返回的 JSON 缺少 mappings 数组');
  }

  async function callAI(payload, config) {
    // 内容脚本的跨域 fetch 受招聘网页的 CORS 限制；真实扩展统一交给后台请求。
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.runtime?.sendMessage) {
      const reply = await chrome.runtime.sendMessage({ type: 'ai-request', payload });
      if (!reply?.ok) throw new Error(reply?.error || 'AI 请求失败');
      recordUsage(reply.data);
      return reply.data;
    }
    // Node 单测与无扩展上下文的本地页面测试。
    const res = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const data = await res.json();
    recordUsage(data);
    return data;
  }

  function recordUsage(data) {
    usage.calls += 1;
    usage.inputTokens += Number(data?.usage?.prompt_tokens ?? data?.usage?.input_tokens) || 0;
    usage.outputTokens += Number(data?.usage?.completion_tokens ?? data?.usage?.output_tokens) || 0;
  }

  /**
   * 调用大模型 API 获取字段映射建议
   * @param {Array<{i:number,label:string,placeholder?:string,aria?:string,name?:string,options?:string[]}>} descriptors
   * @param {object} config { endpoint, apiKey, model }
   * @returns {Promise<Array<{i:number,path:string|null,confidence?:number}>>}
   */
  async function mapFields(descriptors, config) {
    if (!config || !config.endpoint || !config.apiKey) throw new Error('AI 未配置');
    const payload = {
      model: config.model || 'glm-4-flash',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            fields: descriptors.map((d) => ({
              i: d.i,
              label: d.label,
              placeholder: d.placeholder,
              aria: d.aria,
              name: d.name,
              role: d.role,
              componentType: d.componentType,
              section: d.section,
              itemIndex: d.itemIndex,
              semanticName: d.semanticName,
              fingerprint: d.fingerprint,
              options: (d.options || []).slice(0, 12),
            })),
            paths: PATH_CATALOG.map(([p, zh]) => p + ' ' + zh),
          }),
        },
      ],
    };
    // DeepSeek 原生支持 OpenAI Chat Completions。映射任务关闭思考模式以减少延迟，
    // 并要求 JSON 输出；其他兼容服务仍沿用宽松文本解析，避免破坏已有配置。
    if (config.provider === 'deepseek' || /api\.deepseek\.com/i.test(config.endpoint)) {
      payload.thinking = { type: 'disabled' };
      payload.response_format = { type: 'json_object' };
    }
    const data = await callAI(payload, config);
    const content = (data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '') || '';
    const parsed = parseJsonMappings(content);
    return parsed.map((suggestion) => {
      if (!suggestion || suggestion.path == null || suggestion.path === 'null') return suggestion;
      const descriptor = descriptors[suggestion.i];
      let path = String(suggestion.path);
      if (/\[i\]/.test(path) && Number.isInteger(descriptor?.itemIndex)) {
        path = path.replace(/\[i\]/g, `[${descriptor.itemIndex}]`);
      }
      return { ...suggestion, path: isCatalogPath(path) && !/\[i\]/.test(path) ? path : null };
    });
  }

  function tableArrayName(array) {
    return ({ internship: 'internships', project: 'projects' }[array] || array || '').toLowerCase();
  }

  function projectProfile(profile, includeSensitive) {
    const projected = JSON.parse(JSON.stringify(profile || {}));
    delete projected._说明;
    delete projected.mappings;
    if (!includeSensitive && projected.personal) {
      for (const key of ['phone', 'email', 'idCard', 'address', 'hukou', 'emergencyContact', 'emergencyContactPhone']) {
        delete projected.personal[key];
      }
    }
    return projected;
  }

  const SMART_OPERATIONS = new Set([
    'text', 'textarea', 'native-select', 'custom-select', 'radio', 'checkbox',
    'date-input', 'month-picker', 'date-range-picker', 'auto',
  ]);
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

  /** 将网页结构和简历内容一次性交给模型,返回受限的高层操作计划。 */
  async function planForm(page, profile, config) {
    if (!config || !config.endpoint || !config.apiKey) throw new Error('AI 未配置');
    if (config.includeProfile !== true) throw new Error('请在 AI 设置中允许发送简历内容');
    const payload = {
      model: config.model || 'glm-4-flash',
      temperature: 0,
      messages: [
        { role: 'system', content: SMART_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({ page, profile: projectProfile(profile, config.includeSensitive !== false), paths: PATH_CATALOG.map(([p, zh]) => p + ' ' + zh) }),
        },
      ],
    };
    if (config.provider === 'deepseek' || /api\.deepseek\.com/i.test(config.endpoint)) {
      payload.thinking = { type: 'disabled' };
      payload.response_format = { type: 'json_object' };
    }
    const data = await callAI(payload, config);
    const content = (data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '') || '';
    const actions = parseJsonMappings(content);
    const targets = new Map();
    for (const f of page.fields || []) targets.set(String(f.targetId), f);
    for (const table of page.tables || []) {
      for (const row of table.rows || []) {
        for (const f of row.fields || []) targets.set(String(f.targetId), { ...f, tableId: table.tableId, array: table.array, rowIndex: row.rowIndex });
      }
    }
    const candidates = actions.map((action) => {
      const targetId = String(action?.targetId || '');
      const target = targets.get(targetId);
      const path = String(action?.profilePath ?? action?.path ?? '');
      const operation = String(action?.operation || 'auto');
      if (!target || !path || !SMART_OPERATIONS.has(operation)) return null;
      const match = path.match(/^(education|internships|employment|projects|awards)\[(\d+)\]\.([A-Za-z][\w]*)$/);
      if (!isCatalogPath(path)) return null;
      if (target.tableId) {
        if (!match || match[1] !== tableArrayName(target.array)) return null;
        if (!Array.isArray(profile?.[match[1]]) || !profile[match[1]][Number(match[2])]) return null;
      }
      return { targetId, profilePath: path, operation, confidence: action.confidence,
        tableId: target.tableId, rowIndex: target.rowIndex, recordIndex: match ? Number(match[2]) : null };
    }).filter(Boolean);
    // 同一网页行只能取自一条简历记录；不同网页行不能共享同一记录。
    // 模型给出冲突计划时保守拒绝冲突行，避免公司、内容和日期串行。
    const rowRecords = new Map();
    for (const action of candidates) {
      if (!action.tableId) continue;
      const rowKey = `${action.tableId}:${action.rowIndex}`;
      if (!rowRecords.has(rowKey)) rowRecords.set(rowKey, new Set());
      rowRecords.get(rowKey).add(action.recordIndex);
    }
    const acceptedRows = new Map(Array.from(rowRecords).filter(([, records]) => records.size === 1)
      .map(([rowKey, records]) => [rowKey, [...records][0]]));
    const recordRows = new Map();
    for (const [rowKey, index] of acceptedRows) {
      const tableId = rowKey.slice(0, rowKey.lastIndexOf(':'));
      const key = `${tableId}:${index}`;
      recordRows.set(key, (recordRows.get(key) || 0) + 1);
    }
    return candidates.filter((action) => {
      if (!action.tableId) return true;
      const rowKey = `${action.tableId}:${action.rowIndex}`;
      return acceptedRows.get(rowKey) === action.recordIndex && recordRows.get(`${action.tableId}:${action.recordIndex}`) === 1;
    }).map(({ tableId, rowIndex, recordIndex, ...action }) => action);
  }

  const REPAIR_PROMPT =
    '你是网页表单操作诊断器。给定目标字段、期望值、局部 HTML、可操作节点和历史动作，选择下一步唯一动作。' +
    '只操作目标字段或其弹出面板，不能提交、删除、跳转或执行任意代码。若值已正确返回 done；无法判断返回 manual。' +
    '日期选择可以逐步打开面板、选年、选月、确认，每一步后会收到新页面状态。' +
    '只输出 JSON 对象，例如 {"type":"click","nodeId":"n2"}；允许 type 为 click、type、scroll、key、done、manual。' +
    'type 动作还需 value；scroll 动作还需 direction(up/down)；key 仅允许 Enter、Escape、Tab。';

  /** 只让模型选受约束的 UI 动作；目标节点必须来自本轮观察。 */
  async function nextAction(observation, desired, trace, config) {
    if (!config || !config.endpoint || !config.apiKey) throw new Error('AI 未配置');
    const payload = {
      model: config.model || 'glm-4-flash', temperature: 0,
      messages: [
        { role: 'system', content: REPAIR_PROMPT },
        { role: 'user', content: JSON.stringify({ desired, observation: observation.page, trace: (trace || []).slice(-6) }) },
      ],
    };
    if (config.provider === 'deepseek' || /api\.deepseek\.com/i.test(config.endpoint)) {
      payload.thinking = { type: 'disabled' };
      payload.response_format = { type: 'json_object' };
    }
    const data = await callAI(payload, config);
    const raw = String(data?.choices?.[0]?.message?.content || '').replace(/```json|```/gi, '').trim();
    const action = JSON.parse(raw);
    const type = String(action?.type || '');
    if (!['click', 'type', 'scroll', 'key', 'done', 'manual'].includes(type)) throw new Error('AI 返回了不允许的动作');
    if (['click', 'type', 'scroll', 'key'].includes(type) && !observation.nodes.has(String(action.nodeId))) throw new Error('AI 选择了不存在的节点');
    if (type === 'type' && typeof action.value !== 'string') throw new Error('AI 输入值无效');
    if (type === 'scroll' && !['up', 'down'].includes(action.direction)) throw new Error('AI 滚动方向无效');
    if (type === 'key' && !['Enter', 'Escape', 'Tab'].includes(action.key)) throw new Error('AI 按键无效');
    return { type, nodeId: action.nodeId == null ? undefined : String(action.nodeId), value: action.value, direction: action.direction, key: action.key };
  }

  /** 按整张经历表规划字段路由,只接收结构元数据,不接收档案值或页面输入值。 */
  async function planTables(tables, config) {
    if (!config || !config.endpoint || !config.apiKey) throw new Error('AI 未配置');
    const payload = {
      model: config.model || 'glm-4-flash',
      temperature: 0,
      messages: [
        { role: 'system', content: TABLE_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ tables }) },
      ],
    };
    if (config.provider === 'deepseek' || /api\.deepseek\.com/i.test(config.endpoint)) {
      payload.thinking = { type: 'disabled' };
      payload.response_format = { type: 'json_object' };
    }
    const data = await callAI(payload, config);
    const content = (data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '') || '';
    const parsed = parseJsonMappings(content);
    const knownTables = new Map((tables || []).map((t) => [String(t.tableId), t]));
    return parsed.map((suggestion) => {
      if (!suggestion) return null;
      const tableId = String(suggestion.tableId ?? suggestion.table ?? '');
      const table = knownTables.get(tableId);
      const row = Number(suggestion.row ?? suggestion.rowIndex);
      const field = Number(suggestion.field ?? suggestion.fieldIndex);
      if (!table || !Number.isInteger(row) || !Number.isInteger(field)) return null;
      const rowData = table.rows && table.rows[row];
      const fieldData = rowData && rowData.fields && rowData.fields[field];
      if (!rowData || !fieldData || suggestion.path == null || suggestion.path === 'null') return null;
      let path = String(suggestion.path);
      if (/\[i\]/.test(path)) path = path.replace(/\[i\]/g, `[${rowData.rowIndex}]`);
      const match = path.match(/^(education|internships|employment|projects|awards)\[(\d+)\]\.([A-Za-z][\w]*)$/);
      if (!match || match[1] !== tableArrayName(table.array) || Number(match[2]) !== Number(rowData.rowIndex)) return null;
      if (!isCatalogPath(path)) return null;
      return { tableId, row, field, path, confidence: suggestion.confidence };
    }).filter(Boolean);
  }

  const AIMapping = { mapFields, planTables, planForm, nextAction, getUsage: () => ({ ...usage }), PATH_CATALOG, SYSTEM_PROMPT, TABLE_SYSTEM_PROMPT, SMART_SYSTEM_PROMPT };
  root.AIMapping = AIMapping;
  if (typeof module !== 'undefined' && module.exports) module.exports = AIMapping;
})(typeof globalThis !== 'undefined' ? globalThis : this);
