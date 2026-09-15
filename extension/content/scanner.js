/**
 * scanner.js — 表单扫描器
 * 遍历页面可见表单控件,提取每个控件的 label 文本,并用 Matcher 归类:
 *  - 普通字段 → 档案路径
 *  - 经历行(教育/实习/项目的重复行容器)→ 行内字段带 rowContext(行容器按区块标题识别)
 *  - radio 组:同 name 一组,整组取题干(fieldset legend / 表单组 label)
 *  - checkbox 组:同 name 多选框一组
 *  - 长题干(≥8 字)的 radio 组视为筛选题,走 qa 匹配
 * 依赖:matcher.js 须先注入(共享 globalThis.Matcher)。
 */
(function () {
  'use strict';
  const Matcher = globalThis.Matcher;

  const FILLABLE =
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=file]):not([type=search]), textarea, select';

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.type === 'radio' || el.type === 'checkbox';
  }

  function textOf(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  /** 找到真正的字段外层,避免停在 atsx-form-item-children 等内部节点。 */
  function formItemContainer(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const tokens = typeof node.className === 'string' ? node.className.split(/\s+/) : [];
      if (
        tokens.some((t) => /^(?:ant|el|atsx)?-?form-item$/i.test(t)) ||
        tokens.includes('form-group') || tokens.includes('field') || tokens.includes('question')
      ) return node;
    }
    return null;
  }

  function canonicalArray(raw) {
    const value = String(raw || '').toLowerCase();
    if (/^educ/.test(value)) return 'education';
    if (/^(intern|practice)/.test(value)) return 'internships';
    if (/^(career|employment|work)/.test(value)) return 'employment';
    if (/^proj/.test(value)) return 'projects';
    if (/^(award|prize|honor)/.test(value)) return 'awards';
    return null;
  }

  /** 从框架字段名中读取经历类型和下标,兼容 career[0].company 与 educations_0_degree。 */
  function parseSemanticIdentity(value) {
    const text = String(value || '');
    let m = text.match(/(?:^|[^A-Za-z])(educations?|internships?|practices?|careers?|employments?|works?|projects?|awards?|prizes?|honors?)\[(\d+)\](?:[._-]?([^\s]+))?/i);
    if (!m) m = text.match(/(?:^|[_-])(educations?|internships?|practices?|careers?|employments?|works?|projects?|awards?|prizes?|honors?)[_-](\d+)(?:[_-](.+))?/i);
    if (!m) return null;
    const array = canonicalArray(m[1]);
    if (!array) return null;
    return { array, index: Number(m[2]), leaf: String(m[3] || '').replace(/^[._-]+/, ''), raw: m[0].replace(/^[^A-Za-z]+/, '') };
  }

  function semanticIdentity(el) {
    const values = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      for (const attr of ['id', 'name', 'data-field-name', 'data-form-field-name', 'data-form-field-id']) {
        const value = node.getAttribute && node.getAttribute(attr);
        if (value) values.push(value);
      }
      if (values.length > 20) break;
    }
    const item = formItemContainer(el);
    if (item) {
      for (const label of item.querySelectorAll('label[for]')) values.push(label.htmlFor);
    }
    for (const value of values) {
      const identity = parseSemanticIdentity(value);
      if (identity) return identity;
    }
    return null;
  }

  function remapPath(path, identity) {
    if (!path || !identity) return path;
    const m = String(path).match(/^(education|internships|employment|projects|awards)\[\d+\]\.(.+)$/);
    return m ? `${identity.array}[${identity.index}].${m[2]}` : path;
  }

  function sectionFromText(text) {
    const t = Matcher.normalize(text || '');
    if (/个人信息|基本信息|个人资料|profile|personal/.test(t)) return 'personal';
    if (/在校实践|社会实践|实践经历/.test(t)) return 'projects';
    if (/项目|project/.test(t)) return 'projects';
    if (/教育|学历|education/.test(t)) return 'education';
    if (/实习|intern|practice/.test(t)) return 'internships';
    if (/工作经历|工作经验|任职经历|career|employment/.test(t)) return 'employment';
    if (/获奖|奖项|award|prize|honor/.test(t)) return 'awards';
    return null;
  }

  /** 北森等动态表单的业务区块标题：区块首个直接子节点带 id，后续节点承载表单。 */
  function explicitBlockTitle(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const child = node.children && Array.from(node.children).find((candidate) => candidate.contains(el));
      const first = node.firstElementChild;
      if (child && first && first !== child && first.id && !first.querySelector(FILLABLE)) {
        const title = textOf(first).slice(0, 40);
        if (title) return title;
      }
    }
    return '';
  }

  /** 从表单分组容器及其标题推断区块，兼容恒生这类无 row/id 的动态表单。 */
  function sectionOfElement(el) {
    const identity = semanticIdentity(el);
    if (identity) return identity.array;
    const explicitTitle = explicitBlockTitle(el);
    if (explicitTitle) return sectionFromText(explicitTitle);
    let node = el.closest('[data-form-field-id], [data-form-field-name], [class*="formily-item"]') || formItemContainer(el) || el;
    for (let hop = 0; hop < 25 && node && node !== document.body; hop++) {
      // 只看“包含字段的直接子节点”旁边的标题，避免在整张表单根节点中
      // 误拾取后面其他区块的“教育经历/实习经历”标题。
      const child = node.children && Array.from(node.children).find((candidate) => candidate.contains(el));
      if (child) {
        const first = node.firstElementChild;
        const firstClass = typeof first?.className === 'string' ? first.className : '';
        if (first && first !== child && (/^H[1-6]$/.test(first.tagName) || /title|header/i.test(firstClass))) {
          const sec = sectionFromText(Matcher.normalize(textOf(first).slice(0, 40)));
          if (sec) return sec;
        }
        for (const candidate of [child.previousElementSibling, child.nextElementSibling]) {
          if (!candidate) continue;
          const t = Matcher.normalize(textOf(candidate).slice(0, 40));
          const sec = sectionFromText(t);
          if (sec) return sec;
        }
      }
      if (!child) {
        for (const dir of ['previousElementSibling', 'nextElementSibling']) {
          const sib = node[dir];
          if (sib) {
            const t = Matcher.normalize(textOf(sib).slice(0, 40));
            const sec = sectionFromText(t);
            if (sec) return sec;
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function fieldFingerprint(el, label, identity, section, kind, rowIndex = null) {
    const normalized = Matcher.normalize(label || '');
    if (identity) return `${identity.array}[${identity.index}]|${normalized}|${kind || el.tagName.toLowerCase()}`;
    if (Number.isInteger(rowIndex) && section) return `${section}[${rowIndex}]|${normalized}|${kind || el.tagName.toLowerCase()}`;
    return `${section || 'global'}|${normalized}|${kind || el.getAttribute('role') || el.tagName.toLowerCase()}`;
  }

  /**
   * 提取控件 label,按可信度依次尝试:
   * 1) label[for=id] 2) 包裹型 <label><input/></label> 3) aria-label/labelledby
   * 4) placeholder 5) 表格:thead 同列 th / 同行 th / 左侧相邻 td 6) name/id 属性
   * 7) 表单组容器内 label 8) 前置兄弟文本
   */
  function extractLabel(el) {
    // Moka 等组件库把真实题名放在 apply-field 的独立 label 中，控件外层 label 只显示当前选项值。
    const applyField = el.closest('[class*="apply-field-"]');
    if (applyField) {
      const directTitle = Array.from(applyField.children).find((node) => /(^|\s)[^\s]*title-[^\s]*/i.test(String(node.className || '')));
      const titleText = textOf(directTitle);
      if (titleText && titleText.length <= 40) return titleText;
      const ownLabels = Array.from(applyField.querySelectorAll('[class*="label-"]')).filter((label) => {
        const nestedField = label.closest('[class*="apply-field-"]');
        return nestedField === applyField;
      });
      for (const label of ownLabels) {
        const value = textOf(label);
        if (value && value.length <= 40) return value;
      }
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && textOf(l)) return textOf(l);
    }
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return textOf(wrap);
    // formily 等表单框架:字段名直接写在容器的 data 属性里(字节系网申常用,如 data-form-field-i18n-name="姓名")
    const ff = el.closest('[data-form-field-i18n-name], [data-form-field-name], [data-form-field-id]');
    if (ff) {
      const t =
        ff.getAttribute('data-form-field-i18n-name') ||
        ff.getAttribute('data-form-field-name') ||
        ff.getAttribute('data-form-field-id');
      if (t && t.trim()) return t.trim();
    }
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean)
        .join(' ');
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const formItem = formItemContainer(el);
    if (formItem) {
      const labels = formItem.querySelectorAll('label, .field-label, .el-form-item__label, .ant-form-item-label, .atsx-form-item-label');
      for (const label of labels) {
        if (!label.contains(el) && textOf(label)) return textOf(label);
      }
    }
    const cell = el.closest('td');
    if (cell) {
      const row = cell.closest('tr');
      const table = cell.closest('table');
      const idx = row ? Array.from(row.children).indexOf(cell) : -1;
      const headRow = table && table.querySelector('thead tr');
      if (idx >= 0 && headRow && headRow.children[idx] && textOf(headRow.children[idx])) {
        return textOf(headRow.children[idx]);
      }
      if (row) {
        const th = row.querySelector('th');
        if (th && textOf(th)) return textOf(th);
      }
      let prev = cell.previousElementSibling;
      while (prev) {
        const t = textOf(prev);
        if (t) return t;
        prev = prev.previousElementSibling;
      }
    }
    // 表单组容器的字段标签优先于 placeholder(placeholder 多为输入示例)
    const group = formItem || el.closest(
      '.form-group, .form-item, .field, .question, .el-form-item, .ant-form-item, .group, [class*="formily-item"], [class*="form-item"], [class*="form-group"], [class*="form_group"], [class*="FormItem"]'
    );
    if (group) {
      const labels = group.querySelectorAll('label, .label, .field-label, .el-form-item__label, .q-title, [class*="label"]');
      for (const l of labels) {
        if (!l.contains(el) && textOf(l)) return textOf(l);
      }
    }
    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return ph.trim();
    if (el.name && !/^\d+$/.test(el.name)) return el.name;
    let prev = el.previousElementSibling;
    while (prev) {
      const t = textOf(prev);
      if (t) return t;
      prev = prev.previousElementSibling;
    }
    return '';
  }

  /**
   * 选项组题干:radio/checkbox 组取整组标题而非单个选项文本。
   * 依次尝试 fieldset legend → 公共祖先中的组容器 label → 标题类元素。
   */
  function groupLabel(els) {
    // formily 等框架:组题干写在公共容器的 data 属性里
    const ffa = els[0].closest('[data-form-field-i18n-name], [data-form-field-name], [data-form-field-id]');
    if (ffa) {
      const t = ffa.getAttribute('data-form-field-i18n-name') || ffa.getAttribute('data-form-field-name') || ffa.getAttribute('data-form-field-id');
      if (t && t.trim()) return t.trim();
    }
    const fs = els[0].closest('fieldset');
    if (fs) {
      const leg = fs.querySelector('legend');
      if (leg && textOf(leg)) return textOf(leg);
    }
    const anc = commonAncestor(els);
    for (let node = anc; node && node !== document.body; node = node.parentElement) {
      if (
        node.matches &&
        node.matches('.form-group, .form-item, .field, .question, .el-form-item, .ant-form-item, .group, [class*="formily-item"], [class*="form-item"], [class*="form-group"], [class*="form_group"], [class*="FormItem"]')
      ) {
        const labels = node.querySelectorAll('label, .label, .field-label, .el-form-item__label, .q-title, [class*="label"]');
        for (const l of labels) {
          const containsOption = Array.prototype.some.call(els, (e) => l.contains(e));
          if (!containsOption && textOf(l)) return textOf(l);
        }
      }
    }
    if (anc) {
      const h = anc.querySelector('h2, h3, h4, .title, .q-title');
      const containsOption = h && els.some((e) => h.contains(e));
      if (h && !containsOption && textOf(h)) return textOf(h);
    }
    return extractLabel(els[0]);
  }

  function commonAncestor(els) {
    if (!els.length) return null;
    let node = els[0];
    for (const other of els.slice(1)) {
      while (node && !(node.contains && node.contains(other))) node = node.parentElement;
      if (!node) return null;
    }
    return node;
  }

  const anonymousGroupIds = new WeakMap();
  let nextAnonymousGroupId = 1;

  function radioGroupContainer(el) {
    return el.closest('[role="radiogroup"], .ant-radio-group, [class*="radio-group"], [class*="radio_group"], fieldset, .form-group, .form-item, .field, .question');
  }

  /** radio/checkbox 分组键:优先使用控件 name,再使用框架组容器的 id。 */
  function groupKey(el) {
    if (el.type !== 'radio' && el.type !== 'checkbox') return null;
    const container = radioGroupContainer(el);
    const identity = container && (container.id || container.getAttribute('name') || container.getAttribute('data-field-name'));
    if (identity) return `${el.type}::container::${identity}`;
    if (el.name) return `${el.type}::name::${el.name}`;
    if (container) {
      if (!anonymousGroupIds.has(container)) anonymousGroupIds.set(container, nextAnonymousGroupId++);
      return `${el.type}::anonymous::${anonymousGroupIds.get(container)}`;
    }
    return `${el.type}::anonymous::${el.parentElement ? 'parent-' + (anonymousGroupIds.get(el.parentElement) || 0) : 'none'}`;
  }

  function rowContainer(el) {
    const named = el.closest('tr') || el.closest('[data-row], .experience-row, .row-item');
    if (named) return named;
    const multi = el.closest('[class*="apply-fields-"][class*="multi-"]');
    if (multi && ['education', 'internships', 'employment', 'projects', 'awards'].includes(sectionOfElement(el))) return multi;
    // 恒生 Phoenix 表单：每条经历是一个 .form 实例，而非带 row/index 的节点。
    const form = el.closest('.form');
    const section = sectionOfElement(el);
    if (form && ['education', 'internships', 'projects', 'awards'].includes(section)) return form;
    // 兼容只有 form-part-body 作为重复项容器的页面。
    const body = el.closest('.form-part-body');
    return body && ['education', 'internships', 'projects', 'awards'].includes(section) ? body : null;
  }

  /** 行容器所属区块文本:向上找最近的标题兄弟(候选 h1-h4/.section-title)。 */
  function sectionHeading(container) {
    let node = container;
    for (let hop = 0; hop < 6 && node; hop++) {
      let prev = node.previousElementSibling;
      while (prev) {
        if (/^H[1-4]$/.test(prev.tagName)) return textOf(prev);
        if (prev.matches && prev.matches('.section-title')) return textOf(prev);
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    const table = container.closest('table');
    if (table && table.caption) return textOf(table.caption);
    return '';
  }

  /** 判断行容器属于哪类经历:优先区块标题,回退行内控件 name 属性。 */
  function rowKind(container) {
    if (!container) return null;
    const semantic = sectionOfElement(container.querySelector('input, select, textarea'));
    if (semantic && semantic !== 'personal') {
      return semantic === 'projects' ? 'project' : semantic === 'internships' ? 'internship' : semantic === 'awards' ? 'award' : semantic;
    }
    const headed = sectionFromText(sectionHeading(container));
    if (headed) return headed === 'projects' ? 'project' : headed === 'internships' ? 'internship' : headed === 'awards' ? 'award' : headed;
    const names = Array.from(container.querySelectorAll('input, select, textarea'))
      .map((e) => e.name || e.id || '')
      .join(' ');
    const normNames = Matcher.normalize(names);
    if (/project|proj/.test(normNames)) return 'project';
    if (/intern|practice/.test(normNames)) return 'internship';
    if (/career|employment|employer|work/.test(normNames)) return 'employment';
    if (/edu|school|education/.test(normNames)) return 'education';
    if (/award|prize|honor/.test(normNames)) return 'award';
    return null;
  }

  /**
   * 扫描全页。返回:
   * {
   *   fields:  [{ kind:'field', el, label, path, type, score }],
   *   groups:  [{ kind:'radio'|'checkbox-group', els, label, path|null, qaMatch|null, type }],
   *   rows:    [{ kind:'row', array, container, items:[{ el, label, path, type }] }],
   *   unmatched: [{ kind, label, el, reason }]
   * }
   */
  function scan() {
    const allEls = Array.from(document.querySelectorAll(FILLABLE)).filter(isVisible);
    const els = allEls
      .filter((el) => !el.matches('.phoenix-select__input') && !el.closest('.month-range-select') && !el.closest('[class*="sd-Select-container-"]'))
      .filter(isVisible);
    const results = { fields: [], groups: [], rows: [], unmatched: [] };
    const handled = new Set();

    const rowMap = new Map();
    for (const el of allEls) {
      const container = rowContainer(el);
      if (!container) continue;
      const kind = rowKind(container);
      if (!kind) continue;
      if (!rowMap.has(container)) rowMap.set(container, { array: kind, items: [] });
      rowMap.get(container).items.push(el);
    }
    const kindCounters = {};
    const containerIndex = new Map();
    for (const [container, info] of rowMap) {
      const k = info.array;
      kindCounters[k] = kindCounters[k] || 0;
      containerIndex.set(container, kindCounters[k]++);
    }

    for (const el of els) {
      if (handled.has(el)) continue;
      const gk = groupKey(el);
      if (gk) {
        const same = els.filter((o) => groupKey(o) === gk);
        same.forEach((e) => handled.add(e));
        handleGroup(el, same, results);
        continue;
      }
      const container = rowContainer(el);
      const rowInfo = container && rowMap.get(container);
      if (rowInfo) {
        const index = containerIndex.get(container) || 0;
        const label = extractLabel(el);
        const identity = semanticIdentity(el);
        const m = Matcher.matchField(label, { array: identity ? identity.array : rowInfo.array, index: identity ? identity.index : index });
        if (m) {
          let row = results.rows.find((r) => r.container === container);
          if (!row) {
            row = { kind: 'row', array: rowInfo.array, index, container, items: [] };
            results.rows.push(row);
          }
          const section = identity ? identity.array : rowInfo.array;
          row.items.push({ el, label, path: remapPath(m.path, identity), type: m.type, score: m.score, identity, section, fingerprint: fieldFingerprint(el, label, identity, section, 'row-field', index) });
        } else {
          const section = identity ? identity.array : rowInfo.array;
          results.unmatched.push({
            kind: 'row-field', label, el, reason: '行内字段未命中词典', identity, section,
            itemIndex: identity ? identity.index : index, rowContainer: container, rowIndex: index,
            fingerprint: fieldFingerprint(el, label, identity, section, 'row-field', index),
          });
        }
        continue;
      }
      const label = extractLabel(el);
      const m = Matcher.matchField(label, null);
      if (m) {
        const identity = semanticIdentity(el);
        const section = identity ? identity.array : null;
        results.fields.push({ kind: 'field', el, label, path: remapPath(m.path, identity), type: m.type, score: m.score, identity, section, fingerprint: fieldFingerprint(el, label, identity, section, 'field') });
      } else {
        const identity = semanticIdentity(el);
        const section = identity ? identity.array : null;
        results.unmatched.push({ kind: 'field', label, el, reason: '未命中词典', identity, section, fingerprint: fieldFingerprint(el, label, identity, section, 'field') });
      }
    }
  /** 字段所属区块:定位到 formily/form 容器后向上找区块标题(教育经历/实习经历/项目经历);标题可能在 DOM 中位于表单列之后 */
  function sectionOfField(el) {
    return sectionOfElement(el);
  }

    // 自定义下拉框与日历/月份选择器:转为 custom 条目(原生输入在 picker 包装内的会被移出普通字段)
    const customSeen = new Set();

    /**
     * 先依据 DOM 结构识别控件能力,再做字段语义匹配。
     * 控件类型决定执行器;label/path/valueType 只决定“填什么”,不能反过来改变执行器。
     */
    function detectCustomControl(el, fallbackType) {
      const closest = (selector) => el?.matches?.(selector) ? el : el?.closest?.(selector);
      const pickerRoot = closest(
        '.ud__picker, .throne-biz-date-range-picker-wrapper, .month-range-select, ' +
        '[class~="atsx-date-picker"], [class~="ant-picker"], [class~="ant-picker-range"], ' +
        '[class*="date-range-picker-wrapper"], [class*="range-picker-wrapper"]'
      );
      const phoenixDateRoot = closest('.phoenix-select')?.querySelector?.('[id*="field_date_time_picker"]')
        ? closest('.phoenix-select')
        : null;
      if (pickerRoot || phoenixDateRoot) {
        const root = pickerRoot || phoenixDateRoot;
        const placeholders = Array.from(root.querySelectorAll?.('input') || [])
          .map((input) => input.getAttribute('placeholder') || '')
          .join(' ')
          .toUpperCase();
        const pickerPrecision = /YYYY[^A-Z]*MM[^A-Z]*DD/.test(placeholders)
          ? 'day'
          : /YYYY[^A-Z]*MM/.test(placeholders)
            ? 'month'
            : /YYYY/.test(placeholders)
              ? 'year'
              : null;
        const adapter = root.matches?.('.ud__picker, .throne-biz-date-range-picker-wrapper')
          ? 'universe-editable-picker'
          : root.matches?.('.month-range-select')
            ? 'moka-month-range'
            : root.matches?.('[class~="atsx-date-picker"]')
              ? 'atsx-picker'
              : root.matches?.('.phoenix-select')
                ? 'phoenix-picker'
                : 'calendar-picker';
        return { type: Matcher.T.CUSTOM_PICKER, adapter, pickerPrecision };
      }
      return { type: fallbackType, adapter: fallbackType === Matcher.T.CUSTOM_SELECT ? 'custom-select' : 'custom' };
    }

    function pushCustom(kind, el, type, paths, labelSource = el, pathsExplicit = false) {
      if (customSeen.has(el)) return;
      customSeen.add(el);
      const control = detectCustomControl(el, type);
      const label = extractLabel(labelSource);
      const row = rowContainer(labelSource) || rowContainer(el);
      const rowInfo = row && rowMap.get(row);
      const rowIndex = rowInfo ? (containerIndex.get(row) || 0) : null;
      const candidate = Matcher.matchField(label, rowInfo ? { array: rowInfo.array, index: rowIndex } : null);
      const blockTitle = explicitBlockTitle(labelSource) || explicitBlockTitle(el);
      const isUnknownBlockFallback =
        !rowInfo && blockTitle && !sectionFromText(blockTitle) &&
        /^(education|internships|employment|projects|awards)\[/.test(candidate?.path || '');
      const m = isUnknownBlockFallback ? null : candidate;
      if (m) {
        if (rowInfo && !results.rows.some((entry) => entry.container === row)) {
          results.rows.push({ kind: 'row', array: rowInfo.array, index: rowIndex, container: row, items: [] });
        }
        const identity = semanticIdentity(labelSource) || semanticIdentity(el);
        const section = identity ? identity.array : sectionOfField(labelSource);
        const rowArray = rowInfo && ({ internship: 'internships', project: 'projects', award: 'awards' }[rowInfo.array] || rowInfo.array);
        const scopePath = (path) => {
          if (identity) return remapPath(path, identity);
          const leaf = String(path || '').match(/^(?:education|internships|employment|projects|awards)\[\d+\]\.(.+)$/)?.[1];
          return rowInfo && leaf ? `${rowArray}[${rowIndex}].${leaf}` : path;
        };
        const finalPaths = paths ? paths.map(scopePath) : null;
        results.fields.push({
          kind: 'custom', el, label,
          path: finalPaths ? null : scopePath(m.path), paths: finalPaths,
          type: control.type, controlAdapter: control.adapter, pickerPrecision: control.pickerPrecision,
          valueType: m.type, score: m.score, trigger: el, identity, section, pathsExplicit,
          fingerprint: fieldFingerprint(el, label, identity, section, kind, rowIndex),
          rowScoped: Boolean(rowInfo), rowContainer: row, rowIndex,
        });
      } else {
        const identity = semanticIdentity(labelSource) || semanticIdentity(el);
        const section = identity ? identity.array : sectionOfField(labelSource);
        results.unmatched.push({
          kind: 'custom', label, el, trigger: el, type: control.type,
          controlAdapter: control.adapter, pickerPrecision: control.pickerPrecision,
          reason: '自定义组件未命中词典', identity, section,
          itemIndex: identity ? identity.index : rowIndex, rowContainer: row, rowIndex,
          fingerprint: fieldFingerprint(el, label, identity, section, kind, rowIndex),
        });
      }
    }

    // Ant Design / ud__select 的搜索输入通常是不可见或零尺寸的,真正的点击目标在外层 selector。
    // 只保留规范化后的 selector,避免把 selector__content/search/arrow 等子节点重复扫描。
    function selectTrigger(el) {
      let node = el;
      let fallback = null;
      while (node && node !== document.body) {
        const cls = typeof node.className === 'string' ? node.className : '';
        if (/(^|\s)(ant-select-selector|ud__select__selector|atsx-select-selection|phoenix-select)(\s|$)/.test(cls)) return node;
        if (/(^|\s)sd-Select-container-[^\s]+(?:\s|$)/.test(cls)) return node;
        if (/(^|\s)[^\s]*select[^\s]*(selector|selection)(?:\s|$)/i.test(cls)) fallback = fallback || node;
        node = node.parentElement;
      }
      if (fallback) return fallback;
      return el.matches('[role="combobox"]') && el.tagName !== 'INPUT' ? el : null;
    }

    const selectTriggers = new Map();
    for (const el of document.querySelectorAll('[role="combobox"], [class*="select__selector"], [class*="select-selector"], .phoenix-select__input, [class*="sd-Select-container-"]')) {
      const trigger = selectTrigger(el);
      if (trigger && (!selectTriggers.has(trigger) || el.matches('input[role="combobox"], input[type="search"]'))) {
        selectTriggers.set(trigger, el);
      }
    }
    for (const [trigger, labelSource] of selectTriggers) {
      if (!isVisible(trigger) || customSeen.has(trigger) || trigger.closest('.month-range-select')) continue;
      pushCustom('custom-select', trigger, Matcher.T.CUSTOM_SELECT, null, labelSource);
    }

    // 北森 Phoenix 的 Radio 不使用原生 input，而是可点击 div；单独收集为逻辑单选组。
    for (const groupEl of document.querySelectorAll('.phoenix-radio-group')) {
      if (!isVisible(groupEl)) continue;
      const options = Array.from(groupEl.querySelectorAll('.phoenix-radio-group__radioItem')).filter(
        (item) => item.closest('.phoenix-radio-group') === groupEl && isVisible(item)
      );
      if (!options.length) continue;
      const label = groupLabel(options);
      const m = label.length < 8 ? Matcher.matchField(label, null) : null;
      results.groups.push({
        kind: 'custom-radio',
        els: options,
        label,
        path: m ? m.path : null,
        type: Matcher.T.RADIO,
        qaMatch: label.length >= 8 || !m ? { question: label } : null,
      });
    }

    function pickerWrapperFor(el) {
      let node = el.parentElement;
      let fallback = null;
      while (node && node !== document.body) {
        const cls = typeof node.className === 'string' ? node.className : '';
        if (/(^|\s)(?:ant-picker(?:-range)?|atsx-date-picker)(?:\s|$)/.test(cls)) return node;
        if (/(^|\s)(?:[^\s]*date-range-picker-wrapper|[^\s]*range-picker-wrapper|throne-biz-date-range-picker)(?:\s|$)/i.test(cls)) return node;
        if (/(^|\s)[^\s]*picker[^\s]*(?:\s|$)/i.test(cls) && !/(input|suffix|separator|clear|active-bar)/i.test(cls)) {
          fallback = fallback || node;
        }
        node = node.parentElement;
      }
      return fallback;
    }

    const wrapperGroups = new Map();
    for (const f of results.fields) {
      // 从父级开始找包装器(输入框自身 class 可能就含 picker 字样)
      const w = pickerWrapperFor(f.el);
      if (!w) continue;
      if (!wrapperGroups.has(w)) wrapperGroups.set(w, []);
      wrapperGroups.get(w).push(f);
    }
    const processedPickerWrappers = new Set();
    for (const [wrapper, group] of wrapperGroups) {
      if (!isVisible(wrapper)) continue;
      processedPickerWrappers.add(wrapper);
      // 移出普通字段,并入 custom-picker 条目(路径保留原映射,填充分发时按区块重算)
      for (const f of group) f.customPicker = true;
      const paths = group.map((f) => f.path);
      pushCustom('custom-picker', group[0].el, Matcher.T.CUSTOM_PICKER, paths);
      const label = extractLabel(group[0].el);
      const entry = results.fields[results.fields.length - 1];
      if (entry.label === undefined || entry.label === null) entry.label = label;
    }
    results.fields = results.fields.filter((f) => !f.customPicker);

    // 一些日期组件没有可见 input(去哪儿 ATSX 等),直接扫描可点击的日期包装器。
    const directPickerSelector =
      '[class~="atsx-date-picker"], [class~="ant-picker"], [class~="ant-picker-range"], [class*="date-range-picker-wrapper"], [class*="range-picker-wrapper"], [class~="throne-biz-date-range-picker"], .month-range-select';
    for (const wrapper of document.querySelectorAll(directPickerSelector)) {
      if (!isVisible(wrapper) || processedPickerWrappers.has(wrapper)) continue;
      const label = extractLabel(wrapper);
      const m = Matcher.matchField(label, null);
      if (!m) continue;
      const identity = semanticIdentity(wrapper);
      const mokaSelectCount = wrapper.matches('.month-range-select')
        ? wrapper.querySelectorAll('[class*="sd-Select-container-"]').length
        : 0;
      const isRange = mokaSelectCount >= 4 || /起止|就读时间|时间范围|日期范围|period|range/i.test(`${label} ${identity ? identity.leaf : ''}`);
      let paths = null;
      if (isRange) {
        const base = remapPath(m.path, identity);
        const prefix = base && base.match(/^(education|internships|employment|projects|awards)\[\d+\]\./)?.[0];
        if (prefix) paths = [`${prefix}startDate`, `${prefix}endDate`];
      }
      pushCustom('custom-picker', wrapper, Matcher.T.CUSTOM_PICKER, paths, wrapper, true);
      processedPickerWrappers.add(wrapper);
    }

    // 无行上下文的经历字段按区块与出现顺序分发(得物等自定义表单无行容器):
  // 区块判定(教育经历/实习经历/项目经历)优先于回退匹配的数组;"起止时间"每段经历有一对输入,交替映射 start/end
    function pickerIdentity(el, wrapper) {
      const identity = semanticIdentity(el) || semanticIdentity(wrapper);
      if (!identity) return null;
      const leaves = identity.leaf.split('|').map((x) => x.replace(/[^A-Za-z]/g, '')).filter(Boolean);
      return { ...identity, leaves, holderValue: identity.raw };
    }

    function pickerRoots(holder) {
      if (!holder || !holder.querySelectorAll) return [];
      const roots = [];
      if (/(^|\s)ant-picker(?:-range)?(?:\s|$)/.test(typeof holder.className === 'string' ? holder.className : '')) roots.push(holder);
      roots.push(...holder.querySelectorAll('[class~="ant-picker"], [class~="ant-picker-range"]'));
      return Array.from(new Set(roots));
    }

    function explicitPickerPaths(group, wrapper) {
      const identity = pickerIdentity(group[0].el, wrapper);
      if (!identity) return null;
      const dateLeaves = identity.leaves.filter((leaf) => /^(startDate|endDate|birthDate|date|beginDate|finishDate)$/i.test(leaf));
      if (group.length > 1 && dateLeaves.length >= group.length) {
        return group.map((_, i) => `${identity.array}[${identity.index}].${dateLeaves[i]}`);
      }
      if (group.length === 1 && dateLeaves.length) {
        let leaf = dateLeaves[0];
        const holder = Array.from(document.querySelectorAll('[id], [name], [data-form-field-name]')).find((node) =>
          node.getAttribute('id') === identity.holderValue || node.getAttribute('name') === identity.holderValue || node.getAttribute('data-form-field-name') === identity.holderValue
        );
        const roots = pickerRoots(holder);
        const rootIndex = roots.indexOf(wrapper);
        if (rootIndex >= 0 && dateLeaves[rootIndex]) leaf = dateLeaves[rootIndex];
        return [`${identity.array}[${identity.index}].${leaf}`];
      }
      return null;
    }

    const seqCounters = {};
    const pickerCounters = {};
    for (const f of results.fields) {
      // 自定义日历/月份范围选择器:按区块重算 paths
      if (f.type === Matcher.T.CUSTOM_PICKER && f.paths) {
        if (f.pathsExplicit) continue;
        const wrapper = pickerWrapperFor(f.el);
        const explicit = explicitPickerPaths(
          f.paths.map((path) => ({ el: f.el, path })),
          wrapper
        );
        if (explicit) {
          f.paths = explicit;
          continue;
        }
        // 全局日期(如个人出生日期)不能因为它位于教育模块内就被改写成 education[x]。
        if (f.paths.every((path) => !/^(education|internships|employment|projects|awards)\[/.test(path))) continue;
        const section = sectionOfField(f.el);
      const arr = section || (f.paths[0] || '').match(/^(education|internships|employment|projects|awards)/)?.[1] || 'education';
      const key = arr + ':picker';
      pickerCounters[key] = pickerCounters[key] || 0;
      const idx = pickerCounters[key]++;
      const isRange = f.paths.length === 2;
      f.paths = f.paths.map((p, i) => {
        const leaf = isRange ? (i === 0 ? 'startDate' : 'endDate') : (String(p).match(/\.([^.]+)$/)?.[1] || 'startDate');
        return `${arr}[${idx}].${leaf}`;
      });
      continue;
    }
    const m = f.path && f.path.match(/^(education|internships|employment|projects|awards)\[(\d+)\]\.(.+)$/);
    if (!m) continue;
    if (f.rowScoped) continue;
    if (f.identity) {
      const key = f.identity.array + '.' + m[3];
      seqCounters[key] = Math.max(seqCounters[key] || 0, f.identity.index + 1);
      continue;
    }
    const section = sectionOfField(f.el);
    const arr = /^(education|internships|employment|projects|awards)$/.test(section || '') ? section : m[1];
    const isRange = /起止/.test(f.label || '');
    if (isRange) {
      const key = arr + ':range';
      seqCounters[key] = seqCounters[key] || 0;
      const i = seqCounters[key];
      f.path = `${arr}[${Math.floor(i / 2)}].${i % 2 === 0 ? 'startDate' : 'endDate'}`;
      seqCounters[key] = i + 1;
    } else {
      const key = arr + '.' + m[3];
      seqCounters[key] = seqCounters[key] || 0;
      f.path = `${arr}[${seqCounters[key]}].${m[3]}`;
      seqCounters[key] += 1;
    }
  }
  return results;
  }

  function handleGroup(el, same, results) {
    const label = groupLabel(same);
    const isRadio = el.type === 'radio';
    const group = {
      kind: isRadio ? 'radio' : 'checkbox-group',
      els: same,
      label,
      path: null,
      type: isRadio ? Matcher.T.RADIO : Matcher.T.CHECKBOX_GROUP,
      qaMatch: null,
    };
    const isQuestion = label.length >= 8;
    if (isRadio) {
      // 长 radio 题干是筛选题,不匹配档案字段
      if (!isQuestion) {
        const m = Matcher.matchField(label, null);
        if (m) {
          const identity = groupIdentity(el);
          const leaf = m.path.match(/\.([^.]+)$/)?.[1];
          group.path = identity && leaf ? `${identity.array}[${identity.index}].${leaf}` : m.path;
        }
      }
      if (isQuestion || !group.path) group.qaMatch = { question: label };
    } else if (same.length > 1) {
      const m = Matcher.matchField(label, null);
      if (m) group.path = m.path;
    }
    results.groups.push(group);
  }

  /** 米哈游等 React 表单把 radio 的 name 留空,用组容器 id 标识 education[index]。 */
  function groupIdentity(el) {
    return semanticIdentity(radioGroupContainer(el) || el) || semanticIdentity(el);
  }

  globalThis.Scanner = { scan, extractLabel, groupLabel, isVisible, semanticIdentity, sectionOfElement, fieldFingerprint };
})();
