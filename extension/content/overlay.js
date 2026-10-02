/**
 * overlay.js — 页面内预览面板与编排入口
 * ResumeAutofill.preview(profile):扫描 → 渲染预览(敏感值脱敏)→ 返回摘要
 * ResumeAutofill.fill():按预览结果填充 → 渲染报告(敏感值脱敏)→ 返回报告
 * 面板使用 shadow DOM 隔离样式;绝不自动提交表单。
 * 依赖:mask.js / matcher.js / scanner.js / filler.js 已先注入。
 */
(function () {
  'use strict';
  const Mask = globalThis.Mask;

  const HOST_ID = '__resume_autofill_host__';
  let lastScan = null;
  let lastProfile = null;
  let lastReport = null;
  const aiPlanCache = globalThis.__resumeAiPlanCache || (globalThis.__resumeAiPlanCache = new Map());

  function ensurePanel() {
    let host = document.getElementById(HOST_ID);
    if (host) return host.shadowRoot;
    host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: "Microsoft YaHei", system-ui, sans-serif; }
        .panel {
          position: fixed; top: 16px; right: 16px; width: 360px; max-height: 82vh;
          background: #fff; color: #1f2329; border-radius: 12px; z-index: 2147483647;
          box-shadow: 0 8px 32px rgba(0,0,0,.22); display: flex; flex-direction: column;
          font-size: 13px; line-height: 1.5; border: 1px solid #e5e6eb;
        }
        .hd { display:flex; align-items:center; justify-content:space-between; padding: 12px 16px; border-bottom:1px solid #f0f1f3; }
        .hd b { font-size:14px; }
        .hd .sub { color:#86909c; font-size:12px; margin-left:8px; }
        .close { cursor:pointer; border:none; background:none; font-size:16px; color:#86909c; }
        .bd { overflow:auto; padding: 8px 16px 12px; }
        .sec { margin: 8px 0 2px; font-weight: 600; color:#4e5969; font-size:12px; }
        .item { display:flex; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px dashed #f2f3f5; }
        .item .k { color:#4e5969; flex: 0 0 auto; max-width: 46%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .item .v { color:#1f2329; text-align:right; word-break: break-all; cursor: default; }
        .item .v.sensitive { cursor: pointer; }
        .item.miss .v { color:#86909c; }
        .ok { color:#00b42a; } .warn { color:#ff7d00; } .skip { color:#86909c; } .bad { color:#f53f3f; }
        .ft { padding: 12px 16px; border-top:1px solid #f0f1f3; display:flex; gap:8px; align-items:center; }
        .btn { flex:1; padding:8px 0; border-radius:8px; border:none; cursor:pointer; font-size:13px; }
        .primary { background:#165dff; color:#fff; }
        .primary:hover { background:#4080ff; }
        .ghost { background:#f2f3f5; color:#4e5969; flex:0 0 auto; padding:8px 14px; }
        .note { font-size:12px; color:#86909c; margin-top:8px; }
        .badge { display:inline-block; padding:0 6px; border-radius:8px; font-size:11px; }
        .b-ok { background:#e8ffea; color:#00b42a; } .b-skip { background:#f2f3f5; color:#86909c; }
        .b-warn { background:#fff7e8; color:#ff7d00; } .b-bad { background:#ffece8; color:#f53f3f; }
        .empty { color:#86909c; padding: 12px 0; }
      </style>
      <div class="panel" id="panel">
        <div class="hd">
          <div><b>简历闪填</b><span class="sub" id="sum"></span></div>
          <button class="close" id="btn-close" title="关闭">✕</button>
        </div>
        <div class="bd" id="bd"></div>
        <div class="ft">
          <button class="btn primary" id="btn-fill">开始填充</button>
          <button class="btn ghost" id="btn-learn" style="flex:0 0 auto;padding:8px 14px" title="把当前表单的最终填写结果学习进档案">学习此表</button>
          <button class="btn ghost" id="btn-hide">关闭</button>
        </div>
        <div class="note" style="padding:0 16px 12px">仅填充不提交:请人工核对后自行点击网站提交按钮。</div>
      </div>`;
    shadow.getElementById('btn-close').addEventListener('click', removePanel);
    shadow.getElementById('btn-hide').addEventListener('click', removePanel);
    shadow.getElementById('btn-learn').addEventListener('click', async () => {
      const btn = shadow.getElementById('btn-learn');
      btn.disabled = true;
      btn.textContent = '学习中…';
      try {
        const r = await ResumeAutofill.learn();
        btn.textContent = r && r.error ? ('学习失败:' + r.error) : '学习此表';
        if (r && !r.error && typeof r.learned === 'number') {
          btn.textContent = '学习此表(+' + r.learned + ')';
          renderPreview(lastScan, lastProfile);
        }
      } catch (e) {
        btn.textContent = '学习失败';
      }
      btn.disabled = false;
    });
    shadow.getElementById('btn-fill').addEventListener('click', async () => {
      const r = await ResumeAutofill.fill();
      renderReport(r);
    });
    return shadow;
  }

  function removePanel() {
    const host = document.getElementById(HOST_ID);
    if (host) host.remove();
  }

  function el(shadow, tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 敏感值点击临时显示,再点恢复脱敏。 */
  function sensitiveValueNode(shadow, raw, masked) {
    const v = el(shadow, 'span', 'v sensitive', masked);
    v.title = '敏感信息已脱敏,点击临时显示';
    v.addEventListener('click', () => {
      const showing = v.dataset.show === '1';
      v.textContent = showing ? masked : raw;
      v.dataset.show = showing ? '0' : '1';
    });
    return v;
  }

  /** 值的展示形式:敏感字段脱敏。 */
  function displayOf(path, value) {
    const s = String(value == null ? '' : value);
    return Mask.isSensitive(path) ? Mask.maskValue(path, s) : s;
  }

  function isSensitivePath(path) {
    return Mask.isSensitive(path || '');
  }

  function guessTypeOfPath(p) {
    const leaf = String(p || '').split('.').pop();
    if (leaf === 'birthDate') return 'date';
    if (/Date$/.test(leaf)) return 'month';
    if (/^(degree|fullTime|politicalStatus|ethnicity|englishLevel)$/.test(leaf)) return 'custom-select';
    return 'text';
  }

  function aiTableArray(array) {
    return ({ internship: 'internships', project: 'projects' }[array] || array || '').toLowerCase();
  }

  function aiDescriptor(source, fieldIndex, existingPath, label, targetId) {
    const target = source.trigger || source.el;
    const attr = (a) => (target && target.getAttribute ? target.getAttribute(a) : null);
    const controlled = attr('aria-controls') ? document.getElementById(attr('aria-controls')) : null;
    const optionRoot = target && target.tagName === 'SELECT' ? target : controlled;
    const context = source.rowContainer || target?.closest?.('[data-cy], [class*="form-item"], [class*="FormItem"]') || target?.parentElement;
    return {
      fieldIndex,
      targetId,
      label: label || source.label || attr('data-form-field-i18n-name') || undefined,
      placeholder: attr('placeholder') || undefined,
      aria: attr('aria-label') || undefined,
      name: attr('data-form-field-name') || attr('name') || attr('id') || undefined,
      role: attr('role') || undefined,
      componentType: source.type || source.kind || undefined,
      existingPath: existingPath || undefined,
      recordIndex: source.recordIndex,
      semanticName: source.identity?.leaf || undefined,
      fingerprint: source.fingerprint || undefined,
      section: source.section || undefined,
      itemIndex: source.itemIndex ?? source.identity?.index ?? undefined,
      currentValue: globalThis.Components?.readControlValues(target).join(' ~ ') || (target && 'value' in target ? String(target.value || '') : String(target?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180)),
      contextText: String(context?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 320),
      html: String(target?.parentElement?.outerHTML || target?.outerHTML || '').slice(0, 1200),
      options: optionRoot
        ? Array.from(optionRoot.querySelectorAll('option, [role="option"], li')).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 20)
        : undefined,
    };
  }

  /** 将完整经历行整理成 AI 可理解的表格，同时保留 DOM 对象到结果的本地引用。 */
  function buildAiTables(scan) {
    const tableMap = new Map();
    const refs = new Map();
    const targetRefs = new Map();
    const getTable = (array) => {
      const tableId = aiTableArray(array);
      if (!tableMap.has(tableId)) tableMap.set(tableId, { tableId, array: tableId, rows: [] });
      if (!refs.has(tableId)) refs.set(tableId, []);
      return tableMap.get(tableId);
    };
    const getRow = (table, rowIndex) => {
      let row = table.rows.find((r) => Number(r.rowIndex) === Number(rowIndex));
      if (!row) {
        row = { rowIndex, fields: [] };
        table.rows.push(row);
        table.rows.sort((a, b) => a.rowIndex - b.rowIndex);
      }
      const tableRefs = refs.get(table.tableId);
      let rowRefs = tableRefs.find((r) => Number(r.rowIndex) === Number(rowIndex));
      if (!rowRefs) {
        rowRefs = { rowIndex, fields: [] };
        tableRefs.push(rowRefs);
        tableRefs.sort((a, b) => a.rowIndex - b.rowIndex);
      }
      return { row, rowRefs };
    };
    const add = (table, rowIndex, source, label, existingPath, slot = null, refKind = 'field') => {
      const { row, rowRefs } = getRow(table, rowIndex);
      const fieldIndex = row.fields.length;
      const targetId = `${table.tableId}:${rowIndex}:${fieldIndex}`;
      row.fields.push(aiDescriptor(source, fieldIndex, existingPath, label, targetId));
      rowRefs.fields.push({ source, slot, kind: refKind, targetId });
      targetRefs.set(targetId, { source, slot, kind: refKind, tableId: table.tableId, rowIndex });
    };

    for (const row of scan.rows || []) {
      const table = getTable(row.array);
      const rowIndex = Number.isInteger(row.index) ? row.index : table.rows.length;
      for (const item of row.items || []) add(table, rowIndex, item, item.label, item.path, null, 'row');
    }
    for (const source of scan.unmatched || []) {
      if (source.excluded) continue;
      if (!source.rowContainer) continue;
      const row = (scan.rows || []).find((r) => r.container === source.rowContainer);
      if (!row) continue;
      const table = getTable(row.array);
      const rowIndex = Number.isInteger(source.rowIndex) ? source.rowIndex : row.index;
      add(table, rowIndex, source, source.label, source.path, null, 'unmatched');
    }
    for (const source of scan.fields || []) {
      if (!source.rowScoped || !source.rowContainer) continue;
      const row = (scan.rows || []).find((r) => r.container === source.rowContainer);
      if (!row) continue;
      const table = getTable(row.array);
      const rowIndex = Number.isInteger(source.rowIndex) ? source.rowIndex : row.index;
      const paths = Array.isArray(source.paths) ? source.paths : [];
      const isRange = source.type === Matcher.T.CUSTOM_PICKER && (paths.length === 2 || /起止|范围|range/i.test(source.label || ''));
      if (isRange) {
        add(table, rowIndex, source, `${source.label || '日期'} 开始`, paths[0], 0);
        add(table, rowIndex, source, `${source.label || '日期'} 结束`, paths[1], 1);
      } else add(table, rowIndex, source, source.label, source.path, null);
    }
    return { tables: Array.from(tableMap.values()).filter((t) => t.rows.some((r) => r.fields.length)), refs, targetRefs };
  }

  function buildAiPage(scan) {
    const built = buildAiTables(scan);
    const fields = [];
    const targetRefs = new Map(built.targetRefs);
    const addField = (source, label, existingPath, slot = null) => {
      const targetId = `field:${fields.length}`;
      const descriptor = aiDescriptor(source, fields.length, existingPath, label, targetId);
      fields.push(descriptor);
      targetRefs.set(targetId, { source, slot, kind: 'field' });
    };
    for (const source of scan.fields || []) {
      if (source.rowScoped) continue;
      const paths = Array.isArray(source.paths) ? source.paths : [];
      const isRange = source.type === Matcher.T.CUSTOM_PICKER && (paths.length === 2 || /起止|范围|range/i.test(source.label || ''));
      if (isRange) {
        addField(source, `${source.label || '日期'} 开始`, paths[0], 0);
        addField(source, `${source.label || '日期'} 结束`, paths[1], 1);
      } else addField(source, source.label, source.path, null);
    }
    for (const source of scan.unmatched || []) {
      if (source.excluded) continue;
      if (source.rowContainer) continue;
      addField(source, source.label, source.path, null);
    }
    return { page: { fields, tables: built.tables }, targetRefs };
  }

  /** 扫描 + 渲染预览(同步入口) */
  function preview(profile) {
    return renderPreview(globalThis.Scanner.scan(), profile);
  }

  /** 预览前应用站点记忆:同站已确认过的字段映射直接生效(纯本地) */
  async function previewWithMappings(profile) {
    const scan = globalThis.Scanner.scan();
    try {
      const host = location.hostname;
      const st = await chrome.storage.local.get('siteMappings');
      const siteMap = (st.siteMappings || {})[host] || {};
      for (let i = scan.unmatched.length - 1; i >= 0; i--) {
        const u = scan.unmatched[i];
        if (u.excluded) continue;
        const legacyKey = globalThis.Matcher.normalize(u.label || '');
        const key = u.fingerprint || legacyKey;
        const p = siteMap[key] || siteMap[legacyKey];
        if (p) {
          scan.fields.push({ ...u, reason: undefined, label: u.label || key, path: p, type: u.type || guessTypeOfPath(p), score: 60 });
          scan.unmatched.splice(i, 1);
        }
      }
      // 表格级 AI 规划也写入站点记忆;下次扫描时优先覆盖机械规则给出的行路径。
      for (const row of scan.rows || []) {
        for (const item of row.items || []) {
          const legacyKey = globalThis.Matcher.normalize(item.label || '');
          const key = item.fingerprint || legacyKey;
          const p = siteMap[key] || siteMap[legacyKey];
          if (typeof p === 'string' && p) { item.path = p; scan.__aiPlanned = true; }
        }
      }
    } catch {}
    let summary = renderPreview(scan, profile);
    try {
      const { aiConfig } = await chrome.storage.local.get('aiConfig');
      if (aiConfig?.endpoint && aiConfig?.apiKey && aiConfig?.includeProfile === true) {
        const planned = await ResumeAutofill.aiSmartPlan();
        if (!planned.error && planned.applied) summary = renderPreview(lastScan, profile);
        summary.ai = planned;
      }
    } catch (error) {
      summary.ai = { error: String(error?.message || error) };
    }
    return summary;
  }

  /**
   * 扫描并渲染预览。返回给 popup 的 JSON 摘要(不含 DOM 引用)。
   */
  function renderPreview(scan, profile) {
    globalThis.Filler.bindEducationRecords(scan, profile);
    lastProfile = profile;
    lastScan = scan;
    lastReport = null;
    const shadow = ensurePanel();
    const bd = shadow.getElementById('bd');
    bd.innerHTML = '';

    let matched = 0;
    const summary = { fields: [], groups: [], rows: [], unmatched: [], counts: {} };

    // 普通字段
    const sec1 = el(shadow, 'div', 'sec', '基本信息');
    if (scan.fields.length) bd.appendChild(sec1);
    for (const f of scan.fields) {
      const value = f.paths
        ? f.paths.map((p) => globalThis.Filler.resolveValue(profile, p)).filter((v) => v != null && v !== '').join(' ~ ')
        : globalThis.Filler.resolveValue(profile, f.path);
      const row = el(shadow, 'div', 'item');
      row.appendChild(el(shadow, 'span', 'k', f.label || f.path));
      if (value == null || value === '') {
        row.appendChild(el(shadow, 'span', 'v skip', '档案中无值'));
      } else {
        matched += 1;
        if (isSensitivePath(f.path)) {
          row.appendChild(sensitiveValueNode(shadow, String(value), displayOf(f.path, value)));
        } else {
          row.appendChild(el(shadow, 'span', 'v', String(value)));
        }
        summary.fields.push({ label: f.label, path: f.path });
      }
      bd.appendChild(row);
    }

    // 经历行
    for (const rowItem of scan.rows) {
    const nameMap = { education: '教育经历', internship: '实习经历', employment: '工作经历', project: '项目经历', award: '获奖经历' };
      bd.appendChild(el(shadow, 'div', 'sec', `${nameMap[rowItem.array] || rowItem.array}`));
      for (const item of rowItem.items) {
        const value = globalThis.Filler.resolveValue(profile, item.path);
        const line = el(shadow, 'div', 'item');
        line.appendChild(el(shadow, 'span', 'k', `${item.label || item.path}`));
        if (value == null || value === '') {
          line.appendChild(el(shadow, 'span', 'v skip', '—'));
        } else {
          matched += 1;
          summary.rows.push({ label: item.label, path: item.path });
          line.appendChild(el(shadow, 'span', 'v', value.length > 40 ? value.slice(0, 40) + '…' : String(value)));
        }
        bd.appendChild(line);
      }
    }

    // 选项组(radio/checkbox)与筛选题
    if (scan.groups.length) bd.appendChild(el(shadow, 'div', 'sec', '选择题 / 筛选题'));
    for (const g of scan.groups) {
      const line = el(shadow, 'div', 'item');
      line.appendChild(el(shadow, 'span', 'k', (g.label || '未命名选项组').slice(0, 60)));
      let will = '—';
      if (g.kind === 'checkbox-group' && g.path) {
        const v = globalThis.Filler.resolveValue(profile, g.path);
        will = Array.isArray(v) ? v.join('、') : v == null ? '档案中无值' : String(v);
      } else if (g.kind === 'radio' && g.qaMatch) {
        const qa = globalThis.Matcher.matchQuestion(g.qaMatch.question, profile);
        will = qa ? `答:${qa.value}` : '未配置答案';
      } else if (g.path) {
        const v = globalThis.Filler.resolveValue(profile, g.path);
        will = v == null ? '档案中无值' : String(v);
      }
      const span = el(shadow, 'span', 'v', String(will).slice(0, 40));
      line.appendChild(span);
      bd.appendChild(line);
      summary.groups.push({ label: g.label, path: g.path || null, qa: !!g.qaMatch });
    }

    // 未匹配 + AI 兜底入口
    if (scan.unmatched.length) {
      bd.appendChild(el(shadow, 'div', 'sec warn', `未匹配 ${scan.unmatched.length} 项(请手动填写)`));
      for (const u of scan.unmatched) {
        const line = el(shadow, 'div', 'item miss');
        line.appendChild(el(shadow, 'span', 'k', (u.label || '未识别 label').slice(0, 30)));
        line.appendChild(el(shadow, 'span', 'v', '待手动'));
        bd.appendChild(line);
      }
      const hasRows = scan.rows && scan.rows.length > 0;
      const aiBtn = el(shadow, 'button', 'btn ghost', hasRows ? `AI 智能理解 ${scan.rows.length} 张经历表` : `AI 识别这 ${scan.unmatched.length} 项`);
      aiBtn.style.marginTop = '8px';
      aiBtn.addEventListener('click', async () => {
        aiBtn.disabled = true;
        aiBtn.textContent = 'AI 识别中…';
        try {
          const r = await (hasRows ? ResumeAutofill.aiSmartPlan() : ResumeAutofill.aiMapUnmatched());
          if (r && r.error) { aiBtn.textContent = r.error; aiBtn.disabled = false; return; }
          renderPreview(lastScan, lastProfile);
        } catch (e) {
          aiBtn.textContent = 'AI 失败:' + (e.message || e);
          aiBtn.disabled = false;
        }
      });
      bd.appendChild(aiBtn);
    }

    if (!scan.unmatched.length && scan.rows && scan.rows.length) {
      const aiBtn = el(shadow, 'button', 'btn ghost', `AI 智能理解 ${scan.rows.length} 张经历表`);
      aiBtn.style.marginTop = '8px';
      aiBtn.addEventListener('click', async () => {
        aiBtn.disabled = true;
        aiBtn.textContent = 'AI 理解中…';
        try {
          const r = await ResumeAutofill.aiSmartPlan();
          if (r && r.error) { aiBtn.textContent = r.error; aiBtn.disabled = false; return; }
          renderPreview(lastScan, lastProfile);
        } catch (e) {
          aiBtn.textContent = 'AI 失败:' + (e.message || e);
          aiBtn.disabled = false;
        }
      });
      bd.appendChild(aiBtn);
    }

    if (!bd.children.length) {
      bd.appendChild(el(shadow, 'div', 'empty', '本页未发现可填写的表单字段'));
    }

    const rowItemCount = scan.rows.reduce((n, r) => n + r.items.length, 0);
    const total = scan.fields.length + rowItemCount + scan.unmatched.length;
    shadow.getElementById('sum').textContent = `匹配 ${matched} 项 / 共 ${total} 项`;
    const fillBtn = shadow.getElementById('btn-fill');
    fillBtn.textContent = '开始填充';
    fillBtn.disabled = false;

    summary.counts = {
      matched,
      total,
      unmatched: scan.unmatched.length,
      rows: scan.rows.length,
      groups: scan.groups.length,
    };
    return summary;
  }

  /** 执行填充并渲染报告。增行后重扫一次再填行。 */
  async function fill() {
    if (!lastScan || !lastProfile) return { error: '请先扫描' };
    let aiConfig = null;
    try { aiConfig = (await chrome.storage.local.get('aiConfig')).aiConfig || null; } catch {}
    const existingGroups = new Set((lastScan.groups || []).flatMap((g) => g.els || []));
    const pass1 = await globalThis.Filler.fill(lastScan, lastProfile, { skipRows: true, aiConfig });
    let report = pass1.report;
    let addedRows = pass1.addedRows;
    if (pass1.addedRows > 0) {
      lastScan = globalThis.Scanner.scan();
      if (aiConfig?.endpoint && aiConfig?.apiKey && aiConfig?.includeProfile === true) {
        try { await ResumeAutofill.aiSmartPlan(); } catch {}
      }
    }
    const pass2 = await globalThis.Filler.fill(lastScan, lastProfile, {
      rowsOnly: true,
      includeGroups: pass1.addedRows > 0,
      skipGroups: existingGroups,
      aiConfig,
    });
    report = report.concat(pass2.report);
    addedRows += pass2.addedRows;
    lastReport = report;
    const shadow = ensurePanel();
    const bd = shadow.getElementById('bd');
    bd.innerHTML = '';
    bd.appendChild(el(shadow, 'div', 'sec', '填充结果'));
    const ICON = { filled: ['b-ok', '已填'], kept: ['b-skip', '保留'], 'kept-mismatch': ['b-warn', '不一致'], 'no-value': ['b-skip', '无值'], 'no-option': ['b-warn', '无选项'], 'unmatched-question': ['b-warn', '未配置'], skipped: ['b-skip', '跳过'] };
    for (const r of report) {
      const [cls, txt] = ICON[r.status] || ['b-bad', r.status];
      const line = el(shadow, 'div', 'item');
      const k = el(shadow, 'span', 'k', r.label || r.path || '—');
      k.title = r.path || '';
      line.appendChild(k);
      const wrap = el(shadow, 'span', 'v');
      const badge = el(shadow, 'span', `badge ${cls}`, txt);
      wrap.appendChild(badge);
      if (r.value != null) {
        wrap.appendChild(document.createTextNode(' '));
        if (isSensitivePath(r.path) && r.status === 'filled') {
          // 报告里的敏感值:filler 已脱敏;这里提供点击显示原文的能力
          const raw = rawOf(r);
          wrap.appendChild(sensitiveValueNode(shadow, raw, r.value));
        } else {
          wrap.appendChild(document.createTextNode(r.value));
        }
      } else if (r.reason) {
        wrap.appendChild(document.createTextNode(' ' + r.reason));
      }
      line.appendChild(wrap);
      bd.appendChild(line);
    }
    if (addedRows > 0) bd.appendChild(el(shadow, 'div', 'note', `已通过页面"添加"按钮新增 ${addedRows} 行经历。`));
    const aiUsage = globalThis.AIMapping?.getUsage?.();
    if (aiUsage?.calls) bd.appendChild(el(shadow, 'div', 'note', `本页 AI 调用 ${aiUsage.calls} 次；接口报告输入 ${aiUsage.inputTokens}、输出 ${aiUsage.outputTokens} tokens（接口未返回用量时为 0）。`));
    bd.appendChild(el(shadow, 'div', 'note', '填充完成。请逐项核对后再自行提交,本工具不会替你提交。'));
    shadow.getElementById('btn-fill').textContent = '重新填充';
    return { report, addedRows };
  }

  /** 从上次扫描中找到报告行对应的原值(用于点击显示)。 */
  function rawOf(r) {
    const p = lastProfile;
    if (!p || !r.path) return r.value;
    try {
      const v = globalThis.Filler.resolveValue(p, r.path);
      return v == null ? r.value : String(v);
    } catch {
      return r.value;
    }
  }


  /** 读取字段当前 UI 最终值(input 值或展示文本) */
  function readUIValue(f) {
    const t = f && (f.trigger || f.el);
    if (!t || !t.querySelector) return '';
    try {
      const inp = t.querySelector('input, textarea');
      const disp = t.querySelector('[class*="display-value"], [class*="selection-item"], [class*="selected-item"]');
      return String(((inp && (inp.value || inp.placeholder)) || (disp && disp.textContent) || '')).trim();
    } catch { return ''; }
  }

  /** 字段结构指纹:组件类型 + 子控件占位符序列 + 是否搜索型 */
  function readStructure(f) {
    const t = f && (f.trigger || f.el);
    if (!t || !t.querySelector) return null;
    try {
      const type = f.type || 'text';
      const structure = { component: type, subs: [], searchable: false };
      const subs = Array.from(t.querySelectorAll('[class*="sd-Select-container-"], [class*="select__selector"], [class*="picker"], select')).slice(0, 8);
      for (const s of subs) {
        const inp = s.querySelector('input');
        const ph = (inp && inp.placeholder) || '';
        structure.subs.push(ph || (s.tagName === 'SELECT' ? 'native-select' : ''));
      }
      const ownInput = t.matches('input') ? t : t.querySelector('input');
      structure.searchable = !!(ownInput && !ownInput.readOnly && !structure.subs.filter(Boolean).length && !/date|picker/i.test(String(type)));
      return structure;
    } catch { return null; }
  }

  /** 档案叶子展开:path → value(含 qa) */
  function flattenProfile(profile) {
    const out = [];
    const walk = (obj, prefix) => {
      if (obj == null || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue;
        const p = prefix ? prefix + '.' + k : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
        else if (Array.isArray(v)) v.forEach((x, i) => x && typeof x === 'object' ? walk(x, p + '[' + i + ']') : out.push({ path: p + '[' + i + ']', value: x }));
        else if (v !== '' && v != null) out.push({ path: p, value: v });
      }
    };
    walk(profile, '');
    return out;
  }

  /**
   * 学习当前表单:以字段最终值为准,推断 label→档案路径,双写
   * siteMappings(即时生效) 与 profile.learned(档案新字段,导出随 JSON 走)。
   * 规则学习:值能唯一对上档案;AI 学习(可选):对不上的字段带值调 planForm。
   */
  async function learnFromFilledForm() {
    if (!lastProfile) return { error: '请先扫描' };
    const host = location.hostname;
    const scan = globalThis.Scanner.scan();
    const flat = flattenProfile(lastProfile);
    const norm = (s) => globalThis.Matcher.normalize(String(s == null ? '' : s));
    const eq = (a, b) => {
      const na = norm(a), nb = norm(b);
      if (!na || !nb) return false;
      if (na === nb) return true;
      // 日期等价:2021-09 / 2021/9 / 2021年9月 / 2021-09-01(月粒度)
      const da = String(a).match(/^(\d{4})[-\/年](\d{1,2})/), db = String(b).match(/^(\d{4})[-\/年](\d{1,2})/);
      if (da && db) return da[1] === db[1] && Number(da[2]) === Number(db[2]);
      return false;
    };
    const learned = [];
    const pending = [];
    for (const f of scan.fields) {
      const ui = readUIValue(f);
      if (!ui || ui.length > 300) continue;
      const label = String(f.label || '').trim();
      if (!label) continue;
      // 1) 该字段已有扫描路径且与现值一致 → 确认学习
      const curPath = f.path || (f.paths && f.paths[0]);
      if (curPath) {
        const hit = flat.find((x) => eq(x.value, ui) && x.path === curPath);
        if (hit) { learned.push({ label, path: curPath, value: ui, source: 'confirmed', structure: readStructure(f) }); continue; }
      }
      // 2) 值匹配档案:唯一命中则学;类型可分辨时按类型过滤
      let cands = flat.filter((x) => eq(x.value, ui));
      if (cands.length > 1) {
        const isDateField = f.type === 'custom-picker' || /时间|日期/.test(label);
        const filtered = cands.filter((x) => (isDateField ? /(Date|date)$/.test(x.path) : true));
        if (filtered.length) cands = filtered;
      }
      if (cands.length === 1) { learned.push({ label, path: cands[0].path, value: ui, source: 'value-match', structure: readStructure(f) }); continue; }
      // 3) 待 AI 推断
      pending.push(f);
    }
    // AI 学习(未配置则跳过)
    if (pending.length) {
      let cfg = null;
      try { cfg = (await chrome.storage.local.get('aiConfig')).aiConfig; } catch {}
      if (cfg && cfg.endpoint && cfg.apiKey) {
        try {
          const page = { fields: pending.map((f, i) => ({ targetId: 'L' + i, label: f.label, placeholder: '', type: f.type, userValue: readUIValue(f) })), tables: [] };
          const actions = await globalThis.AIMapping.planForm(page, lastProfile, cfg);
          const byId = new Map(page.fields.map((x) => [String(x.targetId), x]));
          for (const a of actions) {
            const t = byId.get(String(a && a.targetId));
            const p = String((a && (a.profilePath || a.path)) || '');
            const srcF = pending[Number(String(a.targetId || '').slice(1))] || f;
            if (t && p) learned.push({ label: t.label, path: p, value: t.userValue, source: 'ai', structure: readStructure(srcF) });
          }
        } catch (e) { /* AI 失败不影响规则学习结果 */ }
      }
    }
    if (!learned.length) return { learned: 0, pending: pending.length };
    // 双写:siteMappings + 档案对象新字段 learned
    const st = await chrome.storage.local.get(['siteMappings', 'profile']);
    const maps = st.siteMappings || {};
    const siteMap = maps[host] || (maps[host] = {});
    let prof = st.profile || lastProfile;
    prof.learned = prof.learned || {};
    const siteLearned = prof.learned[host] || (prof.learned[host] = {});
    for (const l of learned) {
      const key = norm(l.label);
      if (!key) continue;
      siteMap[key] = l.path;
      siteLearned[key] = { path: l.path, value: String(l.value).slice(0, 200), source: l.source, at: new Date().toISOString().slice(0, 10) };
      if (l.structure) siteLearned[key].structure = l.structure;
    }
    // 表结构 schema:区块顺序 + 每区块字段清单与行数(按学到的路径数组归类)
    const schema = { sections: [], learnedAt: new Date().toISOString().slice(0, 10) };
    const byArr = new Map();
    for (const l of learned) {
      const m = String(l.path || '').match(/^(education|internships|employment|projects|awards)\[(\d+)\]/);
      if (m) {
        const k = m[1];
        if (!byArr.has(k)) byArr.set(k, { array: k, rows: new Set(), fields: [] });
        const sec = byArr.get(k);
        sec.rows.add(Number(m[2]));
        if (!sec.fields.includes(l.label)) sec.fields.push(l.label);
      } else if (l.path && !/^personal\.|^derived\./.test(l.path)) {
        if (!byArr.has('_global')) byArr.set('_global', { array: '_global', rows: new Set(), fields: [] });
        byArr.get('_global').fields.push(l.label);
      }
    }
    for (const sec of byArr.values()) {
      if (sec.array === '_global') schema.sections.unshift({ array: 'global', fields: sec.fields });
      else schema.sections.push({ array: sec.array, rowCount: sec.rows.size, fields: sec.fields });
    }
    if (schema.sections.length) siteLearned.__schema = schema;
    maps[host] = siteMap;
    await chrome.storage.local.set({ siteMappings: maps, profile: prof });
    lastProfile = prof;
    return { learned: learned.length, pending: pending.length };
  }

  const ResumeAutofill = {
    preview: previewWithMappings,
    fill,
    learn: learnFromFilledForm,
    getReport: () => lastReport,
    /** AI 智能规划:把简历内容与整页结构一起分析,返回受限的高层操作计划。 */
    async aiSmartPlan() {
      if (!lastScan || !lastProfile) return { error: '请先扫描' };
      const built = buildAiPage(lastScan);
      if (!built.page.fields.length && !built.page.tables.length) return { applied: 0, total: 0 };
      let cfg = null;
      try {
        const st = await chrome.storage.local.get('aiConfig');
        cfg = st.aiConfig;
      } catch {}
      if (!cfg || !cfg.apiKey || !cfg.endpoint) return { error: '未配置 AI:请先在插件弹窗的「AI 设置」中填写' };
      if (cfg.includeProfile !== true) return { error: '请先在 AI 设置中勾选“允许 AI 读取简历内容”' };
      const cacheKey = JSON.stringify([location.origin, location.pathname, built.page, lastProfile]);
      const cached = aiPlanCache.has(cacheKey);
      const actions = cached ? aiPlanCache.get(cacheKey) : await globalThis.AIMapping.planForm(built.page, lastProfile, cfg);
      if (!cached && actions.length) {
        aiPlanCache.set(cacheKey, actions);
        while (aiPlanCache.size > 3) aiPlanCache.delete(aiPlanCache.keys().next().value);
      }
      const host = location.hostname;
      const st = await chrome.storage.local.get('siteMappings');
      const maps = st.siteMappings || {};
      const siteMap = maps[host] || (maps[host] = {});
      const promotedFields = new Map();
      let applied = 0;
      for (const action of actions) {
        if (action.confidence != null && action.confidence < 0.65) continue;
        const target = built.targetRefs.get(action.targetId);
        if (!target || !target.source) continue;
        const source = target.source;
        if (target.slot != null) {
          source.paths = Array.isArray(source.paths) ? source.paths : [null, null];
          source.paths[target.slot] = action.profilePath;
          source.path = source.paths.find(Boolean) || action.profilePath;
        } else source.path = action.profilePath;
        source.aiOperation = action.operation;
        if (target.kind === 'unmatched') {
          const row = source.rowContainer && lastScan.rows.find((r) => r.container === source.rowContainer);
          const custom = source.kind === 'custom' || source.type === Matcher.T.CUSTOM_SELECT || source.type === Matcher.T.CUSTOM_PICKER;
          if (custom) {
            let promoted = promotedFields.get(source);
            if (!promoted) {
              promoted = { ...source, reason: undefined, rowScoped: Boolean(row) };
              promotedFields.set(source, promoted);
              lastScan.fields.push(promoted);
            }
            promoted.path = source.path;
            promoted.paths = source.paths;
            promoted.aiOperation = source.aiOperation;
          } else if (row) {
            row.items.push({ ...source, reason: undefined, label: source.label || action.profilePath, path: source.path, type: source.type || guessTypeOfPath(action.profilePath), score: 50, aiOperation: source.aiOperation });
          } else {
            lastScan.fields.push({ ...source, reason: undefined, label: source.label || action.profilePath, path: source.path, type: source.type || guessTypeOfPath(action.profilePath), aiOperation: source.aiOperation });
          }
          const idx = lastScan.unmatched.indexOf(source);
          if (idx >= 0) lastScan.unmatched.splice(idx, 1);
        }
        const memoryKey = target.slot == null
          ? (source.fingerprint || globalThis.Matcher.normalize(source.label || ''))
          : `${source.fingerprint || globalThis.Matcher.normalize(source.label || '')}|slot:${target.slot}`;
        siteMap[memoryKey] = action.profilePath;
        applied += 1;
      }
      maps[host] = siteMap;
      await chrome.storage.local.set({ siteMappings: maps });
      if (applied > 0) lastScan.__aiPlanned = true;
      return { applied, total: actions.length, cached, usage: globalThis.AIMapping.getUsage() };
    },
    /** AI 整表理解:按记录行一次性路由字段,再交给原有确定性填充器执行。 */
    async aiPlanTables() {
      if (!lastScan || !lastProfile) return { error: '请先扫描' };
      const built = buildAiTables(lastScan);
      if (!built.tables.length) return { applied: 0, total: 0 };
      let cfg = null;
      try {
        const st = await chrome.storage.local.get('aiConfig');
        cfg = st.aiConfig;
      } catch {}
      if (!cfg || !cfg.apiKey || !cfg.endpoint) return { error: '未配置 AI:请先在插件弹窗的「AI 设置」中填写' };
      const suggestions = await globalThis.AIMapping.planTables(built.tables, cfg);
      const host = location.hostname;
      const st = await chrome.storage.local.get('siteMappings');
      const maps = st.siteMappings || {};
      const siteMap = maps[host] || (maps[host] = {});
      const promotedFields = new Map();
      let applied = 0;
      for (const s of suggestions) {
        if (s.confidence != null && s.confidence < 0.65) continue;
        const rowRefs = built.refs.get(s.tableId)?.[s.row];
        const target = rowRefs?.fields?.[s.field];
        if (!target || !target.source) continue;
        const source = target.source;
        if (target.kind === 'row') {
          source.path = s.path;
          source.type = source.type || guessTypeOfPath(s.path);
        } else if (target.kind === 'unmatched') {
          const row = lastScan.rows.find((r) => r.container === source.rowContainer);
          if (!row) continue;
          if (source.kind === 'custom' || source.type === Matcher.T.CUSTOM_SELECT || source.type === Matcher.T.CUSTOM_PICKER) {
            if (target.slot != null) {
              source.paths = Array.isArray(source.paths) ? source.paths : [null, null];
              source.paths[target.slot] = s.path;
              source.path = source.paths.find(Boolean) || s.path;
            } else source.path = s.path;
            let promoted = promotedFields.get(source);
            if (!promoted) {
              promoted = { ...source, reason: undefined, rowScoped: true };
              promotedFields.set(source, promoted);
              lastScan.fields.push(promoted);
            }
            promoted.path = source.path;
            promoted.paths = source.paths;
          } else {
            row.items.push({ ...source, reason: undefined, label: source.label || s.path, path: s.path, type: source.type || guessTypeOfPath(s.path), score: 50 });
          }
          const idx = lastScan.unmatched.indexOf(source);
          if (idx >= 0) lastScan.unmatched.splice(idx, 1);
        } else {
          if (target.slot != null) {
            source.paths = Array.isArray(source.paths) ? source.paths : [null, null];
            source.paths[target.slot] = s.path;
            source.path = source.paths.find(Boolean) || s.path;
          } else source.path = s.path;
        }
        source.score = Math.max(Number(source.score) || 0, 50);
        siteMap[source.fingerprint || globalThis.Matcher.normalize(source.label || '')] = s.path;
        applied += 1;
      }
      maps[host] = siteMap;
      await chrome.storage.local.set({ siteMappings: maps });
      // 表格规划不覆盖全局字段,例如单独的出生日期或个人主页仍走原有单字段兜底。
      const fallback = lastScan.unmatched.length ? await ResumeAutofill.aiMapUnmatched() : null;
      return { applied: applied + (fallback?.applied || 0), total: suggestions.length + (fallback?.total || 0) };
    },
    /** AI 兜底:把未匹配字段的描述发给大模型换回映射建议,自动应用非空建议并写入站点记忆 */
    async aiMapUnmatched() {
      if (!lastScan || !lastProfile) return { error: '请先扫描' };
      const un = lastScan.unmatched.filter((u) => u.el && !u.excluded);
      if (!un.length) return { applied: 0 };
      let cfg = null;
      try {
        const st = await chrome.storage.local.get('aiConfig');
        cfg = st.aiConfig;
      } catch {}
      if (!cfg || !cfg.apiKey || !cfg.endpoint) return { error: '未配置 AI:请先在插件弹窗的「AI 设置」中填写' };
      const descriptors = un.map((u, i) => {
        const attr = (a) => (u.el.getAttribute ? u.el.getAttribute(a) : null);
        const controlled = attr('aria-controls') ? document.getElementById(attr('aria-controls')) : null;
        const optionRoot = u.el.tagName === 'SELECT' ? u.el : controlled;
        return {
          i,
          label: u.label || attr('data-form-field-i18n-name') || undefined,
          placeholder: attr('placeholder') || undefined,
          aria: attr('aria-label') || undefined,
          name: attr('data-form-field-name') || attr('name') || attr('id') || undefined,
          role: attr('role') || undefined,
          componentType: u.type || u.kind || undefined,
          section: u.section || u.identity?.array || undefined,
          itemIndex: u.itemIndex ?? u.identity?.index,
          semanticName: u.identity?.leaf || undefined,
          fingerprint: u.fingerprint || undefined,
          options: optionRoot
            ? Array.from(optionRoot.querySelectorAll('option, [role="option"], li')).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 20)
            : undefined,
        };
      });
      const suggestions = await globalThis.AIMapping.mapFields(descriptors, cfg);
      const host = location.hostname;
      const st = await chrome.storage.local.get('siteMappings');
      const maps = st.siteMappings || {};
      const siteMap = maps[host] || (maps[host] = {});
      let applied = 0;
      for (const s of suggestions) {
        if (!s || !s.path || s.path === 'null') continue;
        if (s.confidence != null && s.confidence < 0.5) continue;
        const u = un[s.i];
        if (!u) continue;
        lastScan.fields.push({ ...u, reason: undefined, label: u.label || s.path, path: s.path, type: u.type || guessTypeOfPath(s.path), score: 50 });
        const idx = lastScan.unmatched.indexOf(u);
        if (idx >= 0) lastScan.unmatched.splice(idx, 1);
        siteMap[u.fingerprint || globalThis.Matcher.normalize(u.label || '')] = s.path;
        applied += 1;
      }
      maps[host] = siteMap;
      await chrome.storage.local.set({ siteMappings: maps });
      return { applied, total: suggestions.length };
    },
    /** 测试辅助:读取当前面板文本(脱敏态) */
    panelText() {
      const host = document.getElementById(HOST_ID);
      return host ? host.shadowRoot.textContent : '';
    },
    close() {
      removePanel();
    },
  };

  globalThis.ResumeAutofill = ResumeAutofill;
})();
