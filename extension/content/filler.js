/**
 * filler.js — 表单填充器
 * 将档案值写入扫描结果中的字段。要点:
 *  - React/Vue 兼容:用原型原生 setter 赋值再派发 input/change 事件
 *  - radio/checkbox 用原生 click() 触发完整事件链
 *  - 经历数组:先填已有行;档案条目多于行数时点击"添加"按钮增行后重扫
 *  - 已有值的字段默认跳过(防重复填充),不自动提交任何表单
 * 依赖:matcher.js / mask.js 须先注入(globalThis.Matcher / globalThis.Mask)。
 */
(function () {
  'use strict';
  const Matcher = globalThis.Matcher;
  const Mask = globalThis.Mask;

  /** 档案路径取值,支持 education[0].school 形式与 derived.age 派生值。 */
  function resolveValue(profile, path) {
    if (path == null) return undefined;
    if (path === 'derived.age') return computeAge(profile.personal && profile.personal.birthDate);
    // 兼容旧版档案:awards 曾是字符串数组,继续把字符串作为奖项名称读取。
    const legacyAward = String(path).match(/^awards\[(\d+)\]\.name$/);
    if (legacyAward && typeof profile.awards?.[Number(legacyAward[1])] === 'string') {
      return profile.awards[Number(legacyAward[1])];
    }
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = profile;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  function computeAge(birthDate) {
    const m = String(birthDate || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return undefined;
    const birth = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const beforeBirthday =
      now.getMonth() < birth.getMonth() ||
      (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
    if (beforeBirthday) age -= 1;
    return age >= 0 && age < 150 ? String(age) : undefined;
  }

  /** AI 只提供高层控件意图;只有与扫描到的真实 DOM 控件兼容时才采用,否则回退扫描类型。 */
  function plannedType(entry) {
    const op = entry && entry.aiOperation;
    const el = entry && entry.el;
    if (!op || op === 'auto' || !el) return entry.type;
    const tag = String(el.tagName || '').toLowerCase();
    if (op === 'textarea' && tag === 'textarea') return Matcher.T.TEXTAREA;
    if (op === 'native-select' && tag === 'select') return Matcher.T.SELECT;
    if (op === 'radio' && el.type === 'radio') return Matcher.T.RADIO;
    if (op === 'checkbox' && el.type === 'checkbox') return Matcher.T.CHECKBOX_GROUP;
    if (op === 'date-input' && tag === 'input' && el.type === 'date') return Matcher.T.DATE;
    if (op === 'month-picker' && entry.type === Matcher.T.CUSTOM_PICKER) return Matcher.T.CUSTOM_PICKER;
    if (op === 'date-range-picker' && entry.type === Matcher.T.CUSTOM_PICKER) return Matcher.T.CUSTOM_PICKER;
    if (op === 'custom-select' && entry.type === Matcher.T.CUSTOM_SELECT) return Matcher.T.CUSTOM_SELECT;
    return entry.type;
  }

  /** 原生 setter 赋值并派发事件,兼容 React 受控组件与 Vue 双向绑定。 */
  function setNativeValue(el, value) {
    const proto =
      el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT'
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 日期/月份值适配控件类型。 */
  function coerceDate(value, el, matchType) {
    const v = String(value == null ? '' : value).trim();
    const elType = el && el.type ? el.type : '';
    const isDateEl = elType === 'date' || matchType === 'date';
    const isMonthEl = elType === 'month' || matchType === 'month';
    const dmy = v.match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?日?$/);
    if (!dmy) return v;
    const y = dmy[1];
    const mo = dmy[2].padStart(2, '0');
    if (isMonthEl && !elType) return `${y}-${mo}`; // 文本框月份字段
    if (isDateEl && elType === 'date') return `${y}-${mo}-${(dmy[3] || '01').padStart(2, '0')}`;
    if (isMonthEl && elType === 'month') return `${y}-${mo}`;
    return dmy[3] ? `${y}-${mo}-${dmy[3].padStart(2, '0')}` : `${y}-${mo}`;
  }

  function hasCompleteDate(value) {
    return /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?$/.test(String(value == null ? '' : value).trim());
  }

  /**
   * 按卡片锚点(学校/公司/项目名)对齐经历下标。
   * 站点卡片顺序可能与档案顺序不同(如站点按时间正序本科在前,档案硕士在前),
   * 直接按下标填充会把两段经历的时间互换。若卡片锚点控件已有值(站点预填),
   * 用它找到档案中真正对应的条目,改写路径下标;无法唯一匹配时保持原样。
   */
  function alignedPath(path, el, profile) {
    if (!path) return path;
    const m = String(path).match(/^(education|internships|employment|projects|awards)\[(\d+)\]\.(.+)$/);
    if (!m) return path;
    const [, array, idxStr, leaf] = m;
    const list = profile[array];
    if (!Array.isArray(list) || list.length < 2) return path;
    const anchorLeaf = { education: 'school', internships: 'company', employment: 'company', projects: 'name', awards: 'name' }[array];
    if (!anchorLeaf) return path;
    let anchorText = '';
    const holder = el && el.closest ? el.closest('[data-cy]') : null;
    const holderCy = holder && holder.getAttribute('data-cy');
    const idm = holderCy && holderCy.match(new RegExp(`^${array}\\[(\\d+)\\]`));
    if (idm) {
      const cardIdx = Number(idm[1]);
      const q = document.querySelector(
        `[data-cy="${array}[${cardIdx}].${anchorLeaf}"], [data-cy="${array}[${cardIdx}].${anchorLeaf}Input"]`
      );
      if (q) {
        const input = q.matches('input, textarea') ? q : q.querySelector('input, textarea');
        anchorText = (input && input.value) || q.textContent || '';
      }
    }
    anchorText = String(anchorText || '').trim();
    if (anchorText.length < 3) return path;
    const norm = Matcher.normalize(anchorText);
    const hits = [];
    list.forEach((entry, j) => {
      const target = entry == null ? '' : typeof entry === 'string' ? entry : entry[anchorLeaf] != null ? String(entry[anchorLeaf]) : '';
      const tn = Matcher.normalize(target);
      if (tn.length >= 2 && (norm.includes(tn) || tn.includes(norm))) hits.push(j);
    });
    const idx = Number(idxStr);
    if (hits.length === 1 && hits[0] !== idx) return `${array}[${hits[0]}].${leaf}`;
    return path;
  }

  /** 宽松等值比较:忽略空白与年月日常见分隔符(2026年1月 ≡ 2026-01 ≡ 2026.1)。 */
  function looseEqual(a, b) {
    const norm = (s) => String(s == null ? '' : s).replace(/[\s:/\-\.年月]/g, '').toLowerCase();
    return norm(a) === norm(b) && norm(a) !== '';
  }

  /** 在 option 列表中为 profile 值找最佳选项文本。 */
  function pickOption(options, profileValue) {
    let best = null;
    for (const opt of options) {
      const s = Matcher.optionScore(opt.textContent, profileValue);
      if (s > 0 && (!best || s > best.score)) best = { opt, score: s };
    }
    return best ? best.opt : null;
  }

  /** 单个 input/textarea/select 填充。返回状态。 */
  function fillElement(el, value, matchType) {
    if (value == null || value === '') return { status: 'no-value' };
    if ((el.type === 'date' || matchType === Matcher.T.DATE) && !hasCompleteDate(value)) {
      return { status: 'need-manual', reason: `档案日期缺少具体日（当前为 ${String(value)}）` };
    }
    if (el.tagName === 'SELECT') {
      const opt = pickOption(Array.from(el.options), value);
      if (!opt || opt.disabled) return { status: 'no-option', value: String(value) };
      if (el.value === opt.value) return { status: 'kept' };
      setNativeValue(el, opt.value);
      return { status: 'filled', value: opt.textContent.trim() };
    }
    if (el.tagName === 'TEXTAREA') {
      if ((el.value || '').trim()) return { status: 'kept' };
      setNativeValue(el, String(value));
      return { status: 'filled', value: String(value) };
    }
    // 用户已填过的字段不覆盖(防重复填充);与档案不一致时报告而非静默保留
    if ((el.value || '').trim()) {
      const cur = (el.value || '').trim();
      const want = String(value).trim();
      if (looseEqual(cur, want)) return { status: 'kept', value: cur };
      return { status: 'kept-mismatch', value: cur, reason: `当前值与档案不一致(档案为 ${want}),已保留现值,请人工核对` };
    }
    if (el.type === 'date' || el.type === 'month' || /date|month/i.test(matchType || '')) {
      const v = coerceDate(value, el, matchType);
      setNativeValue(el, v);
      return { status: 'filled', value: v };
    }
    setNativeValue(el, String(value));
    return { status: 'filled', value: String(value) };
  }

  /** radio/checkbox 组填充(radio 含 qa 筛选题)。 */
  function fillGroup(group, profile) {
    const { els, kind } = group;
    let want;
    let source;
    if (group.path) {
      want = resolveValue(profile, group.path);
      source = group.path;
    } else if ((kind === 'radio' || kind === 'custom-radio') && group.qaMatch) {
      const qa = Matcher.matchQuestion(group.qaMatch.question, profile);
      if (!qa) return { status: 'unmatched-question', label: group.label };
      want = qa.value;
      source = `qa["${qa.key}"]`;
    } else {
      return { status: 'skipped', label: group.label, reason: '未匹配到档案字段' };
    }
    if (want == null || want === '') return { status: 'no-value', label: group.label };

    if (kind === 'radio' || kind === 'custom-radio') {
      const selected = (e) =>
        Boolean(e.checked) ||
        e.matches?.('.phoenix-radio--checked, [aria-checked="true"]') ||
        Boolean(e.querySelector?.('.phoenix-radio--checked, .phoenix-radio__circle--checked, [aria-checked="true"]'));
      if (els.some(selected)) return { status: 'kept', label: group.label };
      const target = pickOption(
        els.map((e) => ({ textContent: nearestOptionText(e), disabled: e.disabled || e.getAttribute?.('aria-disabled') === 'true', e })),
        want
      );
      if (!target) return { status: 'no-option', label: group.label, value: String(want) };
      target.e.click();
      return { status: 'filled', label: group.label, value: nearestOptionText(target.e) };
    }
    // checkbox-group:want 应为数组,逐一勾选文本匹配项;已勾选的保留
    const wants = Array.isArray(want) ? want.map(String) : [String(want)];
    let filled = 0;
    for (const el of els) {
      const text = nearestOptionText(el);
      const should = wants.some((w) => Matcher.optionScore(text, w) > 0);
      if (should && !el.checked) {
        el.click();
        filled += 1;
      }
    }
    return filled > 0
      ? { status: 'filled', label: group.label, value: wants.join('、') }
      : { status: 'kept', label: group.label };
  }

  /** radio/checkbox 的选项文本:包裹 label / for 关联 label / 父级最近文本。 */
  function nearestOptionText(el) {
    if (el.matches?.('.phoenix-radio-group__radioItem, .phoenix-radio, [role="radio"]')) {
      const own = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (own) return own;
    }
    const wrap = el.closest('label');
    if (wrap) {
      const t = (wrap.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return (l.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const parent = el.parentElement;
    return parent ? (parent.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  /** 元素文本是否符合"添加一条"按钮特征(添加/新增/+…,短文本,非提交类)。 */
  function looksLikeAddButton(el) {
    const t = (el.textContent || el.value || '').replace(/\s+/g, '').trim();
    if (!t || t.length > 12) return false;
    return /^(添加|新增|继续添加|再添加|添加一条|增加|add|new\+?|\+添加|\+新增|\+)/i.test(t);
  }

  function findAddButtonIn(el) {
    if (el.matches && el.matches('button, a, [role=button], input[type=button]') && looksLikeAddButton(el)) {
      return el;
    }
    const candidates = el.querySelectorAll ? el.querySelectorAll('button, a, [role=button], input[type=button]') : [];
    for (const c of candidates) {
      if (looksLikeAddButton(c)) return c;
    }
    return null;
  }

  /**
   * 找"添加一条经历"按钮:从行容器逐级向上,在自身与后续兄弟节点中查找
   * (常见结构:表格之后紧跟 + 添加 按钮)。
   */
  function findAddButton(container) {
    let scope = container;
    for (let hop = 0; hop < 5 && scope; hop++) {
      let sib = scope.nextElementSibling;
      while (sib) {
        const hit = findAddButtonIn(sib);
        if (hit) return hit;
        sib = sib.nextElementSibling;
      }
      const inside = findAddButtonIn(scope);
      if (inside) return inside;
      scope = scope.parentElement;
    }
    return null;
  }

  /** 事件去抖:填充结果项构造统一的报告行(敏感值脱敏)。 */
  function reportEntry(entry) {
    const out = { label: entry.label, path: entry.path || '', status: entry.status };
    if ('value' in entry && entry.value != null) {
      const p = entry.path || entry.label || '';
      out.value = Mask.isSensitive(p) ? Mask.maskValue(p, entry.value) : String(entry.value);
    }
    if (entry.reason) out.reason = entry.reason;
    return out;
  }

  /**
   * 执行填充(异步:自定义组件需要等待面板)。
   * @param {object} scanResult Scanner.scan() 的结果
   * @param {object} profile    档案
   * @param {object} [opts]     skipRows: 跳过经历行(增行前);rowsOnly: 只填经历行(增行后重扫);includeGroups: 重扫时填新增选项组;skipGroups: 已处理选项组元素集合
   * @returns {Promise<{report: object[], addedRows: number}>} 报告行均已脱敏
   */
  async function fill(scanResult, profile, opts = {}) {
    const report = [];
    let addedRows = 0;

    // 1) 经历行:档案条目多于现有行时先尝试增行(点击页面的"添加"按钮)
    const rowsByArray = {};
    for (const row of scanResult.rows) {
      rowsByArray[row.array] = rowsByArray[row.array] || [];
      rowsByArray[row.array].push(row);
    }
    const listLens = {
      education: (profile.education || []).length,
      internship: (profile.internships || []).length,
      employment: (profile.employment || []).length,
      project: (profile.projects || []).length,
      award: (profile.awards || []).length,
    };
    if (!opts.rowsOnly) {
      for (const array of Object.keys(rowsByArray)) {
        const rows = rowsByArray[array];
        const have = listLens[array] || 0;
        let need = have - rows.length;
        while (need > 0) {
          const btn = findAddButton(rows[rows.length - 1].container);
          if (!btn) break;
          btn.click();
          addedRows += 1;
          need -= 1;
        }
      }

      // 2) 普通字段
      for (const f of scanResult.fields) {
        const fillType = plannedType(f);
        if (fillType === Matcher.T.CUSTOM_SELECT || fillType === Matcher.T.CUSTOM_PICKER) {
          // 自定义组件:点击面板交互填充
          if (!globalThis.Components) {
            report.push(reportEntry({ ...f, status: 'skipped', reason: '组件适配层未加载' }));
            continue;
          }
          if (f.type === Matcher.T.CUSTOM_SELECT) {
            const value = resolveValue(profile, alignedPath(f.path, f.trigger || f.el, profile));
            if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
              report.push(reportEntry({ ...f, status: 'no-value' }));
              continue;
            }
            const res = await globalThis.Components.fillCustomSelect(f.trigger || f.el, value, Array.isArray(value));
            report.push(reportEntry({ ...f, ...res }));
          } else {
            const rawValues = (f.paths || [f.path])
              .map((p) => resolveValue(profile, alignedPath(p, f.trigger || f.el, profile)))
              .filter((v) => v != null && v !== '');
            const requiresDay = f.valueType === Matcher.T.DATE && !['month', 'year'].includes(f.pickerPrecision);
            if (requiresDay && rawValues.some((value) => !hasCompleteDate(value))) {
              report.push(reportEntry({
                ...f,
                status: 'need-manual',
                reason: `档案日期缺少具体日（当前为 ${String(rawValues[0])}）`,
              }));
              continue;
            }
            const values = rawValues.map((v) => {
              if (f.pickerPrecision === 'year') return String(v).match(/^\d{4}/)?.[0] || String(v);
              const precision = f.pickerPrecision || (f.valueType === Matcher.T.DATE ? 'date' : 'month');
              return coerceDate(v, null, precision);
            });
            if (!values.length) {
              report.push(reportEntry({ ...f, status: 'no-value' }));
              continue;
            }
            const res = await globalThis.Components.fillCustomPicker(f.trigger || f.el, values);
            report.push(reportEntry({ ...f, ...res, value: res.value }));
          }
          continue;
        }
        const value = resolveValue(profile, alignedPath(f.path, f.el, profile));
        const res = fillElement(f.el, value, fillType);
        report.push(reportEntry({ ...f, ...res }));
      }

      // 3) radio / checkbox 组
    }

    if (!opts.rowsOnly || opts.includeGroups) {
      for (const g of scanResult.groups) {
        if (opts.skipGroups && g.els.some((el) => opts.skipGroups.has(el))) continue;
        report.push(reportEntry(fillGroup(g, profile)));
      }
    }

    // 4) 行字段(rowsOnly 阶段:增行并重扫后,统一填充全部行;已填过的自然返回 kept)
    if (!opts.skipRows) {
      for (const row of scanResult.rows) {
        for (const item of row.items) {
          const value = resolveValue(profile, alignedPath(item.path, item.el, profile));
          const res = fillElement(item.el, value, plannedType(item));
          report.push(reportEntry({ ...item, ...res }));
        }
      }
    }

    return { report, addedRows };
  }

  globalThis.Filler = { fill, resolveValue, setNativeValue, computeAge, fillElement };
})();
