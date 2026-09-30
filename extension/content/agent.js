/**
 * agent.js — 局部 DOM 观察、受限 UI 操作和执行后核验。
 * 模型只看到本轮生成的节点 ID；ID 不跨 React 重渲染复用。
 */
(function () {
  'use strict';

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const compact = (value, limit = 100) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
  const visible = (el) => {
    if (!el?.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const dateKey = (value) => {
    const match = String(value || '').match(/(20\d{2}|19\d{2})\D*(\d{1,2})(?:\D+(\d{1,2}))?/);
    if (!match) return null;
    return `${match[1]}-${match[2].padStart(2, '0')}${match[3] ? '-' + match[3].padStart(2, '0') : ''}`;
  };
  function sameValue(current, desired) {
    const a = compact(current, 300);
    const b = compact(desired, 300);
    if (!a || !b) return false;
    const ak = dateKey(a);
    const bk = dateKey(b);
    if (ak && bk) return ak === bk;
    return a.toLowerCase() === b.toLowerCase();
  }

  function resolveTarget(source) {
    let target = source?.trigger || source?.el;
    if (target?.isConnected) return target;
    if (!target) return null;
    let replacement = target.id ? document.getElementById(target.id) : null;
    if (!replacement) {
      const cyRoot = target.closest?.('[data-cy]');
      const cy = cyRoot?.getAttribute('data-cy');
      if (cy) {
        const roots = Array.from(document.querySelectorAll('[data-cy]')).filter((node) => node.getAttribute('data-cy') === cy);
        const root = roots.length === 1 ? roots[0] : null;
        if (root) replacement = root.matches(target.tagName.toLowerCase()) ? root : root.querySelector(target.tagName.toLowerCase());
      }
    }
    if (!replacement && target.name) {
      const hits = Array.from(document.querySelectorAll(target.tagName.toLowerCase())).filter((node) => node.name === target.name);
      if (hits.length === 1) replacement = hits[0];
    }
    if (replacement) {
      if (source.trigger === target) source.trigger = replacement;
      if (source.el === target) source.el = replacement;
    }
    return replacement;
  }

  function fieldRoot(source) {
    const target = resolveTarget(source);
    if (!target) return null;
    return target.closest('[data-cy], [class*="form-item"], [class*="FormItem"], [class*="picker"], [class*="select"]') || target.parentElement || target;
  }

  function selectedValues(source) {
    const target = resolveTarget(source);
    if (!target?.isConnected) return [];
    const root = fieldRoot(source);
    if (target.matches?.('select')) return [target.selectedOptions?.[0]?.textContent?.trim() || target.value];
    if (target.matches?.('input, textarea') && target.value) return [target.value];
    const labels = Array.from(root.querySelectorAll('.atsx-date-picker-period-month-label, [class*="range-picker-input"], [class*="selected-value"], [class*="selection-item"]'))
      .map((node) => compact(node.textContent || node.value)).filter(Boolean);
    if (labels.length) return labels;
    const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"])')).map((node) => compact(node.value)).filter(Boolean);
    if (inputs.length) return inputs;
    const text = compact(target.textContent, 240);
    return text ? [text] : [];
  }

  function readback(source, desired, slot = null) {
    const values = selectedValues(source);
    const wants = Array.isArray(desired) ? desired.map(String) : [String(desired ?? '')];
    if (!wants.length || wants.every((v) => !v)) return { state: 'unknown', current: values };
    if (slot != null && wants.length === 1 && values.length >= 2) {
      return { state: sameValue(values[slot], wants[0]) ? 'verified' : 'mismatch', current: values };
    }
    if (values.length >= wants.length && wants.every((want, i) => sameValue(values[i], want))) {
      return { state: 'verified', current: values };
    }
    return { state: values.some(Boolean) ? 'mismatch' : 'unknown', current: values };
  }

  function panelsNear(target, source, desired) {
    const controlled = target?.getAttribute?.('aria-controls');
    const candidates = Array.from(document.querySelectorAll(
      '[role="dialog"], [role="listbox"], [class*="dropdown"], [class*="popover"], [class*="calendar"], [class*="picker-panel"]'
    )).filter((el) => visible(el) && !el.closest('#__resume_autofill_host__'));
    const rect = target.getBoundingClientRect();
    const previous = source.__observedPanels;
    const wanted = Array.isArray(desired) ? desired.join(' ') : String(desired || '');
    const year = wanted.match(/(?:19|20)\d{2}/)?.[0];
    const scored = candidates.map((el) => {
      const box = el.getBoundingClientRect();
      const distance = Math.abs(box.left - rect.left) + Math.abs(box.top - rect.bottom);
      const linked = controlled && el.id === controlled;
      const fresh = previous && !previous.has(el);
      const relevant = (year && el.textContent?.includes(year)) || (wanted && el.textContent?.includes(wanted));
      return { el, score: (linked ? -10000 : 0) + (fresh ? -5000 : 0) + (relevant ? -500 : 0) + distance };
    }).sort((a, b) => a.score - b.score);
    source.__observedPanels = new Set(candidates);
    const out = [];
    for (const { el } of scored) {
      if (out.some((other) => other.contains(el) || el.contains(other))) continue;
      out.push(el);
      if (out.length === 2) break;
    }
    return out;
  }

  function observe(source, desired) {
    const target = resolveTarget(source);
    if (!target?.isConnected) throw new Error('目标控件已被页面重建，请重新扫描');
    const root = fieldRoot(source);
    const panels = panelsNear(target, source, desired);
    const nodes = new Map();
    const seen = new Set();
    const listed = [];
    const selector = 'input, select, textarea, button, [role="option"], [role="button"], [role="gridcell"], [role="combobox"], [role="radio"], [tabindex], li, [class*="cell"], [class*="year"], [class*="month"]';
    const add = (el) => {
      if (nodes.size >= 140 || !visible(el) || seen.has(el)) return;
      const id = `n${nodes.size + 1}`;
      seen.add(el);
      nodes.set(id, el);
      listed.push({ id, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined,
        text: compact(el.textContent, 80) || undefined, value: 'value' in el ? compact(el.value, 100) : undefined,
        aria: el.getAttribute('aria-label') || undefined, title: el.getAttribute('title') || undefined,
        className: compact(el.className, 80) || undefined });
    };
    add(target);
    for (const scope of [root, ...panels]) {
      if (!scope) continue;
      add(scope);
      for (const el of scope.querySelectorAll(selector)) add(el);
    }
    return {
      nodes,
      page: {
        label: source.label, path: source.path, type: source.type, desired,
        current: selectedValues(source),
        html: compact(root.outerHTML, 1800),
        panels: panels.map((el) => compact(el.outerHTML, 3500)),
        nodes: listed,
      },
    };
  }

  function execute(action, observation) {
    if (action.type === 'done' || action.type === 'manual') return;
    const el = observation.nodes.get(action.nodeId);
    if (!el?.isConnected) throw new Error('操作节点已失效');
    const text = compact(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`, 80);
    if (/提交|删除|移除|保存并提交|submit|delete|remove/i.test(text)) throw new Error('禁止操作提交或删除按钮');
    if (action.type === 'click') { el.click(); return; }
    if (action.type === 'type') {
      if (!el.matches('input, textarea, select')) throw new Error('该节点不可输入');
      globalThis.Filler.setNativeValue(el, action.value);
      return;
    }
    if (action.type === 'scroll') {
      el.scrollTop += action.direction === 'up' ? -280 : 280;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      return;
    }
    if (action.type === 'key') {
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: action.key, bubbles: true }));
    }
  }

  async function repair(source, desired, config, slot = null) {
    const trace = [];
    for (let step = 0; step < 6; step++) {
      const before = readback(source, desired, slot);
      if (before.state === 'verified') return { status: 'filled', value: before.current.join(' ~ '), trace };
      const observation = observe(source, desired);
      const action = await globalThis.AIMapping.nextAction(observation, desired, trace, config);
      if (action.type === 'manual' || action.type === 'done') break;
      execute(action, observation);
      await pause(160);
      trace.push({ action, current: selectedValues(source) });
    }
    const result = readback(source, desired, slot);
    return result.state === 'verified'
      ? { status: 'filled', value: result.current.join(' ~ '), trace }
      : { status: 'need-manual', reason: `AI 操作后仍未读回目标值；当前 ${result.current.join(' ~ ') || '空'}`, trace };
  }

  globalThis.FillAgent = { observe, execute, readback, repair };
})();
