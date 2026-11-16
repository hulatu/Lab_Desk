/* ==========================================================================
   整理清洗 — 数据体检 + 操作面板 + 应用前预估
   --------------------------------------------------------------------------
   设计要点：
   1. 先告诉用户「你的数据现在有什么问题」，而不是先甩 15 个操作让他自己找。
      每条问题旁边直接给可执行的一键修复。
   2. 操作按用途分四组，左栏点选、右栏只显示一个操作的表单，避免一屏铺满。
   3. 点「应用到数据」之前就显示结果会变成多少行多少列，误操作在动手前就能看出来。
   ========================================================================== */
(function () {
  const U = window.LD.util;
  const h = U.h;

  const OP_GROUPS = [
    { name: '缺失与异常', ops: ['missing', 'outlier'] },
    { name: '行与列', ops: ['dedupe', 'filter', 'sort', 'sampleRows', 'dropcol', 'rename', 'round'] },
    { name: '计算与变换', ops: ['transform', 'derive', 'bin'] },
    { name: '重塑与汇总', ops: ['aggregate', 'melt', 'pivot'] },
  ];

  const TYPE_LABEL = { number: '数值', category: '分类', text: '文本', date: '日期', empty: '空列' };

  let curOp = 'missing';
  let opValues = {};
  // 用户点了「新增标记列」这类不改动原数据的修复后，把那条提示收起来，
  // 否则点完还挂着同一条，会让人以为没生效。
  const dismissed = new Set();
  let searchTerm = '';
  let bound = false;
  let lastDsId = null;

  const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  const defByKey = (k) => window.LD.ops.OP_DEFS.find((d) => d.key === k) || null;

  /* ======================================================================
     一、数据体检
     ====================================================================== */
  function audit(ds) {
    const out = [];
    if (!ds || !ds.rows.length) return out;
    const n = ds.rows.length;
    const cols = ds.columns;

    /* --- 逐列：空列 / 缺失 / 常数列 --- */
    cols.forEach((c, i) => {
      const vals = ds.rows.map((r) => r[i]);
      const blanks = vals.filter(isBlank).length;
      const uniq = new Set(vals.filter((v) => !isBlank(v)));

      if (blanks === n) {
        out.push({
          level: 'warn',
          title: `「${c.name}」整列为空`,
          detail: '这一列没有任何有效数据。留着它会让变量下拉框变长，还可能让统计检验把整行当成缺失剔掉。',
          fixes: [{ label: '删除该列', op: 'dropcol', params: { cols: [c.name] } }],
        });
        return;
      }

      if (blanks > 0) {
        const pct = (blanks / n) * 100;
        const where = ds.rows
          .map((r, k) => (isBlank(r[i]) ? k + 1 : null))
          .filter((v) => v !== null)
          .slice(0, 6);
        const isNum = c.type === 'number';
        out.push({
          level: pct > 30 ? 'error' : 'warn',
          title: `「${c.name}」有 ${blanks} 个空值（${pct.toFixed(1)}%）`,
          detail:
            `第 ${where.join('、')}${blanks > 6 ? ' 等' : ''} 行。` +
            (isNum
              ? '数值列的缺失会直接减少检验的自由度，均值与标准差也会偏。'
              : '分类列的空值会被当成一个独立分组，容易多出一组「未知」。'),
          fixes: isNum
            ? [
                { label: '中位数填充', op: 'missing', params: { cols: [c.name], action: 'median' } },
                { label: '均值填充', op: 'missing', params: { cols: [c.name], action: 'mean' } },
                { label: '删除这些行', op: 'missing', params: { cols: [c.name], action: 'drop' } },
              ]
            : [
                { label: '众数填充', op: 'missing', params: { cols: [c.name], action: 'mode' } },
                { label: '删除这些行', op: 'missing', params: { cols: [c.name], action: 'drop' } },
              ],
        });
      }

      if (uniq.size === 1 && blanks < n) {
        out.push({
          level: 'info',
          title: `「${c.name}」所有行都是同一个值（${[...uniq][0]}）`,
          detail: '常数变量没有方差，不能作响应变量，做相关或回归时也会被自动剔除。',
          fixes: [{ label: '删除该列', op: 'dropcol', params: { cols: [c.name] } }],
        });
      }
    });

    /* --- 重复行 --- */
    if (n <= 50000) {
      const seen = new Map();
      const dupAt = [];
      ds.rows.forEach((r, k) => {
        const key = r.map((v) => (isBlank(v) ? '\u0000' : String(v))).join('\u0001');
        if (seen.has(key)) dupAt.push(k + 1);
        else seen.set(key, k);
      });
      if (dupAt.length) {
        out.push({
          level: 'warn',
          title: `有 ${dupAt.length} 行与前面的行完全相同`,
          detail:
            `出现在第 ${dupAt.slice(0, 6).join('、')}${dupAt.length > 6 ? ' 等' : ''} 行。` +
            '如果是重复测量的真实记录请保留；如果是复制粘贴或仪器重复导出，建议删掉。',
          fixes: [{ label: '删除重复行', op: 'dedupe', params: { cols: [] } }],
        });
      }
    }

    /* --- 数值列：IQR 离群点 --- */
    cols.forEach((c, i) => {
      if (c.type !== 'number') return;
      const vals = ds.rows.map((r) => r[i]).filter((v) => typeof v === 'number' && isFinite(v));
      if (vals.length < 8) return;
      const sorted = vals.slice().sort((a, b) => a - b);
      const q = (p) => {
        const hh = (sorted.length - 1) * p;
        const lo = Math.floor(hh), hi = Math.ceil(hh);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (hh - lo);
      };
      const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
      if (!(iqr > 0)) return;
      const lowF = q1 - 1.5 * iqr, highF = q3 + 1.5 * iqr;
      const odd = vals.filter((v) => v < lowF || v > highF);
      if (!odd.length) return;
      const pct = (odd.length / vals.length) * 100;
      // 超过 10% 说明这是分布本身右偏，不是「异常值」，别劝用户删
      if (pct > 10) return;
      out.push({
        level: 'info',
        title: `「${c.name}」有 ${odd.length} 个疑似离群值`,
        detail:
          `超出 ${U.fmt(lowF, 3)} ~ ${U.fmt(highF, 3)} 这个范围（IQR 的 1.5 倍）。` +
          '先判断是真实的极端响应还是记录错误——真实的极端值不该为了「好看」而删。可以先标记，确认后再决定。',
        fixes: [
          { label: '新增标记列', op: 'outlier', params: { cols: [c.name], method: 'iqr', k: 1.5, action: 'flag' }, dismiss: true },
          { label: '缩尾到边界', op: 'outlier', params: { cols: [c.name], method: 'iqr', k: 1.5, action: 'winsor' } },
        ],
      });
    });

    /* --- 文本列里其实是数字 --- */
    cols.forEach((c, i) => {
      if (c.type === 'number') return;
      const vals = ds.rows.map((r) => r[i]).filter((v) => !isBlank(v));
      if (vals.length < 3) return;
      const numericLike = vals.filter((v) => {
        const s = String(v).trim().replace(/,/g, '');
        return s !== '' && isFinite(Number(s));
      }).length;
      if (numericLike / vals.length < 0.9) return;
      out.push({
        level: 'error',
        title: `「${c.name}」存的是数字，但类型被识别成了${TYPE_LABEL[c.type] || '文本'}`,
        detail: '文本列不能算均值、不能做检验、也画不出数值坐标轴。通常是导入时混进了单位、全角数字或空格。',
        fixes: [{ label: '转为数值', op: 'settype', params: { col: c.name, type: 'number' } }],
      });
    });

    /* --- 列名像自动编号（表头没读对） --- */
    const autoNamed = cols.filter((c) => /^(列|column|unnamed)[\s:_-]*\d*$/i.test(String(c.name).trim()));
    if (autoNamed.length >= Math.max(2, Math.ceil(cols.length * 0.5))) {
      out.push({
        level: 'error',
        title: '列名看起来没读对',
        detail:
          `现在的列名是「${autoNamed.slice(0, 3).map((c) => c.name).join('、')}」这类自动编号，` +
          '多半是表格开头几行的标题被当成了数据。建议回「数据接入」重新导入，或在这里用「重命名列」逐个改掉。',
        fixes: [],
      });
    }

    /* --- 编号列（每行唯一） --- */
    cols.forEach((c, i) => {
      if (c.type === 'number') return;
      const vals = ds.rows.map((r) => r[i]).filter((v) => !isBlank(v));
      if (vals.length < 5) return;
      if (new Set(vals).size !== vals.length) return;
      out.push({
        level: 'info',
        title: `「${c.name}」每行都不重复，像是编号列`,
        detail: '这种列不能当分组变量——每组只有 1 个观测，方差分析和箱线图都算不出来。做分组分析时请避开它。',
        fixes: [],
      });
    });

    const rank = { error: 0, warn: 1, info: 2 };
    out.sort((a, b) => (rank[a.level] - rank[b.level]));
    return out;
  }

  /* ======================================================================
     二、渲染
     ====================================================================== */
  function render() {
    const ds = window.LD.app.workDataset();
    if (!ds) return;
    if (ds.id !== lastDsId) { dismissed.clear(); opValues = {}; lastDsId = ds.id; }
    renderAudit(ds);
    renderNav();
    renderPanel(ds);
    renderPreview(ds);
    renderPipe();
    if (!bound) bindPanel();
  }

  /* 只把「不改变数据含义」的修复纳入一键处理：删空列 / 删常数列 / 文本转数值。
     缺失值到底该填中位数还是删行、重复行是否真的是重复测量，都必须由人来判断。 */
  const SAFE_FIX_OPS = { dropcol: 1, settype: 1 };
  function safeFixes(issues) {
    const seen = new Set();
    const out = [];
    (issues || []).forEach((it) => {
      (it.fixes || []).forEach((f) => {
        if (!SAFE_FIX_OPS[f.op]) return;
        const sig = f.op + '|' + JSON.stringify(f.params);
        if (seen.has(sig)) return;
        seen.add(sig);
        out.push({ type: f.op, params: f.params, label: it.title });
      });
    });
    return out;
  }

  function renderAudit(ds) {
    const box = document.getElementById('auditList');
    const tag = document.getElementById('auditSummary');
    if (!box) return;
    const issues = audit(ds).filter((it) => !dismissed.has(it.title));
    const pending = issues.filter((i) => i.level === 'error' || i.level === 'warn').length;

    if (tag) {
      tag.textContent = pending ? `${pending} 项建议处理` : '未发现影响分析的问题';
      tag.className = 'tag' + (pending ? ' warn' : ' ok');
    }
    const fixBtn = document.getElementById('btnAuditFix');
    const safe = safeFixes(issues);
    if (fixBtn) {
      fixBtn.hidden = !safe.length;
      fixBtn.textContent = `一键修复 ${safe.length} 项`;
      fixBtn.title = safe.map((f) => f.label).join('\n');
    }

    box.innerHTML = '';
    if (!issues.length) {
      box.appendChild(
        h('div.audit-item.ok',
          h('span.audit-dot'),
          h('div.audit-body',
            h('strong', '数据是干净的'),
            h('p', '没有缺失值、重复行或类型问题，可以直接进入统计分析。'))));
      return;
    }

    const head = issues.slice(0, 6);
    const rest = issues.slice(6);
    head.forEach((it) => box.appendChild(auditRow(it)));
    if (rest.length) {
      const det = h('details.audit-more');
      det.appendChild(h('summary', { style: { cursor: 'pointer', fontSize: '11.8px', color: '#78828f' } }, `还有 ${rest.length} 条提示`));
      rest.forEach((it) => det.appendChild(auditRow(it)));
      box.appendChild(det);
    }
  }

  function auditRow(it) {    const fixes = h('div.audit-fixes');
    (it.fixes || []).forEach((f, k) => {
      fixes.appendChild(h('button.btn.sm' + (k === 0 ? '.primary' : '.ghost'),
        {
          'data-act': 'cleanFix',
          'data-op': f.op,
          'data-params': JSON.stringify(f.params),
          'data-dismiss': f.dismiss ? '1' : null,
        }, f.label));
    });
    return h('div.audit-item.' + it.level,
      h('span.audit-dot'),
      h('div.audit-body', h('strong', it.title), h('p', it.detail)),
      it.fixes && it.fixes.length ? fixes : null);
  }

  function renderNav() {
    const box = document.getElementById('opNav');
    if (!box) return;
    box.innerHTML = '';
    const q = searchTerm.trim().toLowerCase();
    let shown = 0;

    OP_GROUPS.forEach((g) => {
      const ops = g.ops
        .map(defByKey)
        .filter(Boolean)
        .filter((d) => !q || (d.title + ' ' + d.desc).toLowerCase().includes(q));
      if (!ops.length) return;
      const sec = h('div.op-nav-group', h('div.op-nav-title', g.name));
      ops.forEach((d) => {
        shown++;
        sec.appendChild(h('button.op-nav-item' + (d.key === curOp ? '.on' : ''),
          { 'data-act': 'cleanOp', 'data-op': d.key }, d.title));
      });
      box.appendChild(sec);
    });

    if (!shown) box.appendChild(h('div.op-nav-empty', '没有匹配的操作'));
  }

  /* 有些字段留空的话，后台会拿「第一列」顶替，而第一列往往是样品编号这类编号列，
     分完组每组只剩一个观测。这里按数据实际情况先填一个合理的默认值。 */
  function withDefaults(def, ds) {
    const v = {};
    const names = ds.columns.map((c) => c.name);
    const groups = (window.LD.charts && window.LD.charts.groupCandidates)
      ? window.LD.charts.groupCandidates(ds) : [];
    const nums = ds.columns.filter((c) => c.type === 'number').map((c) => c.name);
    const richness = (n) => {
      const i = names.indexOf(n);
      return i < 0 ? 0 : new Set(ds.rows.map((r) => r[i])).size;
    };
    def.fields.forEach((f) => {
      if (f.type === 'multicol' && f.catOnly) {
        const best = groups.find((n) => {
          const c = ds.columns[names.indexOf(n)];
          return c && c.type !== 'number';
        });
        if (best) v[f.k] = [best];
        return;
      }
      if (f.type === 'column') {
        const list = f.numOnly
          ? nums.slice().sort((a, b) => richness(b) - richness(a))
          : f.catOnly ? groups : (nums.length ? nums : names);
        v[f.k] = list[0] || null;
      }
    });
    return v;
  }

  function renderPanel(ds) {
    const panel = document.getElementById('opPanel');
    if (!panel) return;
    let def = defByKey(curOp);
    if (!def) { def = window.LD.ops.OP_DEFS[0]; curOp = def.key; }

    // 第一次打开某个操作时给一套合理默认值；用户清空过就不再覆盖
    if (!(def.key in opValues)) opValues[def.key] = withDefaults(def, ds);

    // 丢掉已不存在的列（前面的操作把列删掉了）
    const names = ds.columns.map((c) => c.name);
    const raw = opValues[def.key] || {};
    const values = Object.assign({}, raw);
    if (Array.isArray(values.cols)) values.cols = values.cols.filter((n) => names.includes(n));
    if (Array.isArray(values.groupBy)) values.groupBy = values.groupBy.filter((n) => names.includes(n));
    if (Array.isArray(values.idCols)) values.idCols = values.idCols.filter((n) => names.includes(n));
    if (Array.isArray(values.valueCols)) values.valueCols = values.valueCols.filter((n) => names.includes(n));
    // 单列字段指向已被删掉/不存在的列时清掉，否则下拉框显示第一列、实际却按旧列名算
    def.fields.forEach((f) => {
      if (f.type === 'column' && values[f.k] && !names.includes(values[f.k])) delete values[f.k];
    });
    opValues[def.key] = values;

    panel.dataset.op = def.key;
    panel.innerHTML = '';
    panel.appendChild(h('div.op-panel-head', h('h3', def.title), h('p', def.desc)));

    const body = h('div.op-fields');
    def.fields.forEach((f) => {
      if (f.when && !f.when(values)) return;
      const ctrl = window.LD.ui.fieldControl(def, f, values, ds);
      if (f.type === 'multicol' || f.type === 'text') ctrl.classList.add('wide');
      body.appendChild(ctrl);
    });
    panel.appendChild(body);

    // 「计算列」最不直观的是表达式语法（[列名] * 9.807），给一排可点的列名
    if (def.key === 'derive') {
      const input = body.querySelector('input[data-field="expr"]');
      if (input) {
        const help = h('div.expr-help', h('span.expr-help-label', '点列名插入：'));
        ds.columns.forEach((c) => {
          help.appendChild(h('button.btn.ghost.sm',
            { type: 'button', 'data-act': 'cleanInsertCol', 'data-col': c.name }, c.name));
        });
        const holder = input.closest('.field');
        if (holder) holder.appendChild(help);
      }
    }

    const est = estimateHTML(def, values, ds);
    panel.appendChild(h('div.op-estimate' + (est.bad ? '.bad' : ''), { id: 'opEstimate', html: est.html }));
    panel.appendChild(h('div.op-actions',
      h('button.btn.primary', { 'data-act': 'cleanApply', 'data-op': def.key }, '应用到数据'),
      h('button.btn.ghost.sm', { 'data-act': 'cleanReset', 'data-op': def.key }, '重置'),
      h('span.hint', '应用后可在下方操作记录里撤销')));
  }

  /* 用「真的跑一遍」来预估结果，而不是猜 */
  function estimateHTML(def, values, ds) {
    let params;
    try { params = window.LD.ops.buildParams(def, values); } catch (e) { return { html: '参数不完整。' }; }
    const before = `${ds.rows.length} 行 × ${ds.columns.length} 列`;

    if (ds.rows.length > 40000) {
      return { html: `<span class="est-label">应用后</span>数据量较大（${ds.rows.length} 行），应用后再查看结果。` };
    }

    let res;
    try { res = window.LD.ops.apply(ds, [{ type: def.key, params }]); } catch (e) {
      return { html: `<span class="est-label">无法预估</span>${U.escapeHtml(e.message)}`, bad: true };
    }
    if (res.errors && res.errors.length) {
      return { html: `<span class="est-label">无法执行</span>${U.escapeHtml(res.errors[0].message)}`, bad: true };
    }
    const nd = res.dataset;
    if (!nd || !nd.columns.length) return { html: '<span class="est-label">提示</span>这个操作会把所有列删光，请重新选择。', bad: true };
    if (!nd.rows.length) return { html: '<span class="est-label">提示</span>这个操作会把数据清空（0 行），请检查筛选条件。', bad: true };

    const dRow = nd.rows.length - ds.rows.length;
    const dCol = nd.columns.length - ds.columns.length;
    const chip = (v, unit) => {
      if (!v) return '';
      const cls = v > 0 ? 'up' : 'down';
      const sign = v > 0 ? '+' : '';
      return ` <b class="${cls}">${sign}${v} ${unit}</b>`;
    };
    const after = `${nd.rows.length} 行 × ${nd.columns.length} 列`;
    const delta = dRow || dCol ? `${chip(dRow, '行')}${chip(dCol, '列')}` : '，行列数不变';
    return { html: `<span class="est-label">应用后</span>${before} → <strong>${after}</strong>${delta}` };
  }

  function refreshEstimate(def, values, ds) {
    const box = document.getElementById('opEstimate');
    if (!box || !ds) return;
    const est = estimateHTML(def, values, ds);
    box.className = 'op-estimate' + (est.bad ? ' bad' : '');
    box.innerHTML = est.html;
  }

  /* 预览里别把 60.86888888888888 这种浮点噪声原样丢出来 */
  function numText(v) {
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    if (a >= 1e6 || a < 1e-4) return v.toExponential(3);
    return v.toPrecision(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  function renderPreview(ds) {
    const wrap = document.getElementById('cleanPreview');
    const tag = document.getElementById('previewMeta');
    if (!wrap) return;
    if (tag) tag.textContent = `${ds.rows.length} 行 × ${ds.columns.length} 列`;
    const LIMIT = 25;
    const table = h('table');
    const head = h('tr', h('th.num', '#'));
    ds.columns.forEach((c) => {
      head.appendChild(h('th', c.name, h('span.ty', TYPE_LABEL[c.type] || c.type)));
    });
    table.appendChild(h('thead', head));

    const tb = h('tbody');
    ds.rows.slice(0, LIMIT).forEach((r, k) => {
      const tr = h('tr', h('td.num', { style: { color: '#98a2b0' } }, String(k + 1)));
      ds.columns.forEach((c, i) => {
        const v = r[i];
        const blank = isBlank(v);
        tr.appendChild(h('td' + (c.type === 'number' ? '.num' : '') + (blank ? '.blank' : ''),
          blank ? '空' : (typeof v === 'number' ? numText(v) : String(v))));
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);

    wrap.innerHTML = '';
    wrap.appendChild(table);
    if (ds.rows.length > LIMIT) {
      wrap.appendChild(h('p.muted.small', { style: { padding: '9px 13px', borderTop: '1px solid #eef0f3' } },
        `只显示前 ${LIMIT} 行。完整数据在「数据表」页，空白单元格在这里标成「空」。`));
    }
  }

  function renderPipe() {
    const pipe = window.LD.app.pipeline();
    const cnt = document.getElementById('pipeCount');
    if (cnt) cnt.textContent = pipe.length + ' 步';
    const box = document.getElementById('pipeDetail');
    if (!box) return;
    box.innerHTML = '';
    if (!pipe.length) {
      box.appendChild(h('p.muted.small', '还没有整理操作。上面每一步都会按顺序记在这里，可以单步移除，也可以回到某一步之前。'));
      return;
    }
    const ol = h('ol.pipe-timeline');
    pipe.forEach((step, i) => {
      ol.appendChild(h('li',
        h('span.pipe-idx', String(i + 1)),
        h('span.pipe-text', window.LD.ops.summarize(step)),
        h('span.pipe-tools',
          h('button.btn.ghost.sm', { 'data-act': 'cleanRollback', 'data-index': i, title: '撤销这一步以及它之后的所有操作' }, '回到此前'),
          h('button.btn.ghost.sm', { 'data-act': 'cleanRemoveOp', 'data-index': i }, '移除'))));
    });
    box.appendChild(ol);
    box.appendChild(h('div', { style: { marginTop: '10px' } },
      h('button.btn.ghost.sm', { 'data-act': 'cleanClearPipe' }, '清空全部操作')));
  }

  /* ======================================================================
     三、交互
     ====================================================================== */
  function bindPanel() {
    const panel = document.getElementById('opPanel');
    if (!panel) return;
    bound = true;

    const sync = (rebuild) => {
      const def = defByKey(curOp);
      if (!def) return;
      opValues[curOp] = window.LD.ui.readOpValues(panel, def);
      const ds = window.LD.app.workDataset();
      if (rebuild) renderPanel(ds);
      else refreshEstimate(def, opValues[curOp], ds);
    };

    panel.addEventListener('change', () => {
      const def = defByKey(curOp);
      // 有联动字段（选了「填指定值」才出现输入框）时整块重建
      sync(!!(def && def.fields.some((f) => typeof f.when === 'function')));
    });
    panel.addEventListener('input', () => sync(false));
  }

  function applyFromPanel(panel) {
    const def = defByKey(panel.dataset.op || curOp);
    if (!def) return;
    const values = window.LD.ui.readOpValues(panel, def);
    opValues[def.key] = values;
    applyOp(def.key, window.LD.ops.buildParams(def, values));
  }

  function applyOp(type, params) {
    const ds = window.LD.app.workDataset();
    const before = ds ? `${ds.rows.length}×${ds.columns.length}` : '?';
    try {
      window.LD.app.pushOp(type, params);
      const after = window.LD.app.workDataset();
      const shape = after ? `${after.rows.length}×${after.columns.length}` : '?';
      U.toast(`已应用：${window.LD.ops.summarize({ type, params })} · ${before} → ${shape}`, 'ok', 4200);
    } catch (e) {
      U.toast('操作失败：' + e.message, 'err', 6000);
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    const act = t.dataset.act;
    const app = window.LD.app;

    if (act === 'cleanOp') {
      curOp = t.dataset.op;
      renderNav();
      renderPanel(app.workDataset());
      return;
    }
    if (act === 'cleanApply') {
      const panel = document.getElementById('opPanel');
      if (panel) applyFromPanel(panel);
      return;
    }
    if (act === 'cleanReset') {
      delete opValues[t.dataset.op];
      renderPanel(app.workDataset());
      return;
    }
    if (act === 'cleanInsertCol') {
      const input = document.querySelector('#opPanel input[data-field="expr"]');
      if (!input) return;
      const token = '[' + t.dataset.col + ']';
      const s = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
      const e2 = typeof input.selectionEnd === 'number' ? input.selectionEnd : s;
      input.value = input.value.slice(0, s) + token + input.value.slice(e2);
      const pos = s + token.length;
      input.focus();
      try { input.setSelectionRange(pos, pos); } catch (err) { /* 部分浏览器只读 */ }
      opValues.derive = Object.assign({}, opValues.derive, { expr: input.value });
      refreshEstimate(defByKey('derive'), opValues.derive, app.workDataset());
      return;
    }
    if (act === 'cleanAutoFix') {
      const ds = app.workDataset();
      const issues = audit(ds).filter((it) => !dismissed.has(it.title));
      const fixes = safeFixes(issues);
      if (!fixes.length) { U.toast('没有可以自动处理的问题', 'warn'); return; }
      U.modal(`一键修复 ${fixes.length} 项`,
        h('div',
          h('p', '下面这些改动不改变数据含义，将作为整理步骤依次应用（可随时撤回）：'),
          h('ul', { style: { margin: '6px 0 0 18px', lineHeight: '1.7' } }, fixes.map((f) => h('li', f.label)))),
        [
          { label: '取消' },
          {
            label: `应用 ${fixes.length} 项`,
            primary: true,
            onClick: () => {
              try {
                app.pushOps(fixes.map((f) => ({ type: f.type, params: f.params })));
                U.toast(`已应用 ${fixes.length} 项修复`, 'ok');
              } catch (err) {
                U.toast('修复失败：' + err.message, 'err', 6000);
              }
            },
          },
        ]);
      return;
    }
    if (act === 'cleanFix') {
      let params = {};
      try { params = JSON.parse(t.dataset.params || '{}'); } catch (err) { params = {}; }
      if (t.dataset.dismiss === '1') {
        const row = t.closest('.audit-item');
        const strong = row && row.querySelector('strong');
        if (strong) dismissed.add(strong.textContent);
      }
      applyOp(t.dataset.op, params);
      return;
    }
    if (act === 'cleanRemoveOp') {
      app.removeOp(Number(t.dataset.index));
      return;
    }
    if (act === 'cleanRollback') {
      const idx = Number(t.dataset.index);
      const pipe = app.pipeline();
      for (let i = pipe.length - 1; i >= idx; i--) app.removeOp(i);
      U.toast(`已撤销第 ${idx + 1} 步及之后的操作`, 'ok');
      return;
    }
    if (act === 'cleanClearPipe') {
      if (!app.pipeline().length) return;
      app.clearPipeline();
      U.toast('已清空全部整理操作', 'ok');
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'opSearch') {
      searchTerm = e.target.value;
      renderNav();
    }
  });

  window.LD.clean = { render, audit };
})();
