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

  /** 真实鼠标点击序列(部分组件只监听 mousedown/mouseup) */
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

  /** 等待浮层面板:优先返回包含目标选项的面板,避免多个 portal 串面板。 */
  async function waitForPanel(beforeSet, timeoutMs = 2500, wants = null) {
    const PANEL_CANDIDATES =
      '[class*="dropdown"], [class*="Dropdown"], [class*="picker-dropdown"], [class*="calendar"], [class*="panel"], [class*="popup"], [class*="listbox"], [class*="options"], [class*="phoenix-popover"], [class*="phoenix-dropdown"], [role="listbox"]';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const panels = Array.from(document.querySelectorAll(PANEL_CANDIDATES)).filter(
        (p) => visible(p) && (p.querySelector('[class*="option"], [role="option"], li, [class*="item"], [class*="cell"], [class*="month"], [class*="date"], td') || p.matches('[role="listbox"]'))
      );
      // 部分组件会复用同一个 portal 节点,点击后只从 display:none 变为可见,
      // 因此不能只判断节点是否新建。
      const freshPanels = panels.filter((p) => {
        if (!beforeSet) return true;
        if (beforeSet instanceof Map) return !beforeSet.has(p) || !beforeSet.get(p);
        return !beforeSet.has(p);
      });
      const wanted = Array.isArray(wants) ? wants.map(String) : wants == null ? [] : [String(wants)];
      const matching = wanted.length
        ? freshPanels.find((p) => panelOptions(p).some((option) => wanted.some((want) => getMatcher().optionScore(optionText(option), want) > 0)))
        : null;
      if (matching) return matching;
      // 搜索型下拉可能先只挂载空面板(输入后才过滤出选项),此时仍返回新面板,让调用方进行搜索。
      if (freshPanels.length) return freshPanels[0];
      await sleep(80);
    }
    // 超时后只允许回退到“新出现”的面板,绝不把调用前已存在的性别/学历面板当成当前面板。
    const panels = Array.from(document.querySelectorAll(PANEL_CANDIDATES)).filter(visible);
    const freshPanels = panels.filter((p) => {
      if (!beforeSet) return true;
      if (beforeSet instanceof Map) return !beforeSet.has(p) || !beforeSet.get(p);
      return !beforeSet.has(p);
    });
    return freshPanels[0] || null;
  }

  function snapshotPanels() {
    // 与 waitForPanel 使用同一套全局查询,包含直接挂在 body 上的 portal。
    // 旧实现只查 body 子节点的后代,会漏掉直接挂在 body 的旧性别面板,
    // 导致它被误判为本次新打开的日期面板。
    const panels = Array.from(document.querySelectorAll(
      '[class*="dropdown"], [class*="calendar"], [class*="panel"], [class*="popup"], ' +
      '[class*="phoenix-popover"], [class*="phoenix-dropdown"], [role="listbox"]'
    ));
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
    ).filter(visible);
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
    const wantNum = /^\d{1,4}$/.test(String(want).trim()) ? String(Number(want)) : null;
    let best = null;
    for (const opt of options) {
      const text = optionText(opt).trim();
      if (wantNum != null) {
        if (/^\d{1,4}$/.test(text) && Number(text) === Number(want)) return { opt, score: 1000 };
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
      (e) => e.children.length === 0 && visible(e) && norm(e.textContent)
    );
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
    const wants = Array.isArray(want) ? want.map(String) : [String(want)];
    // Moka 等组件需先获得焦点再点按才会弹出面板
    try { if (trigger && trigger.focus) trigger.focus(); } catch {}
    realClick(trigger);
    let panel = await waitForPanel(before, 2500, wants);
    if (!panel) {
      // 可能已展开:尝试全页面找可见面板
      panel = Array.from(document.querySelectorAll('[role="listbox"], [class*="dropdown"], [class*="select__dropdown"]')).find(visible) || null;
      if (!panel) return { status: 'need-manual', reason: '下拉面板未能展开' };
    }
    let options = panelOptions(panel);
    let clicked = 0;
    const clickedTexts = [];
    for (const w of wants) {
      let best = findOption(options, w);
      // Ant Design 的可搜索 Select 在打开后先显示搜索框,选项会在输入后异步过滤。
      if (!best) {
        const search = findSearchInput(trigger, panel);
        if (search) {
          setInputValue(search, w);
          await sleep(120);
          options = panelOptions(panel);
          best = findOption(options, w);
        }
      }
      if (best) {
        realClick(best.opt);
        clicked += 1;
        clickedTexts.push(optionText(best.opt).slice(0, 20));
        await sleep(120);
      }
    }
    // 兜底:不依赖类名,遍历面板可见叶子节点,文本与目标一致的直接点选。
    // 长列表(虚拟滚动)兜底:逐屏滚动扫描目标文本,找到即点选
    if (clicked === 0 && panel) {
      const scrollable = Array.from(panel.querySelectorAll('[class*="scroll"], [class*="menu"], ul, [role="listbox"]')).find(
        (s) => visible(s) && s.scrollHeight > s.clientHeight + 50
      ) || panel;
      for (let step = 0; step < 30 && clicked === 0; step++) {
        const before2 = clicked;
        for (const w of wants) {
          const hit = findLeafOption(scrollable, w);
          if (hit) { realClick(hit); clicked += 1; break; }
        }
        if (clicked > before2) break;
        const prevTop = scrollable.scrollTop;
        scrollable.scrollTop = prevTop + Math.max(240, scrollable.clientHeight * 0.75);
        await sleep(70);
        if (scrollable.scrollTop === prevTop) {
          scrollable.scrollTop = Math.max(0, prevTop - Math.max(240, scrollable.clientHeight * 0.75));
          await sleep(60);
          for (const w of wants) {
            const hit2 = findLeafOption(scrollable, w);
            if (hit2) { realClick(hit2); clicked += 1; break; }
          }
          break;
        }
      }
    }

    for (const w of wants) {
      if (clickedTexts.some((t) => getMatcher().optionScore(t, w) > 0)) continue;
      const hit = findLeafOption(panel, w);
      if (hit) {
        realClick(hit);
        clicked += 1;
        clickedTexts.push(optionText(hit).slice(0, 20));
        await sleep(150);
      }
    }
    if (clicked === 0) {
      // 兜底:面板变量可能抓错节点,对页面上所有可见下拉 portal 重试叶子点选
      const portals = Array.from(
        document.querySelectorAll('[class*="Dropdown-dropdown"], [class*="select__dropdown"], [class*="dropdown"], [role="listbox"]')
      ).filter(visible);
      for (const portal of portals) {
        for (const w of wants) {
          if (clickedTexts.some((t) => getMatcher().optionScore(t, w) > 0)) break;
          const hit = findLeafOption(portal, w);
          if (hit) {
            realClick(hit);
            clicked += 1;
            clickedTexts.push(optionText(hit).slice(0, 20));
            await sleep(150);
          }
        }
      }
    }
    if (clicked === 0) {
      // 未匹配到选项:面板保持打开,方便用户手动选择
      const sample = options.slice(0, 6).map(optionText).filter(Boolean).join('、');
      return {
        status: 'need-manual',
        reason: options.length
          ? `已读取 ${options.length} 个选项但未匹配到目标“${wants.join('、')}”（示例：${sample}）,面板已保持打开,请手动点选`
          : '面板已展开但未读取到可见选项,面板已保持打开,请手动点选',
      };
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
  async function fillMokaMonthRange(trigger, values) {
    const selects = Array.from(trigger.querySelectorAll('[class*="sd-Select-container-"]')).filter((el) => {
      const cls = String(el.className || '');
      return /(^|\s)sd-Select-container-[^\s]+(?:\s|$)/.test(cls) && !el.parentElement?.closest('[class*="sd-Select-container-"]');
    });
    const unique = Array.from(new Set(selects));
    if (unique.length < 2) return { status: 'need-manual', reason: '月份下拉结构不完整' };
    const filled = [];
    for (let i = 0; i < Math.min(values.length, 2); i++) {
      const value = String(values[i] || '');
      if (i === 1 && /至今|present|current/i.test(value)) {
        const checkbox = trigger.querySelector('input[type="checkbox"]');
        if (checkbox && !checkbox.checked) realClick(checkbox);
        filled.push('至今');
        continue;
      }
      const match = value.match(/^(\d{4})-(\d{1,2})/);
      if (!match) continue;
      const yearTrigger = unique[i * 2];
      const monthTrigger = unique[i * 2 + 1];
      if (!yearTrigger || !monthTrigger) return { status: 'need-manual', reason: '开始/结束年月下拉数量不足' };
      const yearResult = await fillCustomSelect(yearTrigger, match[1], false);
      if (yearResult.status !== 'filled' && yearResult.status !== 'kept') return yearResult;
      const monthResult = await fillCustomSelect(monthTrigger, String(Number(match[2])), false);
      if (monthResult.status !== 'filled' && monthResult.status !== 'kept') return monthResult;
      filled.push(`${match[1]}-${match[2].padStart(2, '0')}`);
    }
    return filled.length ? { status: 'filled', value: filled.join(' ~ ') } : { status: 'no-value' };
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

  globalThis.Components = { fillCustomSelect, fillCustomPicker, waitForPanel, closePanels };
})();
