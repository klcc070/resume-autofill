/**
 * components.js — 自定义组件交互适配层
 * 处理不响应常规赋值的组件:自定义下拉框(点击展开+选项匹配)、日历/月份选择器(点击展开+导航+选格)。
 * 策略:点击触发器 → 等待浮层面板出现 → 在面板内按文本相似度点选目标 → 回读验证。
 * 面板通常渲染在 body 末尾的 portal 里,类名因组件库而异,故用多重候选选择器。
 * 依赖:matcher.js(共享 globalThis.Matcher)。
 */
(function () {
  'use strict';
  const getMatcher = () => globalThis.Matcher;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PANEL_SELECTOR = '[class*="dropdown"], [class*="Dropdown"], [class*="calendar"], [class*="panel"], [class*="popup"], [class*="listbox"], [class*="options"], [class*="phoenix-popover"], [role="listbox"]';
  const DISPLAY_SELECTOR = '[class*="display-value"], [class*="selected-value"], [class*="selection-item"], .selected-value';

  function numericText(text) {
    const match = String(text || '').trim().match(/^(\d{1,4})\s*(?:年|月)?$/);
    return match ? Number(match[1]) : null;
  }

  function optionMatches(text, want) {
    const number = numericText(want);
    return number != null ? numericText(text) === number : getMatcher().normalize(text) === getMatcher().normalize(want);
  }

  /** 选中展示值优先于搜索输入，避免 SD Select 的空 input 遮蔽实际值。 */
  function readSelectedValue(control) {
    if (!control) return '';
    if (control.matches?.('select')) return (control.selectedOptions[0]?.textContent || control.value || '').trim();
    const display = control.querySelector?.(DISPLAY_SELECTOR);
    if (display) return String(display.textContent || '').trim();
    const input = control.matches?.('input, textarea') ? control : control.querySelector?.('input:not([type="checkbox"]):not([type="hidden"]), textarea');
    return String(input?.value || '').trim();
  }

  function getDateSelects(root) {
    return Array.from(root?.querySelectorAll('[class*="sd-Select-container-"]') || []).filter((el) =>
      !el.parentElement?.closest('[class*="sd-Select-container-"]')
    );
  }

  function readMonthRange(root) {
    const controls = getDateSelects(root);
    if (controls.length !== 2 && controls.length !== 4) return null;
    const pairs = mokaPairSubSelects(controls, globalThis.__currentFillLabel ? learnedStructure(globalThis.__currentFillLabel) : null).slice(0, controls.length / 2);
    const values = pairs.map(([yi, mi]) => {
      const year = numericText(readSelectedValue(controls[yi]));
      const month = numericText(readSelectedValue(controls[mi]));
      return year >= 1000 && year <= 9999 && month >= 1 && month <= 12
        ? `${year}-${String(month).padStart(2, '0')}` : '';
    });
    if (values.length === 2 && root.querySelector('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]')) values[1] = '至今';
    return values;
  }

  /** 公共读回接口：范围保留开始/结束槽位，不能过滤空值后把后项当作前项。 */
  function readControlValues(target) {
    if (!target) return [];
    if (target.matches?.('.month-range-select')) return readMonthRange(target) || [];
    if (target.matches?.('input, textarea, select')) return [readSelectedValue(target)];
    const labels = Array.from(target.querySelectorAll('.atsx-date-picker-period-month-label, ' + DISPLAY_SELECTOR));
    if (labels.length) return labels.map((node) => String(node.textContent || '').trim());
    const inputs = Array.from(target.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), textarea'));
    if (inputs.length) return inputs.map((input) => input.value || '');
    return [];
  }

  // React 替换节点后，通过所在年月控件及子项索引重新定位，避免继续点旧节点。
  function controlResolver(control) {
    const range = control.closest?.('.month-range-select');
    const rangeIndex = range ? Array.from(document.querySelectorAll('.month-range-select')).indexOf(range) : -1;
    const controlIndex = range ? getDateSelects(range).indexOf(control) : -1;
    const id = control.id;
    return () => {
      if (control.isConnected) return control;
      if (id && document.getElementById(id)) return document.getElementById(id);
      const liveRange = range?.isConnected ? range : document.querySelectorAll('.month-range-select')[rangeIndex];
      return liveRange && controlIndex >= 0 ? getDateSelects(liveRange)[controlIndex] : null;
    };
  }

  /** 完整合成鼠标点击序列（非浏览器 trusted 事件；兼容 mousedown/mouseup 监听）。 */
  function realClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 5 && r.height > 5;
  }

  /** 等待当前触发器关联或本次新展开的浮层，不按全页面目标文本猜面板。 */
  async function waitForPanel(beforeSet, timeoutMs = 2500, wants = null, trigger = null) {
    const choose = (panels) => {
      const related = new Set();
      for (const node of [trigger, ...(trigger?.querySelectorAll?.('[aria-controls], [aria-owns]') || [])]) {
        for (const attr of ['aria-controls', 'aria-owns']) {
          for (const id of (node?.getAttribute?.(attr) || '').split(/\s+/).filter(Boolean)) {
            const root = document.getElementById(id);
            if (root && visible(root)) related.add(root);
          }
        }
      }
      const local = trigger?.closest?.('[class*="Dropdown-container"], [class*="dropdown-container"]');
      const eligible = panels.filter((p) => related.has(p) || Array.from(related).some((root) => root.contains(p)) ||
        (local && local.contains(p) && !p.contains(trigger)) || !beforeSet ||
        (beforeSet instanceof Map ? !beforeSet.get(p) : !beforeSet.has(p)));
      for (const root of related) if (!eligible.includes(root)) eligible.push(root);
      if (!trigger) return eligible[0] || null;
      const rect = trigger?.getBoundingClientRect();
      return eligible.sort((a, b) => {
        const linkedA = related.has(a), linkedB = related.has(b);
        if (linkedA !== linkedB) return linkedA ? -1 : 1;
        if (a.contains(b)) return 1;
        if (b.contains(a)) return -1;
        if (!rect) return 0;
        const distance = (p) => { const r = p.getBoundingClientRect(); return Math.abs(r.left - rect.left) + Math.abs(r.top - rect.bottom); };
        return distance(a) - distance(b);
      })[0] || null;
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const panels = Array.from(document.querySelectorAll(PANEL_SELECTOR)).filter(
        (p) => visible(p) && (p.querySelector('[class*="option"], [role="option"], li, [class*="item"], [class*="cell"], [class*="month"], [class*="date"], td') || p.matches('[role="listbox"]'))
      );
      const panel = choose(panels);
      if (panel) return panel;
      await sleep(80);
    }
    return choose(Array.from(document.querySelectorAll(PANEL_SELECTOR)).filter(visible));
  }

  function snapshotPanels() {
    // 与 waitForPanel 使用同一套全局查询,包含直接挂在 body 上的 portal。
    // 旧实现只查 body 子节点的后代,会漏掉直接挂在 body 的旧性别面板,
    // 导致它被误判为本次新打开的日期面板。
    const panels = Array.from(document.querySelectorAll(PANEL_SELECTOR));
    return new Map(panels.map((p) => [p, visible(p)]));
  }

  function closePanels() {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  }

  /** 找到自定义下拉/选择器的可点击触发器 */
  function findTrigger(el) {
    // 从控件本身或其内部输入向上找可点击容器
    if (el.matches('[role="combobox"]') && el.tagName !== 'INPUT') return el;
    let node = el;
    let fallback = null;
    while (node && node !== document.body) {
      const cls = typeof node.className === 'string' ? node.className : '';
      if (/(^|\s)(ant-select-selector|ud__select__selector|phoenix-select)(\s|$)/.test(cls)) return node;
      if (/(^|\s)sd-Select-container-[^\s]+(?:\s|$)/.test(cls)) return node;
      if (/(^|\s)ant-picker(?:-range)?(?:\s|$)/.test(cls)) return node;
      if (/(^|\s)(?:[^\s]*date-range-picker-wrapper|[^\s]*range-picker-wrapper|throne-biz-date-range-picker)(?:\s|$)/i.test(cls)) return node;
      if (/(^|\s)[^\s]*(?:selector|picker|select)[^\s]*(?:\s|$)/i.test(cls) && !/(search|input|suffix|arrow|clear|content)/i.test(cls)) {
        fallback = fallback || node;
      }
      node = node.parentElement;
    }
    if (fallback) return fallback;
    return el.closest('div, span') || el;
  }

  /** 面板内的选项元素 */
  function panelOptions(panel) {
    return Array.from(
      panel.querySelectorAll(
        '[class*="option"], [role="option"], li, ' +
        '[class~="ud__list__item"], [class~="ud__select__list__item"], [class*="list__item"], ' +
        '[class*="sd-Select-common-item"], [class*="Menu-content-item"], [class*="select-item"], [class*="menu-item"]'
      )
    ).filter((el) => visible(el) && !el.closest('[aria-disabled="true"], [disabled], [class*="item-disabled"], [class*="option-disabled"]'));
  }

  function optionText(el) {
    return (
      el.getAttribute?.('aria-label') ||
      el.getAttribute?.('data-label') ||
      el.getAttribute?.('title') ||
      (el.textContent || '')
    ).replace(/\s+/g, ' ').trim();
  }

  function setInputValue(input, value) {
    const proto = window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Universe/Throne 日期控件的 input 可编辑时,直接输入比逐页导航日历更稳定。 */
  async function fillUniverseEditablePicker(triggerEl, values) {
    const root = triggerEl.matches?.('.ud__picker, .throne-biz-date-range-picker-wrapper')
      ? triggerEl
      : triggerEl.closest?.('.ud__picker, .throne-biz-date-range-picker-wrapper');
    if (!root) return null;
    const inputs = Array.from(root.querySelectorAll('input')).filter((input) => !input.disabled && !input.readOnly);
    if (!inputs.length) return null;
    const filled = [];
    for (let i = 0; i < Math.min(inputs.length, values.length); i++) {
      const input = inputs[i];
      const value = String(values[i]);
      if ((input.value || '').trim()) {
        filled.push(input.value.trim());
        continue;
      }
      input.focus();
      setInputValue(input, value);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.blur();
      await sleep(100);
      if ((input.value || '').trim()) filled.push(input.value.trim());
    }
    closePanels();
    return filled.length
      ? { status: 'filled', value: filled.join(' ~ ') }
      : { status: 'need-manual', reason: '日期输入未被页面接受' };
  }

  function findSearchInput(trigger, panel) {
    const sel = 'input[type="search"], input[role="combobox"]';
    const nodes = [
      ...(trigger ? trigger.querySelectorAll(sel) : []),
      ...(panel ? panel.querySelectorAll(sel) : []),
    ];
    const direct = nodes.find(visible);
    if (direct) return direct;
    // Moka 可搜索下拉:触发器自身的可见文本输入(非 readonly、无已选值)即搜索框
    const inner = trigger && trigger.querySelector ? trigger.querySelector('input[type="text"], input:not([type])') : null;
    if (inner && visible(inner) && !inner.readOnly && !String(inner.value || '').trim()) return inner;
    return null;
  }

  function findOption(options, want) {
    // 目标是纯数字(年份/月份):降序列表里包含匹配必然误选(2021→2121/2126),只认数值相等
    const wantNum = numericText(want);
    let best = null;
    for (const opt of options) {
      const text = optionText(opt).trim();
      if (wantNum != null) {
        if (numericText(text) === wantNum) return { opt, score: 1000 };
        continue;
      }
      const s = getMatcher().optionScore(text, want);
      if (s > 0 && (!best || s > best.score)) best = { opt, score: s };
    }
    return best;
  }

  function findLeafOption(panel, want) {
    if (!panel) return null;
    const norm = (s) => getMatcher().normalize(s || '');
    const wn = norm(want);
    if (!wn) return null;
    const leaves = Array.from(panel.querySelectorAll('*')).filter(
      (e) => e.children.length === 0 && visible(e) && norm(e.textContent) &&
        !e.closest('[aria-disabled="true"], [disabled], [class*="item-disabled"], [class*="option-disabled"]')
    );
    if (numericText(want) != null) return leaves.find((e) => numericText(e.textContent) === numericText(want)) || null;
    const exact = leaves.filter((e) => norm(e.textContent) === wn);
    const partial = leaves.filter((e) => norm(e.textContent).includes(wn));
    return exact[exact.length - 1] || partial[partial.length - 1] || null;
  }

  function findTextChoice(root, variants) {
    const wants = variants.map((v) => getMatcher().normalize(v));
    const candidates = Array.from(
      root.querySelectorAll('li, [role="option"], [class*="list-item"], [class*="picker-item"], [class*="month"], [class*="year"]')
    ).filter((el) => {
      const text = getMatcher().normalize(el.textContent || '');
      return text && wants.includes(text) && !/disabled/i.test(String(el.className));
    });
    const target = candidates.find(visible) || candidates[0] || null;
    if (target && !visible(target)) target.scrollIntoView({ block: 'center' });
    return target;
  }

  /**
   * 填充自定义单选/多选下拉框
   * @returns {Promise<{status: string, value?: string, reason?: string}>}
   */
  async function fillCustomSelect(triggerEl, want, multi) {
    const before = snapshotPanels();
    const trigger = findTrigger(triggerEl);
    const resolve = controlResolver(trigger);
    const wants = Array.isArray(want) ? want.map(String) : [String(want)];
    if (!multi && wants.length === 1 && optionMatches(readSelectedValue(trigger), wants[0])) {
      return { status: 'kept', value: readSelectedValue(trigger) };
    }
    // Moka 等组件需先获得焦点再点按才会弹出面板
    try { if (trigger && trigger.focus) trigger.focus(); } catch {}
    realClick(trigger);
    const panel = await waitForPanel(before, 2500, wants, trigger);
    if (!panel) return { status: 'need-manual', reason: '未找到与当前控件关联的新下拉面板' };
    const clickedTexts = [];
    for (const w of wants) {
      let options = panelOptions(panel);
      let best = findOption(options, w);
      // Ant Design 的可搜索 Select 在打开后先显示搜索框,选项会在输入后异步过滤。
      if (!best && numericText(w) == null) {
        const search = findSearchInput(trigger, panel);
        if (search) {
          setInputValue(search, w);
          await sleep(120);
          options = panelOptions(panel);
          best = findOption(options, w);
        }
      }
      let hit = best?.opt || findLeafOption(panel, w);
      if (!hit) {
        // 找真正的滚动容器（可能是面板自身），对虚拟列表根据当前数值范围确定方向。
        const ancestors = [];
        for (let node = panel.parentElement; node && node !== document.body && !node.contains(trigger); node = node.parentElement) ancestors.push(node);
        const scrollable = [panel, ...panel.querySelectorAll('*'), ...ancestors].filter((node) =>
          visible(node) && node.scrollHeight > node.clientHeight + 20
        ).sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0))[0];
        const visited = new Set();
        for (let step = 0; scrollable && step < 40 && !hit; step++) {
          const numbers = panelOptions(panel).map((option) => numericText(optionText(option))).filter((n) => n != null);
          let direction = 1;
          if (numericText(w) != null && numbers.length >= 2) {
            const descending = numbers[0] > numbers[numbers.length - 1];
            if (numericText(w) > Math.max(...numbers)) direction = descending ? -1 : 1;
            else if (numericText(w) < Math.min(...numbers)) direction = descending ? 1 : -1;
          }
          const previous = scrollable.scrollTop;
          scrollable.scrollTop += direction * Math.max(100, scrollable.clientHeight * 0.8);
          if (scrollable.scrollTop === previous) scrollable.scrollTop += -direction * Math.max(100, scrollable.clientHeight * 0.8);
          const next = scrollable.scrollTop;
          if (next === previous || visited.has(next)) break;
          visited.add(next);
          scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
          await sleep(80);
          options = panelOptions(panel);
          hit = findOption(options, w)?.opt || findLeafOption(panel, w);
        }
      }
      if (!hit) {
        const sample = panelOptions(panel).slice(0, 6).map(optionText).filter(Boolean).join('、');
        return { status: 'need-manual', reason: `当前下拉中未找到目标“${w}”（示例：${sample || '无选项'}），未点击近似数字` };
      }
      const chosenText = optionText(hit);
      realClick(hit);
      clickedTexts.push(chosenText);
      await sleep(120);
      if (numericText(w) != null) {
        const actual = readSelectedValue(resolve());
        if (!optionMatches(actual, w)) return { status: 'need-manual', reason: `目标 ${w} 未被控件接受；读回 ${actual || '空'}` };
      }
    }
    if (!multi) closePanels();
    return { status: 'filled', value: clickedTexts.join('、') };
  }

  /** 解析面板头部当前显示的年月,如 "2026年9月" / "2026-09" / "Sep 2026" */
  function readPanelMonth(panel) {
    const headers = Array.from(panel.querySelectorAll('[class*="header"], [class*="Header"]')).filter(visible);
    const header = headers.find((node) => /\d{4}/.test(node.textContent || '')) || headers[0];
    const t = header ? header.textContent : (panel.textContent || '').slice(0, 60);
    const cn = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月?/);
    if (cn) return { y: Number(cn[1]), m: Number(cn[2]) };
    // Ant Design 的 month picker 标题只有年份,月份以 1月~12月格子显示。
    const yearOnly = t.match(/(\d{4})\s*年/);
    if (yearOnly) return { y: Number(yearOnly[1]), m: null };
    if (panel.querySelector('.phoenix-calendar-month-panel')) {
      const phoenixYear = t.match(/(?:^|\D)(\d{4})(?:\D|$)/);
      if (phoenixYear) return { y: Number(phoenixYear[1]), m: null };
    }
    const en = t.match(/([A-Za-z]{3,9})\s*(\d{4})/);
    if (en) {
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const mi = months.findIndex((x) => en[1].toLowerCase().startsWith(x));
      if (mi >= 0) return { y: Number(en[2]), m: mi + 1 };
    }
    const num = t.match(/(\d{4})[\/\-\.](\d{1,2})/);
    if (num) return { y: Number(num[1]), m: Number(num[2]) };
    return null;
  }

  /** 点击面板中的前/后月导航按钮 */
  function clickNav(panel, forward) {
    const cls = forward ? 'next' : 'prev';
    const btns = Array.from(
      panel.querySelectorAll(`[class*="${cls}"], [class*="${forward ? 'right' : 'left'}-arrow"], [class*="${forward ? 'next' : 'pre'}-"]`)
    ).filter((b) => visible(b) && (b.tagName === 'BUTTON' || b.matches('[class*="icon"], [class*="btn"], button, span, i') || b.onclick));
    if (btns.length) {
      realClick(btns[0]);
      return true;
    }
    // Ant Design 5 使用 ant-picker-header-(super-)?prev/next-btn;
    // 某些主题只保留通用 header-btn 类,此时按按钮的 aria/title/class 方向判断。
    const header = panel.querySelector('[class*="picker-panel-header"], [class*="calendar-header"], [class*="panel-header"]');
    const headerButtons = header ? Array.from(header.querySelectorAll('button, [role="button"]')) : [];
    const direction = forward ? /next|right|后|下/i : /prev|previous|left|前|上/i;
    const directed = headerButtons.filter((b) => direction.test(`${b.className || ''} ${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`));
    const target = directed[0] || (headerButtons.length ? headerButtons[forward ? headerButtons.length - 1 : 0] : null);
    if (target) {
      realClick(target);
      return true;
    }
    return false;
  }

  /** 把日历导航到目标年月(最多 240 步) */
  async function navigateToMonth(panel, ty, tm) {
    for (let i = 0; i < 600; i++) {
      const cur = readPanelMonth(panel);
      if (cur) {
        if (cur.y === ty && (cur.m === tm || cur.m == null)) return true;
        // 面板里直接有年/月下拉(如 select 形式)时优先改下拉
        const selects = Array.from(panel.querySelectorAll('select'));
        if (selects.length >= 2) {
          const [ys, ms] = selects;
          const yOpt = Array.from(ys.options).find((o) => Number(o.value) === ty || o.textContent.includes(String(ty)));
          const mOpt = Array.from(ms.options).find((o) => Number(o.value) === tm || o.textContent.match(new RegExp(`^0?${tm}月?$`)));
          if (yOpt && yOpt.selected === false) {
            ys.value = yOpt.value;
            ys.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (mOpt && mOpt.selected === false) {
            ms.value = mOpt.value;
            ms.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await sleep(150);
          continue;
        }
        // Phoenix 日历同时提供前/后年按钮；跨年时直接按年跳转，避免出生日期逐月点击数百次。
        if (cur.m != null && cur.y !== ty) {
          const yearButton = panel.querySelector(
            cur.y < ty ? '.phoenix-calendar-next-year-btn' : '.phoenix-calendar-prev-year-btn'
          );
          if (yearButton && visible(yearButton)) {
            realClick(yearButton);
            await sleep(100);
            continue;
          }
        }
        // Phoenix 的 DOM 中“上一年”通常排在“上一月”之前。若使用模糊的 prev/next
        // 选择器，同年回退月份时会误点上一年，继而在目标年与前一年之间来回震荡。
        if (cur.m != null && cur.y === ty && cur.m !== tm) {
          const monthButton = panel.querySelector(
            cur.m < tm ? '.phoenix-calendar-next-month-btn' : '.phoenix-calendar-prev-month-btn'
          );
          if (monthButton && visible(monthButton)) {
            realClick(monthButton);
            await sleep(100);
            continue;
          }
        }
        const currentPoint = cur.m == null ? cur.y : cur.y * 12 + cur.m;
        const targetPoint = cur.m == null ? ty : ty * 12 + tm;
        if (currentPoint < targetPoint) {
          if (!clickNav(panel, true)) return false;
        } else if (currentPoint > targetPoint) {
          if (!clickNav(panel, false)) return false;
        } else return true;
      } else {
        return false;
      }
      await sleep(100);
    }
    return false;
  }

  /** 点击面板中匹配的日/月格 */
  function pickCell(panel, kind, target) {
    const cells = Array.from(panel.querySelectorAll('td, [class*="cell"], [class*="day"], [class*="month"]')).filter(
      (c) => visible(c) && !/disabled/i.test(c.className) && !(c.className || '').includes('prev-month') && !(c.className || '').includes('next-month')
    );
    if (kind === 'month') {
      const mm = Number(target.m);
      const phoenixMonths = Array.from(panel.querySelectorAll('.phoenix-calendar-month-panel-month')).filter(
        (c) => visible(c) && !c.closest('.phoenix-calendar-month-panel-cell-disabled')
      );
      for (const c of phoenixMonths) {
        const t = (c.textContent || '').replace(/\s+/g, '');
        if (Number(t) === mm || t === `${mm}月` || t === `${String(mm).padStart(2, '0')}月`) {
          realClick(c);
          return true;
        }
      }
      for (const c of cells) {
        const t = (c.textContent || '').replace(/\s+/g, '');
        if (Number(t) === mm || t === `${mm}月` || t === `${String(mm).padStart(2, '0')}月`) {
          realClick(c);
          return true;
        }
      }
      return false;
    }
    const dd = String(Number(target.d));
    const phoenixDays = Array.from(panel.querySelectorAll('.phoenix-calendar-date')).filter(
      (c) => visible(c) && !c.closest('.phoenix-calendar-disabled-cell, .phoenix-calendar-last-month-cell')
    );
    for (const c of phoenixDays) {
      const t = (c.textContent || '').replace(/\s+/g, '');
      if (t === dd || t === `${dd}日`) {
        realClick(c);
        return true;
      }
    }
    for (const c of cells) {
      const t = (c.textContent || '').replace(/\s+/g, '');
      if (t === dd || t === `${dd}日`) {
        realClick(c);
        return true;
      }
    }
    return false;
  }

  function atsxCurrentValues(trigger) {
    const labels = Array.from(trigger.querySelectorAll('[class~="atsx-date-picker-period-month-label"]'));
    return labels.map((label) => {
      const text = (label.textContent || '').replace(/\s+/g, '');
      const m = text.match(/(\d{4}).*?(\d{1,2})/);
      return m ? `${m[1]}-${String(Number(m[2])).padStart(2, '0')}` : '';
    });
  }

  async function fillAtsxPeriodPicker(trigger, values) {
    const current = atsxCurrentValues(trigger);
    if (current.length >= values.length && current.slice(0, values.length).every(Boolean)) {
      // 站点常从附件简历预填起止时间,其解析可能出错(如把 2026-01 解析成 2025-12)。
      // 防覆盖原则下保留现值,但与档案不一致时必须显式报告,而不是静默 kept。
      const want = values.map((v) => {
        const m = String(v).match(/^(\d{4})[-/.年](\d{1,2})/);
        return m ? `${m[1]}-${String(Number(m[2])).padStart(2, '0')}` : String(v);
      });
      const got = current.slice(0, values.length);
      const same = got.every((c, i) => c === want[i]);
      return same
        ? { status: 'kept', value: got.join(' ~ ') }
        : { status: 'kept-mismatch', value: got.join(' ~ '), reason: `当前值与档案不一致(档案为 ${want.join(' ~ ')}),已保留现值,请人工核对` };
    }
    const clickTargets = Array.from(trigger.querySelectorAll('[class~="atsx-date-picker-period-month-label"]')).filter(visible);
    const results = [];
    for (let i = 0; i < values.length; i++) {
      const match = String(values[i]).match(/^(\d{4})[\/\-\.年](\d{1,2})/);
      if (!match) continue;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const before = snapshotPanels();
      realClick(clickTargets[i] || trigger);
      let panel = await waitForPanel(before, 3000);
      if (!panel) {
        panel = Array.from(document.querySelectorAll('[class*="period-month-panel"], [class*="mdatepicker-popup"], [class*="calendar"]')).find(visible) || null;
      }
      if (!panel) return { status: 'need-manual', reason: '年月面板未能展开' };

      let lists = Array.from(panel.querySelectorAll('[class~="atsx-date-picker-period-month-panel-list"], [class~="rmc-picker-content"]')).filter(visible);
      const yearRoot = lists[0] || panel;
      const yearChoice = findTextChoice(yearRoot, [String(year), `${year}年`]);
      if (!yearChoice) return { status: 'need-manual', reason: `年月面板中未找到 ${year} 年` };
      realClick(yearChoice);
      await sleep(120);

      lists = Array.from(panel.querySelectorAll('[class~="atsx-date-picker-period-month-panel-list"], [class~="rmc-picker-content"]')).filter(visible);
      const monthRoot = lists[1] || panel;
      const monthChoice = findTextChoice(monthRoot, [String(month), String(month).padStart(2, '0'), `${month}月`, `${String(month).padStart(2, '0')}月`]);
      if (!monthChoice) return { status: 'need-manual', reason: `年月面板中未找到 ${month} 月` };
      realClick(monthChoice);
      await sleep(150);

      const confirm = Array.from(panel.querySelectorAll('button, [role="button"]')).find((el) => visible(el) && /^(确定|完成|ok)$/i.test((el.textContent || '').trim()));
      if (confirm) realClick(confirm);
      results.push(`${year}-${String(month).padStart(2, '0')}`);
      await sleep(150);
    }
    closePanels();
    return results.length ? { status: 'filled', value: results.join(' ~ ') } : { status: 'no-value' };
  }

  /** Moka 月份范围由四个独立 Select 组成：开始年/月、结束年/月。 */
  /** 摩卡年月子下拉通用配对:角色(年/月)按占位符与现值识别,start/end 按 x 坐标(隐藏时回退 DOM 序) */
  /** 学习到的结构提示:filler 注入的 learned[host].fields[norm(label)].structure */
  function learnedStructure(label) {
    try {
      const cache = (globalThis.__learnedStructures ||= {});
      if (cache.__loaded !== true) return null;
      return cache[globalThis.Matcher.normalize(label || '')] || null;
    } catch { return null; }
  }

  function mokaPairSubSelects(unique, hint) {
    // 站点学习到的占位符序列(如 年,月,年,月):按提示配对,免几何探测
    if (hint && Array.isArray(hint.subs) && hint.subs.filter(Boolean).length >= Math.min(4, unique.length)) {
      const roles = hint.subs.slice(0, unique.length).map((ph) => (/年/.test(ph || '') ? 'Y' : /月/.test(ph || '') ? 'M' : '?'));
      const yIdx = roles.map((r, i) => (r === 'Y' ? i : -1)).filter((i) => i >= 0);
      const mIdx = roles.map((r, i) => (r === 'M' ? i : -1)).filter((i) => i >= 0);
      if (yIdx.length >= 2 && mIdx.length >= 2) return [[yIdx[0], mIdx[0]], [yIdx[1], mIdx[1]]];
    }
    const roles = unique.map((el) => {
      const inp = el.querySelector('input');
      const ph = (inp && inp.placeholder) || '';
      const val = readSelectedValue(el);
      if (/年|year/i.test(ph)) return 'Y';
      if (/月|month/i.test(ph)) return 'M';
      if (/^\d{4}$/.test(val)) return 'Y';
      if (/^\d{1,2}$/.test(val)) return 'M';
      return '?';
    });
    const xOf = (i) => {
      const r = unique[i].getBoundingClientRect();
      return r.left || unique[i].offsetLeft || i * 100;
    };
    const yIdx = roles.map((r, i) => (r === 'Y' ? i : -1)).filter((i) => i >= 0);
    const mIdx = roles.map((r, i) => (r === 'M' ? i : -1)).filter((i) => i >= 0);
    // 默认布局 年月|年月(按 DOM 序两两一组);角色可辨且数量齐时,按坐标重组
    if (roles.every((role, i) => role === '?' || role === (i % 2 ? 'M' : 'Y'))) {
      return Array.from({ length: unique.length / 2 }, (_, i) => [i * 2, i * 2 + 1]);
    }
    if (yIdx.length >= 2 && mIdx.length >= 2) {
      const ys = yIdx.slice(0, 2).sort((a, b) => xOf(a) - xOf(b));
      const restM = mIdx.slice();
      const near = (y) => restM.reduce((best, m2) => (Math.abs(xOf(m2) - xOf(y)) < Math.abs(xOf(best) - xOf(y)) ? m2 : best), restM[0]);
      const m1 = near(ys[0]);
      restM.splice(restM.indexOf(m1), 1);
      const m2 = near(ys[1]);
      return [[ys[0], m1], [ys[1], m2]];
    }
    return [[0, 1], [2, 3]];
  }

  function dateParts(root) {
    const controls = getDateSelects(root);
    if (![2, 4].includes(controls.length)) return [];
    return mokaPairSubSelects(controls, globalThis.__currentFillLabel ? learnedStructure(globalThis.__currentFillLabel) : null).slice(0, controls.length / 2).flatMap(([y, m], side) => [
      { el: controls[y], kind: 'year', side }, { el: controls[m], kind: 'month', side },
    ]);
  }

  async function selectDatePart(control, value, kind) {
    const n = numericText(value);
    if (!['year', 'month'].includes(kind) || n == null ||
        (kind === 'year' ? n < 1000 || n > 9999 : n < 1 || n > 12)) {
      return { status: 'need-manual', reason: '年月目标值无效' };
    }
    return fillCustomSelect(control, String(n), false);
  }

  async function fillMokaMonthRange(trigger, values) {
    const index = Array.from(document.querySelectorAll('.month-range-select')).indexOf(trigger);
    const resolve = () => trigger.isConnected ? trigger : document.querySelectorAll('.month-range-select')[index];
    if (!dateParts(trigger).length) return { status: 'need-manual', reason: '月份下拉结构不完整' };
    const wants = [];
    for (let i = 0; i < Math.min(values.length, 2); i++) {
      const value = String(values[i] || '');
      if (!value) { wants.push(''); continue; }
      if (i === 1 && /至今|present|current/i.test(value)) {
        const checkbox = resolve()?.querySelector('input[type="checkbox"]');
        if (checkbox && !checkbox.checked) realClick(checkbox);
        if (readMonthRange(resolve())?.[1] !== '至今') return { status: 'need-manual', reason: '至今未被控件接受' };
        wants.push('至今');
        continue;
      }
      const match = value.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
      if (!match || +match[2] < 1 || +match[2] > 12) return { status: 'need-manual', reason: '日期格式无效' };
      if (i === 1) {
        const checkbox = resolve()?.querySelector('input[type="checkbox"]');
        if (checkbox?.checked) realClick(checkbox);
      }
      for (const [kind, partValue] of [['year', match[1]], ['month', match[2]]]) {
        const part = dateParts(resolve()).find((p) => p.side === i && p.kind === kind);
        if (!part) return { status: 'need-manual', reason: '开始/结束年月下拉数量不足' };
        const result = await selectDatePart(part.el, partValue, kind);
        if (!['filled', 'kept'].includes(result.status)) return result;
      }
      wants.push(`${match[1]}-${match[2].padStart(2, '0')}`);
    }
    const actual = readMonthRange(resolve()) || [];
    if (!wants.some(Boolean)) return { status: 'no-value' };
    if (!wants.every((want, i) => !want || actual[i] === want)) return { status: 'need-manual', reason: `年月读回不一致：${actual.join(' ~ ')}` };
    return { status: 'filled', value: actual.join(' ~ ') };
  }

  /**
   * 填充日历/月份选择器(支持范围:两次点选)
   * @param {HTMLElement} triggerEl 触发输入框或容器
   * @param {string[]} values ['YYYY-MM-DD'|'YYYY-MM', ...] 一个或两个
   */
  async function fillCustomPicker(triggerEl, values) {
    const before = snapshotPanels();
    const trigger = findTrigger(triggerEl);
    const universeResult = await fillUniverseEditablePicker(triggerEl, values);
    if (universeResult) return universeResult;
    if (trigger && /(^|\s)atsx-date-picker-period-month(?:\s|$)/.test(String(trigger.className))) {
      return fillAtsxPeriodPicker(trigger, values);
    }
    if (trigger?.matches?.('.month-range-select')) return fillMokaMonthRange(trigger, values);
    realClick(trigger);
    const panel = await waitForPanel(before, 3000);
    if (!panel) return { status: 'need-manual', reason: '日历面板未能展开' };

    const results = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const m = v.match(/^(\d{4})[\/\-\.年](\d{1,2})(?:[\/\-\.月](\d{1,2}))?/);
      if (!m) continue;
      const target = { y: Number(m[1]), m: Number(m[2]), d: m[3] ? Number(m[3]) : null };
      const isMonthOnly = !target.d;
      if (!(await navigateToMonth(panel, target.y, target.m))) {
        closePanels();
        return { status: 'need-manual', reason: `无法导航到 ${target.y}年${target.m}月` };
      }
      if (!pickCell(panel, isMonthOnly ? 'month' : 'day', target)) {
        closePanels();
        return { status: 'no-option', reason: `未找到${isMonthOnly ? '月' : '日'}格 ${v}` };
      }
      results.push(v);
      await sleep(200);
    }
    closePanels();
    if (!results.length) return { status: 'no-value' };
    return { status: 'filled', value: results.join(' ~ ') };
  }

  globalThis.Components = { fillCustomSelect, fillCustomPicker, waitForPanel, closePanels,
    readSelectedValue, readControlValues, readMonthRange, dateParts, selectDatePart, realClick };
})();
