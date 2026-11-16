/* LabDesk · 通用工具 */
(function () {
  const LD = (window.LD = window.LD || {});

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 轻量 DOM 构造器：h('div.card', {attrs}, ...children) */
  function h(spec, attrs, ...children) {
    let tag = 'div', cls = [], id = null;
    const parts = String(spec).split(/(?=[.#])/);
    tag = parts.shift() || 'div';
    parts.forEach((p) => {
      if (p[0] === '.') cls.push(p.slice(1));
      else if (p[0] === '#') id = p.slice(1);
    });
    const el = document.createElement(tag);
    if (cls.length) el.className = cls.join(' ');
    if (id) el.id = id;
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className += ' ' + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    children.flat(3).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return el;
  }

  const uid = () => Math.random().toString(36).slice(2, 9);

  /* ---------- 数值格式化 ---------- */
  function isBlank(v) {
    return v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
  }

  function fmt(v, digits) {
    if (isBlank(v)) return '—';
    if (typeof v !== 'number') return String(v);
    if (!isFinite(v)) return v > 0 ? '∞' : '-∞';
    const d = digits === undefined ? 3 : digits;
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
    return v.toFixed(d);
  }

  /** p 值：<0.001 用科学计数，其余保留 3 位 */
  function fmtP(p) {
    if (p === null || p === undefined || Number.isNaN(p)) return '—';
    if (p < 0.001) return p < 1e-4 ? p.toExponential(1) : p.toFixed(4);
    return p.toFixed(3);
  }

  function stars(p) {
    if (p === null || p === undefined || Number.isNaN(p)) return '';
    if (p < 0.001) return '***';
    if (p < 0.01) return '**';
    if (p < 0.05) return '*';
    return 'ns';
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 宽松数值解析：支持千分位、百分号、全角、科学计数、括号负数 */
  function parseNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    s = s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[\uFF0E]/g, '.').replace(/[\uFF0D\u2212]/g, '-')
      .replace(/[,，\s]/g, '').replace(/[%％]$/, '');
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
      const n = parseFloat(s);
      return neg ? -n : n;
    }
    return NaN;
  }

  function debounce(fn, ms) {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms || 200);
    };
  }

  function download(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
  }

  /* ---------- 提示 ---------- */
  function toast(msg, kind, ms) {
    const host = $('#toastHost');
    const t = h('div.toast' + (kind ? '.' + kind : ''), msg);
    host.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0'; t.style.transform = 'translateY(6px)';
      setTimeout(() => t.remove(), 260);
    }, ms || 2600);
  }

  function modal(title, bodyNode, actions) {
    const host = $('#modalHost');
    host.innerHTML = '';
    host.hidden = false;
    const close = () => { host.hidden = true; host.innerHTML = ''; };
    const box = h('div.modal');
    box.appendChild(h('div.modal-head', h('h3', title), h('button.btn.ghost.sm', { onclick: close }, '关闭')));
    box.appendChild(h('div.modal-body', bodyNode));
    if (actions && actions.length) {
      const foot = h('div.modal-foot');
      actions.forEach((a) => foot.appendChild(h('button.btn' + (a.primary ? '.primary' : ''), { onclick: () => { a.onClick && a.onClick(close); if (a.close !== false) close(); } }, a.label)));
      box.appendChild(foot);
    }
    host.appendChild(box);
    host.onclick = (e) => { if (e.target === host) close(); };
    return close;
  }

  /* ---------- 配色（色盲友好 / 期刊常用） ---------- */
  const PALETTES = {
    'okabe-ito': {
      label: 'Okabe–Ito（色盲友好）',
      colors: ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#F0E442', '#000000'],
    },
    nature: {
      label: 'Nature 经典',
      colors: ['#3B6FB6', '#D1495B', '#2A9D8F', '#E9A03B', '#7B5EA7', '#8D99AE', '#C1666B', '#3D5A40'],
    },
    lancet: {
      label: 'Lancet 暖色',
      colors: ['#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F', '#FDAF91', '#AD002A', '#ADB6B6'],
    },
    ggplot: {
      label: 'ggplot2 默认',
      colors: ['#F8766D', '#7CAE00', '#00BFC4', '#C77CFF', '#00BA38', '#619CFF', '#F564E3', '#B79F00'],
    },
    ocean: {
      label: '深海渐变',
      colors: ['#0B4F6C', '#01BAEF', '#20BF55', '#FBFBFF', '#757575', '#B80C09', '#FBF5F3', '#040F16'],
    },
    grayscale: {
      label: '灰度（黑白印刷）',
      colors: ['#1A1A1A', '#595959', '#8C8C8C', '#BFBFBF', '#E0E0E0', '#404040', '#A6A6A6', '#D9D9D9'],
    },
  };

  function palette(name) {
    return (PALETTES[name] || PALETTES['okabe-ito']).colors;
  }

  /** 把十六进制色转为 rgba，用于透明度控制 */
  function alpha(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallback());
    }
    return Promise.resolve(fallback());
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) { /* noop */ }
      ta.remove(); return true;
    }
  }

  LD.util = {
    $, $$, h, uid, fmt, fmtP, stars, escapeHtml, parseNum, isBlank,
    debounce, download, toast, modal, palette, alpha, clamp, copyText, PALETTES,
  };
})();
