/* LabDesk · 界面渲染与交互 */
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;
  const S = LD.stats;
  const h = U.h;
  const $ = U.$;
  const $$ = U.$$;

  const st = () => LD.app.state;
  let chartEl = null;
  let codeLang = 'py';

  const TYPE_LABEL = { number: '数值', category: '分类', text: '文本', date: '日期', empty: '空' };

  /* ==================================================================
     基础渲染
     ================================================================== */
  function renderRail() {
    $$('.rail-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === st().view);
    });
    const list = $('#pipeList');
    const pipe = LD.app.pipeline();
    list.innerHTML = '';
    if (!pipe.length) {
      list.appendChild(h('li.pipe-empty', '尚无整理操作'));
      return;
    }
    pipe.slice(-8).forEach((step) => {
      list.appendChild(h('li', LD.ops.summarize(step)));
    });
  }

  function renderTopbar() {
    const sel = $('#datasetSelect');
    const s = st();
    sel.innerHTML = '';
    if (!s.datasets.length) {
      sel.appendChild(h('option', { value: '' }, '（无数据集）'));
    } else {
      s.datasets.forEach((e) => {
        sel.appendChild(h('option', { value: e.id, selected: e.id === s.activeId }, e.ds.name));
      });
    }
    const ds = LD.app.workDataset();
    const raw = LD.app.rawDataset();
    const meta = $('#datasetMeta');
    if (!ds) {
      meta.textContent = '尚未载入数据';
    } else {
      const steps = LD.app.pipeline().length;
      meta.textContent = `${ds.rows.length} 行 × ${ds.columns.length} 列`
        + (raw && raw.rows.length !== ds.rows.length ? `（原始 ${raw.rows.length} 行）` : '')
        + (steps ? `　·　${steps} 步整理` : '');
    }
    $('#btnUndo').disabled = !LD.app.pipeline().length;
  }

  function renderAll() {
    renderTopbar();
    renderRail();
    const views = ['import', 'table', 'clean', 'curve', 'stats', 'chart', 'report', 'empty'];
    let v = st().view;
    if (!LD.app.rawDataset() && v !== 'import') v = 'empty';
    views.forEach((name) => {
      const el = $('#view-' + name);
      if (el) el.hidden = name !== v;
    });
    if (v === 'import') renderImport();
    if (v === 'table') renderTable();
    if (v === 'clean') renderClean();
    if (v === 'curve') LD.curveUI.render();
    if (v === 'stats') renderStats();
    if (v === 'chart') renderChartView();
    if (v === 'report') renderReportView();
  }

  /* ==================================================================
     1 数据接入
     ================================================================== */
  function renderImport() {
    const host = $('#sampleList');
    host.innerHTML = '';
    LD.parse.SAMPLES.forEach((smp) => {
      host.appendChild(h('div.sample-item', { 'data-act': 'loadSample', 'data-key': smp.key },
        h('div', h('strong', smp.name), h('br'), h('span', smp.desc)),
        h('span.sample-go', '载入 →')));
    });
    renderAiStatus();
  }

  function renderAiStatus() {
    const el = $('#aiAvailability');
    if (!el) return;
    const a = LD.ai.state;
    el.className = 'ai-availability';
    if (a.status === 'ready') {
      el.classList.add('ready');
      el.textContent = `AI 识别已就绪：${a.visionModel ? '使用 ' + (a.visionModel.name || a.visionModel.id) : '当前无视觉模型，可用本地识别'}`;
    } else if (a.status === 'loading') {
      el.textContent = '正在连接模型服务…';
    } else if (a.status === 'unavailable') {
      el.classList.add('down');
      el.textContent = 'AI 识别服务未配置：仍可使用「本地备用识别」（适合印刷体截图）或直接手工录入。';
    } else if (a.status === 'error') {
      el.classList.add('down');
      el.textContent = a.message + '　—　可改用「本地备用识别」或手工录入。';
    } else {
      el.textContent = '正在检测 AI 识别服务…';
    }
  }

  /* ==================================================================
     2 数据表
     ================================================================== */
  function renderTable() {
    const ds = LD.app.workDataset();
    if (!ds) return;
    const raw = LD.app.rawDataset();

    // 列结构
    const wrap = $('#columnProfile');
    const search = ($('#colSearch') && $('#colSearch').value || '').trim().toLowerCase();
    const table = h('table');
    table.appendChild(h('thead', h('tr',
      h('th', '列名'), h('th', '类型'), h('th.num', '有效'), h('th.num', '缺失'),
      h('th.num', '唯一值'), h('th', '示例值'), h('th', '完整度'), h('th', '操作'))));
    const tbody = h('tbody');
    ds.columns.forEach((c, i) => {
      if (search && !c.name.toLowerCase().includes(search)) return;
      const vals = ds.rows.map((r) => r[i]);
      const miss = vals.filter((v) => v === null || v === '').length;
      const uniq = new Set(vals.filter((v) => v !== null && v !== '')).size;
      const sample = Array.from(new Set(vals.filter((v) => v !== null && v !== '')))
        .slice(0, 3)
        .map((v) => (typeof v === 'number' ? U.fmt(v, 2) : String(v)))
        .join('、');
      const rate = ds.rows.length ? (ds.rows.length - miss) / ds.rows.length : 0;
      const sel = h('select.mini-select', { 'data-change': 'setType', 'data-col': c.name },
        Object.keys(TYPE_LABEL).filter((k) => k !== 'empty').map((k) =>
          h('option', { value: k, selected: k === c.type }, TYPE_LABEL[k])));
      tbody.appendChild(h('tr',
        h('td', h('strong', c.name)),
        h('td', sel),
        h('td.num', String(ds.rows.length - miss)),
        h('td.num', miss ? String(miss) : '—'),
        h('td.num', String(uniq)),
        h('td', { style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' } }, sample || '—'),
        h('td', h('div.quality-bar',
          h('div.track', h('i', { style: { width: (rate * 100).toFixed(0) + '%' } })),
          h('span.muted.small', (rate * 100).toFixed(0) + '%'))),
        h('td', h('button.btn.ghost.sm', { 'data-act': 'dropColumn', 'data-col': c.name, title: '删除这一列（可在整理记录里撤回）' }, '删除'))));
    });
    table.appendChild(tbody);
    wrap.innerHTML = '';
    wrap.appendChild(table);

    // 预览
    const pv = $('#dataPreview');
    const limit = 200;
    const t2 = h('table');
    const head = h('tr', h('th.row-idx', '#'));
    ds.columns.forEach((c) => head.appendChild(h('th', c.name, h('span.col-type', TYPE_LABEL[c.type]))));
    t2.appendChild(h('thead', head));
    const body = h('tbody');
    ds.rows.slice(0, limit).forEach((row, ri) => {
      const tr = h('tr', h('td.row-idx', String(ri + 1)));
      row.forEach((v, ci) => {
        const isNum = ds.columns[ci].type === 'number';
        tr.appendChild(h('td', { class: isNum ? 'num' : '' },
          h('input.cell-input', {
            value: v === null ? '' : String(v),
            'data-change': 'editCell',
            'data-row': ri, 'data-col': ci,
            style: isNum ? { textAlign: 'right' } : {},
          })));
      });
      body.appendChild(tr);
    });
    t2.appendChild(body);
    pv.innerHTML = '';
    pv.appendChild(t2);
    $('#previewInfo').textContent = ds.rows.length > limit
      ? `显示前 ${limit} 行，共 ${ds.rows.length} 行（单元格可直接编辑）`
      : `共 ${ds.rows.length} 行（单元格可直接编辑）`;
  }

  /* ==================================================================
     3 整理清洗
     ================================================================== */
  function fieldControl(def, field, values, ds) {
    const val = values[field.k];
    const id = 'f_' + def.key + '_' + field.k;
    if (field.type === 'multicol') {
      const cols = ds.columns.filter((c) => {
        if (field.numOnly) return c.type === 'number';
        if (field.catOnly) return c.type !== 'number';
        return true;
      });
      // 原生 multiple 下拉要按住 ⌘/Ctrl 才能多选，还得靠滚动找列——改成可点的 chips
      const chosen = Array.isArray(val) ? val : [];
      const box = h('div.col-chips', { 'data-field': field.k, id });
      if (!cols.length) box.appendChild(h('span.muted.small', '没有可选的列'));
      cols.forEach((c) => {
        box.appendChild(h('label.chip',
          h('input', { type: 'checkbox', value: c.name, checked: chosen.includes(c.name) }),
          h('span', c.name)));
      });
      const suffix = field.numOnly ? '（数值列）' : field.catOnly ? '（分类列）' : '';
      return h('div.field', h('span', field.label + suffix + ' · 不选 = 全部列'), box);
    }
    if (field.type === 'checks') {
      // 从固定选项里多选（如分组汇总要同时算均值、标准差、n）
      const chosen = Array.isArray(val) ? val : (field.def || []);
      const box = h('div.col-chips', { 'data-field': field.k, id });
      field.options.forEach(([v, t]) => {
        box.appendChild(h('label.chip',
          h('input', { type: 'checkbox', value: v, checked: chosen.includes(v) }),
          h('span', t)));
      });
      return h('div.field', h('span', field.label), box);
    }
    if (field.type === 'column') {
      let cols = ds.columns.filter((c) => {
        if (field.numOnly) return c.type === 'number';
        if (field.catOnly) return c.type !== 'number';
        return true;
      });
      return h('label.field', h('span', field.label),
        h('select', { 'data-field': field.k },
          cols.map((c) => h('option', { value: c.name, selected: c.name === val }, c.name))));
    }
    if (field.type === 'select') {
      return h('label.field', h('span', field.label),
        h('select', { 'data-field': field.k },
          field.options.map(([v, t]) => h('option', { value: v, selected: String(val) === String(v) }, t))));
    }
    if (field.type === 'checkbox') {
      // 没填过时按字段默认值显示，否则界面上是「未勾选」但实际参数取到了 true
      const on = val === undefined ? !!field.def : !!val;
      return h('label.field.inline', h('input', { type: 'checkbox', 'data-field': field.k, checked: on }), h('span', field.label));
    }
    if (field.type === 'number') {
      return h('label.field', h('span', field.label),
        h('input', { type: 'number', 'data-field': field.k, value: val === undefined ? (field.def || '') : val, step: field.step || 1 }));
    }
    if (field.type === 'text') {
      const input = h('input', { type: 'text', 'data-field': field.k, value: val === undefined ? (field.def || '') : val, placeholder: field.placeholder || '' });
      // 分类列的取值有限，直接给候选，省得用户猜要填什么
      if (typeof field.suggest === 'function') {
        let list = [];
        try { list = field.suggest(values, ds) || []; } catch (e) { list = []; }
        if (list.length) {
          const dlId = id + '_dl';
          input.setAttribute('list', dlId);
          const dl = h('datalist', { id: dlId });
          list.slice(0, 80).forEach((v) => dl.appendChild(h('option', { value: String(v) })));
          return h('label.field', h('span', field.label), input, dl);
        }
      }
      return h('label.field', h('span', field.label), input);
    }
    return h('label.field', h('span', field.label),
      h('input', { type: 'text', 'data-field': field.k, value: val === undefined ? (field.def || '') : val, placeholder: field.placeholder || '' }));
  }

  function readOpValues(card, def) {
    const v = {};
    def.fields.forEach((f) => {
      const el = card.querySelector(`[data-field="${f.k}"]`);
      if (!el) return;
      if (f.type === 'multicol' || f.type === 'checks') {
        v[f.k] = el.classList.contains('col-chips')
          ? Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map((i) => i.value)
          : Array.from(el.selectedOptions).map((o) => o.value);
      }
      else if (f.type === 'checkbox') v[f.k] = el.checked;
      else v[f.k] = el.value;
    });
    return v;
  }

  function renderClean() {
    // 清洗页的界面逻辑（体检 / 操作面板 / 预估 / 预览）都在 clean.js 里
    if (LD.clean) LD.clean.render();
  }

  /* ==================================================================
     4 统计分析
     ================================================================== */
  function renderDescTable() {
    const wrap = $('#descTable');
    const ds = LD.app.workDataset();
    const sel = $('#descGroup');
    if (!ds) {
      if (sel) sel.innerHTML = '';
      wrap.innerHTML = '';
      wrap.appendChild(h('p.muted.small', { style: { padding: '12px' } }, '当前数据集没有数值列，或尚未载入数据。'));
      return;
    }
    const nums = LD.app.numNames(ds);
    const groupOpts = LD.charts.groupCandidates ? LD.charts.groupCandidates(ds) : [];
    if (sel) {
      const prev = st().descGroup || '';
      sel.innerHTML = '';
      sel.appendChild(h('option', { value: '' }, '不分组'));
      groupOpts.forEach((n) => sel.appendChild(h('option', { value: n }, '按「' + n + '」分组')));
      sel.value = groupOpts.includes(prev) ? prev : '';
      sel.disabled = !groupOpts.length;
      st().descGroup = sel.value;
    }
    const gName = sel ? sel.value : '';
    const gi = gName ? ds.columns.findIndex((c) => c.name === gName) : -1;

    if (!nums.length) {
      wrap.innerHTML = '';
      wrap.appendChild(h('p.muted.small', { style: { padding: '12px' } }, '当前数据集没有数值列。'));
      st()._descTable = null;
      return;
    }

    const table = h('table');
    const tb = h('tbody');

    if (gi < 0) {
      table.appendChild(h('thead', h('tr',
        ['变量', 'n', '缺失', '均值', '标准差', '标准误', '中位数', 'Q1', 'Q3', '最小值', '最大值', '95% CI', 'CV', '偏度', '峰度']
          .map((t, i) => h('th' + (i > 0 ? '.num' : ''), t)))));
      const out = [];
      nums.forEach((name) => {
        const i = ds.columns.findIndex((c) => c.name === name);
        const d = LD.stats.describe(ds.rows.map((r) => r[i]));
        out.push([name, d.n, d.missing, d.mean, d.sd, d.se, d.median, d.q1, d.q3, d.min, d.max,
          `${U.fmt(d.ciLow, 3)} ~ ${U.fmt(d.ciHigh, 3)}`, d.cv, d.skew, d.kurt]);
        tb.appendChild(h('tr',
          h('td', h('strong', name)),
          h('td.num', String(d.n)),
          h('td.num', d.missing ? String(d.missing) : '—'),
          h('td.num', U.fmt(d.mean, 4)),
          h('td.num', U.fmt(d.sd, 4)),
          h('td.num', U.fmt(d.se, 4)),
          h('td.num', U.fmt(d.median, 4)),
          h('td.num', U.fmt(d.q1, 3)),
          h('td.num', U.fmt(d.q3, 3)),
          h('td.num', U.fmt(d.min, 3)),
          h('td.num', U.fmt(d.max, 3)),
          h('td.num', `${U.fmt(d.ciLow, 3)} ~ ${U.fmt(d.ciHigh, 3)}`),
          h('td.num', U.fmt(d.cv, 3)),
          h('td.num', U.fmt(d.skew, 2)),
          h('td.num', U.fmt(d.kurt, 2))));
      });
      st()._descTable = { columns: ['变量', 'n', '缺失', '均值', '标准差', '标准误', '中位数', 'Q1', 'Q3', '最小值', '最大值', '95% CI', 'CV', '偏度', '峰度'], rows: out };
    } else {
      // 分组描述：论文 Table 1 最常见的形式，先按组别给 n / 均值 ± 标准差，再给中位数与 95% CI
      table.appendChild(h('thead', h('tr',
        [['变量'], [gName], ['n'], ['均值'], ['标准差'], ['标准误'], ['中位数'], ['95% CI'], ['最小值'], ['最大值']]
          .map((t, i) => h('th' + (i > 1 && i !== 2 ? '.num' : ''), t)))));
      const levels = Array.from(new Set(ds.rows.map((r) => r[gi]).filter((v) => v !== null && v !== undefined && v !== '')
        .map((v) => String(v))));
      levels.sort((a, b) => {
        const na = Number(a), nb = Number(b);
        return isFinite(na) && isFinite(nb) ? na - nb : a.localeCompare(b, 'zh-CN');
      });
      const out = [];
      nums.filter((n) => n !== gName).forEach((name) => {
        const i = ds.columns.findIndex((c) => c.name === name);
        levels.forEach((lv) => {
          const vals = ds.rows.filter((r) => String(r[gi]) === lv).map((r) => r[i]);
          const d = LD.stats.describe(vals);
          out.push([name, lv, d.n, d.mean, d.sd, d.se, d.median, `${U.fmt(d.ciLow, 3)} ~ ${U.fmt(d.ciHigh, 3)}`, d.min, d.max]);
          tb.appendChild(h('tr',
            h('td', h('strong', name)),
            h('td', lv),
            h('td.num', String(d.n)),
            h('td.num', U.fmt(d.mean, 4)),
            h('td.num', U.fmt(d.sd, 4)),
            h('td.num', U.fmt(d.se, 4)),
            h('td.num', U.fmt(d.median, 4)),
            h('td.num', `${U.fmt(d.ciLow, 3)} ~ ${U.fmt(d.ciHigh, 3)}`),
            h('td.num', U.fmt(d.min, 3)),
            h('td.num', U.fmt(d.max, 3))));
        });
      });
      st()._descTable = { columns: ['变量', gName, 'n', '均值', '标准差', '标准误', '中位数', '95% CI', '最小值', '最大值'], rows: out };
    }
    table.appendChild(tb);
    wrap.innerHTML = '';
    wrap.appendChild(table);
    st()._descGrouped = gi >= 0;
  }

  function descTableTsv() {
    const t = st()._descTable;
    if (!t) return '';
    return [t.columns.join('\t')].concat(t.rows.map((r) => r.join('\t'))).join('\n');
  }

  function familyByKey(k) { return LD.app.FAMILIES.find((f) => f.key === k) || LD.app.FAMILIES[0]; }

  function renderTestForm() {
    const ds = LD.app.workDataset();
    if (!ds) return;
    const nums = LD.app.numNames(ds);
    const cats = LD.app.catNames(ds);
    const all = ds.columns.map((c) => c.name);

    const famSel = $('#testFamily');

    const fill = (sel, list, placeholder) => {
      const prev = sel.value;
      sel.innerHTML = '';
      if (!list.length) {
        sel.appendChild(h('option', { value: '' }, placeholder || '（无可选列）'));
        return;
      }
      list.forEach((n) => sel.appendChild(h('option', { value: n }, n)));
      if (list.includes(prev)) sel.value = prev;
    };

    const yWrap = $('#testY').closest('.field');
    const gWrap = $('#testG').closest('.field');
    const xWrap = $('#testXWrap');

    /* 因变量默认落在「取值最丰富」的数值列上：实验设计变量（温度、批次）通常只有两三个
       水平，若默认选中它们，跑出来的 F 值接近 0、p 接近 1，看起来像算错了。 */
    const rich = (name) => {
      const i = ds.columns.findIndex((c) => c.name === name);
      return i < 0 ? 0 : new Set(ds.rows.map((r) => r[i])).size;
    };
    const numsY = nums.slice().sort((a, b) => rich(b) - rich(a));

    /* 分组变量要避开「样品编号」这类唯一标识列：每个取值只出现一次，
       分完组每组只剩 1 个样本，方差分析和 t 检验直接算不出来。
       判断依据是「每个取值的平均出现次数」，而不是单纯看水平数。 */
    const rankCat = (name) => {
      const u = rich(name);
      if (u <= 1) return 2;                 // 常数，没有信息
      if (ds.rows.length / u < 1.5) return 1; // 基本每个取值只出现一次 → ID 列
      if (u <= 12) return 0;                // 合适的分组变量
      return 1;                             // 水平太多，更像连续变量
    };
    const catsG = cats.slice().sort((a, b) => rankCat(a) - rankCat(b) || rich(a) - rich(b));
    /* 温度、pH、浓度这类因素常被推断成数值列，但实验里就是拿它当分组用的。
       把「只有少数几个水平、且每个水平有重复」的数值列也放进分组候选。 */
    const numAsGroup = nums.filter((n) => rankCat(n) === 0);
    const groupChoices = all
      .filter((n) => catsG.indexOf(n) >= 0 || numAsGroup.indexOf(n) >= 0)
      .sort((a, b) => rankCat(a) - rankCat(b) || ds.columns.findIndex((c) => c.name === a) - ds.columns.findIndex((c) => c.name === b));

    /* 检验类型的默认值要看数据长什么样：没有任何可分组列时还默认「方差分析」，
       一点「运行分析」就只能得到「分组不足」，白白浪费一次操作。 */
    if (!famSel.options.length) {
      LD.app.FAMILIES.forEach((f) => famSel.appendChild(h('option', { value: f.key }, f.name)));
      const hasGroup = groupChoices.some((n) => rankCat(n) === 0);
      famSel.value = (nums.length && hasGroup) ? 'anova' : (nums.length >= 2 ? 'corr' : 'normality');
    }
    const fam = familyByKey(famSel.value);

    if (fam.y === 'num') fill($('#testY'), numsY, '（需要数值列）');
    else fill($('#testY'), cats, '（需要分类列）');

    const needG = !!fam.g;
    gWrap.hidden = !needG;
    if (needG) {
      fill($('#testG'), groupChoices, '（需要分类列）');
      // 上一轮可能停在 ID 列上，这里纠正回真正的分组变量
      const better = groupChoices.find((n) => rankCat(n) === 0);
      if (better && rankCat($('#testG').value) !== 0) $('#testG').value = better;
    }

    const needX = !!fam.x;
    xWrap.hidden = !needX;
    if (needX) {
      xWrap.querySelector('span').textContent = fam.x === 'num' ? '第二变量（数值）' : '第二变量（分类）';
      const base = fam.x === 'num' ? nums : cats;
      const yv = $('#testY').value;
      // 第二变量避开与因变量相同的列，否则相关性/回归没有意义
      fill($('#testX'), base.filter((n) => n !== yv).concat(base.filter((n) => n === yv)), '（需要另一列）');
    }

    // 动态附加字段
    let extra = $('#testExtra');
    if (!extra) {
      extra = h('div.form-row', { id: 'testExtra', style: { width: '100%', marginTop: '2px' } });
      $('#testForm').appendChild(extra);
    }
    extra.innerHTML = '';

    if (fam.extra) {
      fam.extra.forEach((f) => {
        extra.appendChild(h('label.field', h('span', f.label),
          h('input', { type: 'number', id: 'extra_' + f.k, value: f.def, step: 'any' })));
      });
    }

    // 两组比较需要指定具体两组
    if ((fam.key === 'ttest2' || fam.key === 'mw') && needG) {
      const gName = $('#testG').value;
      const gi = ds.columns.findIndex((c) => c.name === gName);
      const levels = gi >= 0 ? Array.from(new Set(ds.rows.map((r) => String(r[gi])).filter((v) => v && v !== 'null'))) : [];
      const prevA = (st()._groupA && levels.includes(st()._groupA)) ? st()._groupA : levels[0];
      const prevB = (st()._groupB && levels.includes(st()._groupB)) ? st()._groupB : levels[1];
      extra.appendChild(h('label.field', h('span', '组 A'),
        h('select', { id: 'extra_groupA' }, levels.map((l) => h('option', { value: l, selected: l === prevA }, l)))));
      extra.appendChild(h('label.field', h('span', '组 B'),
        h('select', { id: 'extra_groupB' }, levels.map((l) => h('option', { value: l, selected: l === prevB }, l)))));
    }

    // 回归：自变量多选
    if (fam.key === 'reg') {
      const yName = $('#testY').value;
      const candidates = nums.filter((n) => n !== yName);
      extra.appendChild(h('label.field', { style: { minWidth: '220px' } }, h('span', '自变量（可多选）'),
        h('select', { id: 'extra_xs', multiple: true, size: Math.min(4, Math.max(2, candidates.length)) },
          candidates.map((n) => h('option', { value: n, selected: candidates.indexOf(n) < 2 }, n)))));
    }

    renderTestHint(fam);
  }

  /** 在表单下方显示「几组、每组几个、缺多少」，避免跑完才发现某组只有 1 个样本 */
  function renderTestHint(fam) {
    const host = $('#testHint');
    if (!host) return;
    const ds = LD.app.workDataset();
    if (!ds) { host.textContent = ''; return; }
    const f = fam || familyByKey($('#testFamily').value);
    const yName = $('#testY').value;
    const gName = f.g ? $('#testG').value : '';
    const yi = ds.columns.findIndex((c) => c.name === yName);
    const gi = gName ? ds.columns.findIndex((c) => c.name === gName) : -1;
    if (yi < 0) { host.textContent = '请选择变量。'; return; }
    const parts = [];
    let bad = false;
    if (gi >= 0) {
      const counts = new Map();
      let total = 0;
      ds.rows.forEach((r) => {
        const v = r[gi];
        if (v === null || v === undefined || v === '') return;
        const num = LD.util.parseNum(r[yi]);
        if (!isFinite(num)) return;
        const k = String(v);
        counts.set(k, (counts.get(k) || 0) + 1);
        total++;
      });
      const list = Array.from(counts.entries());
      bad = list.some(([, n]) => n < 2);
      parts.push(`${list.length} 组，有效观测 ${total}`);
      parts.push(list.map(([k, n]) => `${k}=${n}`).join('，'));
    } else {
      const ok = ds.rows.filter((r) => isFinite(LD.util.parseNum(r[yi]))).length;
      bad = ok < 3;
      parts.push(`有效观测 ${ok}（缺失 ${ds.rows.length - ok}）`);
    }
    host.textContent = parts.join('；');
    host.className = 'test-hint' + (bad ? ' warn' : '');
  }

  function renderTestResult() {
    const host = $('#testResult');
    const lt = st().lastTest;
    host.className = 'result-pane';
    if (!lt) {
      host.classList.add('muted');
      host.textContent = '选择变量后运行分析。';
      return;
    }
    const r = lt.render;
    host.innerHTML = '';
    host.appendChild(h('div.res-title', r.title,
      h('span.tag' + (r.level === 'ok' ? '.ok' : r.level === 'warn' ? '.warn' : ''), r.level === 'ok' ? '显著 / 前提满足' : r.level === 'warn' ? '需注意' : '无法计算')));
    if (r.stats && r.stats.length) {
      const g = h('div.res-grid');
      r.stats.forEach((s) => g.appendChild(h('div.res-stat', h('div.k', s.k), h('div.v', s.v))));
      host.appendChild(g);
    }
    if (r.notes && r.notes.length) {
      host.appendChild(h('div.assume-list', r.notes.map((n) => h('li', n))));
    }
    const tableBlock = (tbl, title) => {
      if (!tbl) return null;
      const t = h('table');
      t.appendChild(h('thead', h('tr', tbl.columns.map((c, i) => h('th' + (i > 0 ? '.num' : ''), c)))));
      t.appendChild(h('tbody', tbl.rows.map((row) => h('tr', row.map((c, i) => h('td' + (i > 0 ? '.num' : ''), String(c)))))));
      return h('div', { style: { marginTop: '12px' } }, title ? h('div.small.muted', { style: { marginBottom: '4px' } }, title) : null,
        h('div.table-wrap', t));
    };
    if (r.table) host.appendChild(tableBlock(r.table));
    if (r.table2) host.appendChild(tableBlock(r.table2, r.table2.title));
    if (r.conclusion) {
      host.appendChild(h('div.verdict' + (r.level === 'ok' ? '.ok' : r.level === 'warn' ? '.warn' : '.bad'), r.conclusion));
    }
    const spec = r.spec;
    if (spec && spec.g) {
      host.appendChild(h('div.res-actions',
        h('button.btn.primary.sm', { 'data-act': 'plotTest', 'data-id': lt.id, 'data-kind': 'bar' }, '用这个结果出柱状图'),
        h('button.btn.ghost.sm', { 'data-act': 'plotTest', 'data-id': lt.id, 'data-kind': 'box' }, '箱线图'),
        h('button.btn.ghost.sm', { 'data-act': 'plotTest', 'data-id': lt.id, 'data-kind': 'violin' }, '小提琴图')));
    } else if (spec && (spec.family === 'corr' || spec.family === 'reg')) {
      host.appendChild(h('div.res-actions',
        h('button.btn.primary.sm', { 'data-act': 'plotTest', 'data-id': lt.id }, '用这个结果出散点图 + 拟合线')));
    }
    if (r.text) {
      host.appendChild(h('div', { style: { marginTop: '10px' } },
        h('div.small.muted', { style: { marginBottom: '4px' } }, '规范表述（可直接用于论文）'),
        h('pre.prose', { style: { background: '#fff', padding: '10px 12px', border: '1px solid #e3e6eb', borderRadius: '7px' } }, r.text),
        h('button.btn.ghost.sm', { 'data-act': 'copyText', 'data-text': r.text, style: { marginTop: '6px' } }, '复制')));
    }
    if (st().interpretation) {
      host.appendChild(h('div', { style: { marginTop: '14px' } },
        h('div.small.muted', { style: { marginBottom: '4px' } }, 'AI 解读'),
        h('pre.prose', { style: { background: '#fff', padding: '10px 12px', border: '1px solid #e3e6eb', borderRadius: '7px' } }, st().interpretation)));
    }
    $('#btnInterpret').disabled = !LD.ai.isReady();
  }

  function renderStats() {
    renderDescTable();
    renderTestForm();
    renderTestResult();
    renderResults();
  }

  /** 分析结果工作台：保留最近若干次检验，可随时回看、直接出图或删除 */
  function renderResults() {
    const list = $('#resultsList');
    if (!list) return;
    const rows = LD.app.visibleResults();
    const cnt = $('#resultsCount');
    if (cnt) cnt.textContent = String(rows.length);
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(h('p.muted.small', { style: { margin: 0 } }, '还没有分析结果。运行一次假设检验后会出现在这里。'));
      return;
    }
    const lt = st().lastTest;
    rows.forEach((r) => {
      const rd = r.render || {};
      const d = new Date(r.at);
      const time = isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const tag = rd.level === 'ok' ? '显著' : rd.level === 'warn' ? '需注意' : '无法计算';
      const item = h('div.result-item' + (lt && lt.id === r.id ? '.active' : ''),
        h('div.result-main',
          h('div.result-title', rd.title || '分析结果'),
          h('div.small.muted', [time, tag].filter(Boolean).join(' · '))),
        h('div.result-acts',
          h('button.btn.ghost.sm', { 'data-act': 'viewResult', 'data-id': r.id }, '查看'),
          (rd.spec && (rd.spec.g || rd.spec.family === 'corr' || rd.spec.family === 'reg'))
            ? h('button.btn.primary.sm', { 'data-act': 'plotTest', 'data-id': r.id, 'data-kind': 'bar' }, '出图')
            : null,
          h('button.btn.ghost.sm', { 'data-act': 'removeResult', 'data-id': r.id }, '删除')));
      list.appendChild(item);
    });
  }

  /* ==================================================================
     5 图表
     ================================================================== */
  function renderChartView() {
    renderTypeGrid();
    renderEncodingPanel();
    renderStylePanel();
    renderAnnotPanel();
    renderCanvas();
  }

  function renderTypeGrid() {
    const ds = LD.app.workDataset();
    const grid = $('#typeGrid');
    grid.innerHTML = '';
    if (!ds) return;
    const cur = st().chart.type;
    LD.charts.TYPES.forEach((t) => {
      const el = LD.charts.eligibility(t, ds);
      const btn = h('button.type-btn' + (t.key === cur ? '.active' : ''),
        { 'data-act': 'setChartType', 'data-type': t.key, disabled: !el.ok, title: el.ok ? t.req : el.reason },
        h('span.t-name', t.name), h('span.t-req', t.req));
      grid.appendChild(btn);
    });
    const curType = LD.charts.typeByKey(cur);
    const el = LD.charts.eligibility(curType, ds);
    const reason = $('#typeReason');
    reason.textContent = el.ok ? '' : `「${curType.name}」当前不可用：${el.reason}`;
  }

  function renderEncodingPanel() {
    const ds = LD.app.workDataset();
    const panel = $('#encodingPanel');
    panel.innerHTML = '';
    if (!ds) return;
    const type = LD.charts.typeByKey(st().chart.type);
    const enc = st().chart.enc;
    const nums = LD.app.numNames(ds);
    const cats = LD.app.catNames(ds);
    // 分组轴候选由 charts 统一给出：分类列 + 水平数不多的数值列（温度 60/80/100 这类），
    // 且「样品编号」这种每行唯一的列被排到最后，避免一选就画成单点。
    const groupCols = LD.charts.groupCandidates(ds);
    const all = ds.columns.map((c) => c.name);

    type.fields.forEach((f) => {
      let list;
      if (f.kind === 'num') list = nums;
      else if (f.kind === 'cat') list = groupCols;
      else if (f.kind === 'any') list = all;
      else list = all;

      if (f.kind === 'multinum') {
        panel.appendChild(h('label.field', h('span', f.label),
          h('select', { multiple: true, size: Math.min(5, Math.max(3, nums.length)), 'data-change': 'setMulti' },
            nums.map((n) => h('option', { value: n, selected: (enc.multi || []).includes(n) }, n)))));
        panel.appendChild(h('label.field', h('span', '相关方法'),
          h('select', { 'data-change': 'setEncMethod' },
            h('option', { value: 'pearson', selected: enc.method !== 'spearman' }, 'Pearson'),
            h('option', { value: 'spearman', selected: enc.method === 'spearman' }, 'Spearman'))));
        return;
      }

      const opts = [];
      if (f.optional) opts.push(h('option', { value: '' }, '（不分组）'));
      list.forEach((n) => opts.push(h('option', { value: n, selected: enc[f.k] === n }, n)));
      if (!list.length) opts.push(h('option', { value: '' }, '（无可用列）'));
      panel.appendChild(h('label.field', h('span', f.label),
        h('select', { 'data-change': 'setEnc', 'data-enc': f.k }, opts)));
    });

    if (['bar', 'barH', 'barStack', 'line', 'area'].includes(type.key)) {
      panel.appendChild(h('label.field', h('span', '聚合方式'),
        h('select', { 'data-change': 'setAgg' },
          [['mean', '均值'], ['sum', '合计'], ['median', '中位数'], ['count', '计数'], ['min', '最小值'], ['max', '最大值']]
            .map(([v, t]) => h('option', { value: v, selected: (enc.agg || 'mean') === v }, t)))));
    }
    if (['pie', 'donut'].includes(type.key)) {
      panel.appendChild(h('p.small.muted', { style: { margin: '2px 0 0' } }, '饼图默认按分类求和后计算占比。'));
    }
  }

  const STYLE_SPEC = [
    { k: 'widthMM', label: '图宽 (mm)', type: 'number', min: 30, max: 200, step: 1 },
    { k: 'heightMM', label: '图高 (mm)', type: 'number', min: 25, max: 200, step: 1 },
    { k: 'fontFamily', label: '字体', type: 'select', options: () => LD.charts.FONTS.map(([v, t]) => [v, t]) },
    { k: 'fontSize', label: '字号 (pt)', type: 'range', min: 6, max: 14, step: 0.5 },
    { k: 'lineWidth', label: '线宽', type: 'range', min: 0.5, max: 2.5, step: 0.1 },
    { k: 'symbolSize', label: '标记大小', type: 'range', min: 2, max: 12, step: 1 },
    { k: 'palette', label: '配色', type: 'select', options: () => Object.keys(U.PALETTES).map((k) => [k, U.PALETTES[k].label]) },
    { k: 'errType', label: '误差棒', type: 'select', options: () => [['sd', '标准差 (SD)'], ['se', '标准误 (SEM)'], ['ci', '95% CI'], ['none', '不显示']] },
    { k: 'alpha', label: '填充不透明度', type: 'range', min: 0.2, max: 1, step: 0.02 },
    { sep: '坐标轴' },
    { k: 'borderBox', label: '显示坐标轴边框', type: 'checkbox' },
    { k: 'tickIn', label: '刻度线朝内', type: 'checkbox' },
    { k: 'gridShow', label: '显示网格线', type: 'checkbox' },
    { k: 'rotateX', label: 'X 轴标签旋转', type: 'range', min: 0, max: 90, step: 15 },
    { k: 'logY', label: 'Y 轴对数刻度', type: 'checkbox' },
    { sep: '图例与文字' },
    { k: 'legendShow', label: '显示图例', type: 'checkbox' },
    { k: 'legendPos', label: '图例位置', type: 'select', options: () => [['top', '上方'], ['right', '右侧'], ['bottom', '下方'], ['left', '左侧']] },
    { k: 'titleShow', label: '显示图标题', type: 'checkbox' },
    { k: 'titleText', label: '图标题', type: 'text' },
    { k: 'xLabel', label: 'X 轴标题', type: 'text' },
    { k: 'yLabel', label: 'Y 轴标题', type: 'text' },
    { k: 'yNameVertical', label: 'Y 轴标题竖排（Origin 风格）', type: 'checkbox' },
    { sep: '数据' },
    { k: 'fitLine', label: '散点拟合线', type: 'checkbox' },
    { k: 'binCount', label: '直方图组数（0=自动）', type: 'number', min: 0, max: 40, step: 1 },
  ];

  function renderStylePanel() {
    const panel = $('#stylePanel');
    panel.innerHTML = '';
    const style = st().chart.style;
    STYLE_SPEC.forEach((sp) => {
      if (sp.sep) { panel.appendChild(h('div.style-sep', sp.sep)); return; }
      const v = style[sp.k];
      if (sp.type === 'checkbox') {
        panel.appendChild(h('label.field.inline', { style: { justifyContent: 'space-between' } },
          h('span', sp.label),
          h('input', { type: 'checkbox', checked: !!v, 'data-change': 'setStyle', 'data-key': sp.k })));
        return;
      }
      if (sp.type === 'select') {
        panel.appendChild(h('label.field', h('span', sp.label),
          h('select', { 'data-change': 'setStyle', 'data-key': sp.k },
            sp.options().map(([val, txt]) => h('option', { value: val, selected: String(v) === String(val) }, txt)))));
        return;
      }
      if (sp.type === 'range') {
        panel.appendChild(h('label.field', h('span', sp.label),
          h('input', { type: 'range', min: sp.min, max: sp.max, step: sp.step, value: v, 'data-input': 'setStyleLive', 'data-change': 'setStyle', 'data-key': sp.k }),
          h('output', String(v))));
        return;
      }
      if (sp.type === 'number') {
        panel.appendChild(h('label.field', h('span', sp.label),
          h('input', { type: 'number', min: sp.min, max: sp.max, step: sp.step, value: v, 'data-change': 'setStyle', 'data-key': sp.k })));
        return;
      }
      panel.appendChild(h('label.field', h('span', sp.label),
        h('input', { type: 'text', value: v || '', 'data-change': 'setStyle', 'data-key': sp.k, placeholder: '可留空' })));
    });
  }

  function chartCtx() {
    const ds = LD.app.workDataset();
    if (!ds) return null;
    const type = st().chart.type;
    let annot = null;
    const an = st().annot;
    if (an.mode !== 'none' && ['bar', 'barH', 'box', 'violin'].includes(type)) {
      let opts = null;
      let stale = false;
      if (an.sourceId) {
        const src = LD.app.resultById(an.sourceId);
        const spec = src && src.render && src.render.spec;
        const pairs = src && src.render && src.render.pairs;
        if (src && spec && pairs && pairs.length
          && spec.g === st().chart.enc.x && spec.y === st().chart.enc.y) {
          const sig = pairs.filter((r) => r.pAdj < an.alpha).length;
          const adjLabel = spec.adjust === 'none' ? '未校正' : spec.adjust === 'bonf' ? 'Bonferroni' : 'Holm';
          opts = {
            rows: pairs, method: spec.method,
            note: `来自「${src.render.title}」的 ${spec.method === 'mw' ? 'Mann–Whitney U' : 'Welch t'} 两两比较，${adjLabel} 校正；${sig}/${pairs.length} 对显著（α = ${an.alpha}）。`,
          };
        } else stale = true;
      }
      const res = LD.charts.computeAnnotations(ds, st().chart.enc, an.mode, an.test, an.adj, an.alpha, opts);
      annot = res.list;
      st()._annotNote = (stale ? '原检验结果与当前 X/Y 不一致，已按当前图表重新计算。' : '') + res.note;
      st()._annotRows = res.rows;
    } else {
      st()._annotNote = '';
    }
    return { ds, type, enc: st().chart.enc, style: st().chart.style, annot };
  }

  function renderCanvas() {
    const host = $('#chartCanvas');
    if (!host) return;
    const ctx = chartCtx();
    if (!ctx) return;
    if (!chartEl || chartEl !== host || !host.querySelector('canvas') && !host.querySelector('svg')) {
      chartEl = host;
      LD.charts.resetInstance();
    }
    try {
      const wpx = ctx.style.widthMM * LD.charts.MM2PX;
      /* 放大倍数按「预览区实际可用宽度」算：写死 660px 会让窄屏（手机、侧栏展开时）
         的图表比容器还宽，右侧被裁掉、要横向拖动才能看全。 */
      const shell = host.closest('.canvas-shell');
      const avail = shell ? Math.max(200, shell.clientWidth - 24) : 660;
      const scale = Math.max(0.9, Math.min(2.2, avail / wpx));
      const ok = LD.charts.render(host, Object.assign({}, ctx, { scale }));
      if (!ok) {
        host.innerHTML = '<div style="padding:34px;color:#78828f;font-size:12.5px;text-align:center">当前列组合无法绘制该图表，请调整「数据映射」中的变量选择。</div>';
        $('#chartNote').textContent = '';
        return;
      }
    } catch (e) {
      host.innerHTML = `<div style="padding:30px;color:#b42318;font-size:12.5px">图表渲染失败：${U.escapeHtml(e.message)}</div>`;
      return;
    }
    const type = LD.charts.typeByKey(ctx.type);
    $('#chartNote').textContent = LD.charts.describeNote(ctx.type, ctx.enc, ctx.style, ctx.ds);
    $('#chartTitle').textContent = '图表预览 · ' + type.name;
    renderAnnotPanel();
  }

  function renderAnnotPanel() {
    const card = $('#statAnnotCard');
    if (!card) return;
    const type = st().chart.type;
    const supported = ['bar', 'barH', 'box', 'violin'].includes(type);
    card.hidden = !supported;
    if (!supported) return;
    const an = st().annot;
    $('#annotMode').value = an.mode;
    $('#annotTest').value = an.test;
    $('#annotAdj').value = an.adj;
    const fromTest = !!(an.sourceId && LD.app.resultById(an.sourceId));
    ['annotMode', 'annotTest', 'annotAdj'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.disabled = fromTest;
    });
    const out = $('#annotOut');
    out.textContent = st()._annotNote || (an.mode === 'none' ? '选择标注方式后，会自动对各组做两两比较并绘制显著性括号。' : '');
    if (fromTest) {
      out.appendChild(h('div', { style: { marginTop: '6px' } },
        h('button.btn.ghost.sm', { 'data-act': 'clearAnnotSource' }, '清除标注来源，改为按图表重算')));
    }
    if (an.mode !== 'none' && st()._annotRows && st()._annotRows.length) {
      const rows = st()._annotRows;
      out.appendChild(h('div', { style: { marginTop: '8px' } },
        h('div.table-wrap', h('table',
          h('thead', h('tr', ['比较', '统计量', 'p（原始）', 'p（校正）', '显著性'].map((t, i) => h('th' + (i > 0 ? '.num' : ''), t)))),
          h('tbody', rows.map((r) => h('tr',
            h('td', `${r.a} vs ${r.b}`),
            h('td.num', `${r.statName} = ${U.fmt(r.stat, 2)}`),
            h('td.num', U.fmtP(r.p)),
            h('td.num', U.fmtP(r.pAdj)),
            h('td.num', U.stars(r.pAdj)))))))));
    }
  }

  /* ==================================================================
     6 报告与代码
     ================================================================== */
  function renderReportView() {
    renderCode();
    const cap = $('#btnAiCaption');
    if (cap) cap.disabled = !LD.ai.isReady();
    $('#reportPreview').innerHTML = st().reportHtml || '<p class="muted small">点击「生成报告」汇总当前数据、整理步骤、统计结果与图表。</p>';
  }

  function renderCode() {
    const out = $('#codeOut');
    const curve = st().curve;
    const curveAnalysis = (curve && curve.x && curve.ys && curve.ys.length) ? LD.app.curveAnalysis() : null;
    const curveFit = (LD.curveUI && curveAnalysis) ? LD.curveUI.validFit(curveAnalysis) : null;
    const state = {
      dataset: LD.app.workDataset(),
      pipeline: LD.app.pipeline(),
      lastTest: st().lastTest,
      chart: st().chart,
      curve,
      curveAnalysis,
      curveFit,
    };
    out.textContent = codeLang === 'py' ? LD.codegen.pythonCode(state) : LD.codegen.rCode(state);
    $$('#codeTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.lang === codeLang));
  }

  function autoCaption(ctx) {
    if (!ctx) return '';
    const ds = ctx.ds;
    const type = LD.charts.typeByKey(ctx.type);
    const n = ds.rows.length;
    const note = LD.charts.describeNote(ctx.type, ctx.enc, ctx.style, ctx.ds);
    const groupInfo = ctx.enc.x && ctx.enc.y
      ? `${ctx.enc.y} 随 ${ctx.enc.x}${ctx.enc.series ? '（按 ' + ctx.enc.series + ' 分组）' : ''} 的变化`
      : '';
    return `图 1　${ds.name}的${type.name}。${groupInfo}。样本量 n = ${n}。${note}。`;
  }

  function buildReport() {
    const ctx = chartCtx();
    let svg = '';
    try { svg = LD.charts.buildSVG(ctx) || ''; } catch (e) { svg = ''; }
    const caption = st().caption || autoCaption(ctx);
    const curve = st().curve;
    const curveAnalysis = (curve && curve.x && curve.ys && curve.ys.length) ? LD.app.curveAnalysis() : null;
    const curveFit = (LD.curveUI && curveAnalysis) ? LD.curveUI.validFit(curveAnalysis) : null;
    let curveSvg = '';
    try { curveSvg = (curveAnalysis && LD.curveUI && LD.curveUI.buildSVG) ? (LD.curveUI.buildSVG() || '') : ''; }
    catch (e) { curveSvg = ''; }
    const html = LD.report.buildHTML({
      dataset: LD.app.workDataset(),
      pipeline: LD.app.pipeline(),
      descRows: st().descRows,
      lastTest: st().lastTest,
      results: LD.app.visibleResults(),
      interpretation: st().interpretation,
      curve,
      curveAnalysis,
      curveFit,
      curveSvg,
    }, { svg, caption });
    st().reportHtml = html;
    const preview = $('#reportPreview');
    preview.innerHTML = html;
    U.toast('报告已生成', 'ok');
  }

  /* ==================================================================
     OCR 校对表
     ================================================================== */
  function renderOcrReview() {
    const card = $('#ocrReviewCard');
    const ocr = st().ocr;
    if (!ocr.table) {
      if (!ocr.image) { card.hidden = true; return; }
      card.hidden = false;
      $('#ocrPreview').src = ocr.image;
      $('#ocrGrid').innerHTML = '<p class="muted small" style="padding:14px">识别结果将显示在这里。手写记录建议先用手机拍正、裁掉无关边缘，识别准确率会明显提高。</p>';
      return;
    }
    const img = $('#ocrPreview');
    img.src = ocr.image || '';
    const grid = $('#ocrGrid');
    grid.innerHTML = '';
    const t = h('table');
    t.appendChild(h('thead', h('tr',
      h('th.row-idx', '#'),
      ocr.table[0].map((c, ci) => h('th', h('input.cell-input', {
        value: c === null ? '' : String(c), 'data-change': 'ocrCell', 'data-r': 0, 'data-c': ci,
        style: { fontWeight: '600' },
      }))))));
    const tb = h('tbody');
    ocr.table.slice(1).forEach((row, ri) => {
      tb.appendChild(h('tr', h('td.row-idx', String(ri + 1)),
        row.map((v, ci) => h('td', h('input.cell-input', {
          value: v === null ? '' : String(v), 'data-change': 'ocrCell', 'data-r': ri + 1, 'data-c': ci,
        })))));
    });
    t.appendChild(tb);
    grid.appendChild(t);
    if (ocr.notes) {
      grid.appendChild(h('p.small.muted', { style: { padding: '8px 10px' } }, '识别备注：' + ocr.notes));
    }
  }

  /* ==================================================================
     事件
     ================================================================== */
  const handlers = {
    gotoImport() { LD.app.go('import'); },
    loadSample(el) {
      const smp = LD.parse.SAMPLES.find((s) => s.key === el.dataset.key);
      if (!smp) return;
      LD.app.addDataset(smp.make());
    },
    removeOp(el) {
      LD.app.removeOp(Number(el.dataset.index));
    },
    setChartType(el) {
      st().chart.type = el.dataset.type;
      LD.app.ensureEncodings();
      renderChartView();
      LD.app.persist();
    },
    copyText(el) {
      U.copyText(el.dataset.text || '').then(() => U.toast('已复制', 'ok'));
    },
    copyDesc() {
      const tsv = descTableTsv();
      if (!tsv) { U.toast('当前没有可复制的描述统计表', 'warn'); return; }
      U.copyText(tsv).then(() => U.toast('已复制，可直接粘贴到 Excel / Word', 'ok'));
    },
    plotTest(el) {
      LD.app.plotTestResult(el.dataset.id, el.dataset.kind);
    },
    viewResult(el) {
      const r = LD.app.resultById(el.dataset.id);
      if (!r) return;
      st().lastTest = r;
      st().interpretation = '';
      renderStats();
      LD.app.persist();
    },
    removeResult(el) {
      LD.app.removeResult(el.dataset.id);
    },
    clearResults() {
      const n = LD.app.visibleResults().length;
      if (!n) { U.toast('当前数据集还没有分析结果', 'warn'); return; }
      U.modal('清空分析结果', h('p', `确定清空当前数据集的 ${n} 条分析结果吗？图表上的显著性标注来源也会一并清除。`), [
        { label: '取消' },
        { label: '清空', primary: true, onClick: () => LD.app.clearResults() },
      ]);
    },
    clearAnnotSource() {
      st().annot.sourceId = null;
      renderChartView();
      LD.app.persist();
      U.toast('已改为按当前图表重新计算显著性', 'ok');
    },
    dropColumn(el) {
      const name = el.dataset.col;
      if (!name) return;
      U.modal('删除列', h('p', `确定从工作数据中删除「${name}」吗？这会记作一条整理步骤，可在左栏的整理记录里撤回。`), [
        { label: '取消' },
        { label: '删除', primary: true, onClick: () => LD.app.pushOp('dropcol', { cols: [name] }) },
      ]);
    },
    removeDataset() {      const e = LD.app.activeEntry();
      if (!e) return;
      U.modal('移除数据集', h('p', `确定移除「${e.ds.name}」吗？该操作不可撤销（工程文件中也不会再包含它）。`), [
        { label: '取消' },
        { label: '移除', primary: true, onClick: () => { LD.app.removeDataset(e.id); renderAll(); } },
      ]);
    },
    ocrAccept() {
      const ocr = st().ocr;
      if (!ocr.table || ocr.table.length < 2) { U.toast('表格为空', 'warn'); return; }
      const ds = LD.parse.fromMatrix(ocr.table, { header: true, name: '图片识别数据 ' + new Date().toLocaleTimeString('zh-CN').slice(0, 5), meta: { source: 'ocr' } });
      LD.app.addDataset(ds);
      st().ocr = { image: null, table: null, notes: '' };
      renderOcrReview();
    },
    ocrAddRow() {
      const t = st().ocr.table;
      if (!t) return;
      t.push(new Array(t[0].length).fill(null));
      renderOcrReview();
    },
    ocrAddCol() {
      const t = st().ocr.table;
      if (!t) return;
      t.forEach((r) => r.push(null));
      t[0][t[0].length - 1] = '新列';
      renderOcrReview();
    },
    ocrDiscard() {
      st().ocr = { image: null, table: null, notes: '' };
      renderOcrReview();
      U.toast('已丢弃识别结果');
    },
    async runOcr() {
      const ocr = st().ocr;
      if (!ocr.image) { U.toast('请先上传图片', 'warn'); return; }
      const btn = $('#btnOcr');
      const status = $('#ocrStatus');
      btn.disabled = true;
      status.textContent = '正在识别…（手写内容可能需要 10–30 秒）';
      try {
        const res = await LD.ai.ocrImage(ocr.image, {
          hint: $('#ocrHint').value,
          unitHint: $('#ocrUnitHint').value.trim(),
        });
        const matrix = [res.columns].concat(res.rows.map((r) => r.map((v) => (v === null ? null : v))));
        st().ocr.table = matrix;
        st().ocr.notes = (res.notes || '') + `（模型：${res.model}）`;
        status.textContent = `识别完成：${res.rows.length} 行 × ${res.columns.length} 列，请核对`;
        renderOcrReview();
      } catch (e) {
        status.textContent = '';
        U.toast(e.message, 'err', 6000);
      } finally {
        btn.disabled = false;
      }
    },
    async runLocalOcr() {
      const ocr = st().ocr;
      if (!ocr.image) { U.toast('请先上传图片', 'warn'); return; }
      const btn = $('#btnOcrLocal');
      const status = $('#ocrStatus');
      btn.disabled = true;
      status.textContent = '正在加载本地识别引擎…';
      try {
        const res = await LD.ai.localOcr(ocr.image, (s, p) => {
          status.textContent = `本地识别：${s} ${p ? Math.round(p * 100) + '%' : ''}`;
        });
        if (!res.matrix.length) throw new Error('未识别到表格结构');
        st().ocr.table = res.matrix;
        st().ocr.notes = '本地 OCR 结果按空白分列，请务必逐格核对。';
        status.textContent = `本地识别完成：${res.matrix.length} 行，请核对`;
        renderOcrReview();
      } catch (e) {
        status.textContent = '';
        U.toast('本地识别失败：' + e.message, 'err', 6000);
      } finally {
        btn.disabled = false;
      }
    },
    async interpret() {
      const lt = st().lastTest;
      if (!lt) return;
      const btn = $('#btnInterpret');
      const status = $('#interpretStatus');
      btn.disabled = true;
      status.textContent = '正在生成…';
      try {
        const payload = {
          数据集: LD.app.workDataset().name,
          检验: lt.render.title,
          统计量: (lt.render.stats || []).map((s) => `${s.k}=${s.v}`).join('; '),
          前提检查: lt.render.notes,
          结论: lt.render.conclusion,
        };
        const txt = await LD.ai.explain(payload);
        st().interpretation = txt;
        status.textContent = '';
        renderTestResult();
      } catch (e) {
        status.textContent = '';
        U.toast(e.message, 'err', 6000);
      } finally {
        btn.disabled = false;
      }
    },
    exportPng() {      const ctx = chartCtx();
      LD.charts.exportPNG(ctx, (LD.app.workDataset() ? LD.app.workDataset().name : 'figure') + '.png');
      U.toast('已导出 600 dpi PNG', 'ok');
    },
    exportSvg() {
      const ctx = chartCtx();
      if (LD.charts.exportSVG(ctx, (LD.app.workDataset() ? LD.app.workDataset().name : 'figure') + '.svg')) U.toast('已导出矢量 SVG', 'ok');
    },
    exportPdf() {
      const ctx = chartCtx();
      if (LD.charts.printPDF(ctx)) U.toast('已打开打印窗口，选择「存储为 PDF」即可得到矢量图', 'ok', 5000);
    },
    chartCode() {
      LD.app.go('report');
      codeLang = 'py';
      renderCode();
    },
    resetStyle() {
      st().chart.style = Object.assign({}, LD.charts.STYLE_DEFAULTS);
      renderStylePanel();
      renderCanvas();
      LD.app.persist();
    },
    async aiCaption() {
      const ctx = chartCtx();
      if (!ctx) return;
      const btn = $('#btnAiCaption');
      btn.disabled = true;
      btn.textContent = '撰写中…';
      try {
        const type = LD.charts.typeByKey(ctx.type);
        const payload = {
          图表类型: type.name,
          数据集: ctx.ds.name,
          变量: ctx.enc,
          误差棒: ctx.style.errType,
          样本量: ctx.ds.rows.length,
          技术说明: LD.charts.describeNote(ctx.type, ctx.enc, ctx.style, ctx.ds),
          统计结果: st().lastTest ? st().lastTest.render.title : '未做检验',
        };
        st().caption = await LD.ai.caption(payload);
        buildReport();
        U.toast('图注已生成，并写入报告', 'ok');
      } catch (e) {
        U.toast(e.message, 'err', 6000);
      } finally {
        btn.disabled = false;
        btn.textContent = 'AI 撰写图注';
      }
    },
    buildReport,
    exportReportHtml() {
      if (!st().reportHtml) buildReport();
      U.download('report-' + new Date().toISOString().slice(0, 10) + '.html',
        LD.report.documentHTML(st().reportHtml), 'text/html;charset=utf-8');
    },
    copyReportMd() {
      const md = LD.report.buildMarkdown({
        dataset: LD.app.workDataset(), pipeline: LD.app.pipeline(),
        descRows: st().descRows, lastTest: st().lastTest, interpretation: st().interpretation,
      });
      U.copyText(md).then(() => U.toast('Markdown 已复制', 'ok'));
    },
    copyPy() {
      U.copyText($('#codeOut').textContent).then(() => U.toast('代码已复制', 'ok'));
    },
    exportXlsx() { LD.app.exportXlsx('work'); },
    exportCsv2() { LD.app.exportCsv('work'); },
    exportRaw() { LD.app.exportCsv('raw'); },
    exportProject() { LD.app.exportProject(); },
    help() { showHelp(); },
    project() { showProject(); },
    newData() { LD.app.go('import'); },
    parsePaste() {
      const txt = $('#pasteArea').value.trim();
      if (!txt) { U.toast('请先粘贴内容', 'warn'); return; }
      try {
        const ds = LD.parse.parseTextToDataset(txt, '粘贴数据 ' + new Date().toLocaleTimeString('zh-CN').slice(0, 5), { header: true });
        LD.app.addDataset(ds);
      } catch (e) { U.toast(e.message, 'err'); }
    },
    autoType() {
      const e = LD.app.activeEntry();
      if (!e) return;
      e.ds.columns.forEach((c, i) => {
        c.type = LD.parse.inferType(e.ds.rows.map((r) => r[i]));
        const coerced = LD.parse.coerceColumn(e.ds.rows.map((r) => r[i]), c.type);
        e.ds.rows.forEach((r, k) => { r[i] = coerced[k]; });
      });
      LD.app.afterPipelineChange();
      U.toast('已按当前数据重新推断列类型', 'ok');
    },
  };

  const changeHandlers = {
    setType(el) {
      LD.app.pushOp('settype', { col: el.dataset.col, type: el.value });
    },
    editCell(el) {
      const e = LD.app.activeEntry();
      if (!e) return;
      const r = Number(el.dataset.row), c = Number(el.dataset.col);
      if (!e.ds.rows[r]) return;
      const col = e.ds.columns[c];
      const v = el.value.trim();
      e.ds.rows[r][c] = v === '' ? null : (col.type === 'number' ? U.parseNum(v) : v);
      if (col.type === 'number' && Number.isNaN(e.ds.rows[r][c])) e.ds.rows[r][c] = null;
      LD.app.invalidateWork();
      LD.app.recomputeDesc();
      LD.app.persist();
    },
    descGroup(el) {
      st().descGroup = el.value;
      renderDescTable();
      LD.app.persist();
    },
    ocrCell(el) {
      const t = st().ocr.table;
      if (!t) return;
      const r = Number(el.dataset.r), c = Number(el.dataset.c);
      if (!t[r]) return;
      t[r][c] = el.value === '' ? null : el.value;
    },
    setEnc(el) {
      st().chart.enc[el.dataset.enc] = el.value || null;
      renderCanvas();
      LD.app.persist();
    },
    setAgg(el) {
      st().chart.enc.agg = el.value;
      renderCanvas();
      LD.app.persist();
    },
    setEncMethod(el) {
      st().chart.enc.method = el.value;
      renderCanvas();
      LD.app.persist();
    },
    setMulti(el) {
      st().chart.enc.multi = Array.from(el.selectedOptions).map((o) => o.value);
      renderCanvas();
      LD.app.persist();
    },
    setStyle(el) {
      const k = el.dataset.key;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number' || el.type === 'range') v = Number(v);
      st().chart.style[k] = v;
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = v;
      renderCanvas();
      LD.app.persist();
    },
    annotChange(el) {
      const an = st().annot;
      if (el.id === 'annotMode') an.mode = el.value;
      if (el.id === 'annotTest') an.test = el.value;
      if (el.id === 'annotAdj') an.adj = el.value;
      // 用户手动改标注方式后，就不再沿用上一次检验的来源
      an.sourceId = null;
      renderCanvas();
      LD.app.persist();
    },
    testFamilyChange() {
      renderTestForm();
    },
    testInputChange() {
      renderTestForm();
    },
  };

  /* ---------- 弹窗 ---------- */
  function showHelp() {
    const body = h('div',
      h('h4', '工作流程'),
      h('p', '按左侧 1→7 的顺序走完即可：数据接入 → 检查列类型 → 整理清洗 → 曲线分析 → 统计分析 → 图表绘制 → 报告与代码。每一步都不改变原始数据，可随时撤销。'),
      h('h4', '关于曲线分析'),
      h('ul',
        h('li', '适用于「x–y」结构的仪器曲线：XRD、光谱、色谱、热分析、生长曲线、剂量响应等。'),
        h('li', '预处理顺序固定为「裁剪 → 基线 → 平滑 → 求导 → 归一化」。求导复用平滑窗口；基线校正不会削掉峰本身。'),
        h('li', '寻峰按峰高、显著度与最小间距筛选，并给出 FWHM 与积分面积。显著度用于过滤「侧翼比峰顶还高」的假峰。'),
        h('li', '非线性拟合使用 Levenberg–Marquardt，给出参数估计、标准误与 95% 置信区间。参数停在边界或 R² 偏低时会明确提示。'),
        h('li', '拟合结果是派生量，不会写进工程文件；切换数据集或改参数后需要重新点击「运行拟合」。')),
      h('h4', '关于统计方法'),
      h('ul',
        h('li', '两组比较：默认先做 Levene 方差齐性检验，方差不齐时自动改用 Welch 校正。'),
        h('li', '多组比较：单因素方差分析；方差不齐或数据非正态时改用 Kruskal–Wallis。事后两两比较使用 Holm 校正控制假阳性。'),
        h('li', '正态性：同时给出 Shapiro–Wilk（n ≤ 5000）与 D\'Agostino–Pearson K²（n ≥ 8），两者不一致时以 Shapiro–Wilk 为主。'),
        h('li', '相关：Pearson 要求线性且近似正态；关系为单调非线性时请看 Spearman ρ。'),
        h('li', '回归：报告 R²、调整 R²、F 检验、各系数 t 检验与 VIF，并检查残差自相关（Durbin–Watson）。'),
        h('li', '效应量：t 检验给 Cohen\'s d / Hedges\' g，方差分析给 η² / ω²，秩和检验给 r / ε²。'),
        h('li', '每次检验都会保留在「分析结果」里。点「出图」可直接把分组变量、响应变量与两两比较结果带到图表页，显著性括号用的就是这次检验的校正后 p 值，不会另算一套。')),
      h('h4', '关于图表'),
      h('ul',
        h('li', '图幅按毫米设置（单栏常用 85 mm，双栏 170 mm），字号以 pt 计，与期刊排版一致。'),
        h('li', 'SVG 为矢量格式，可直接导入 Illustrator / Inkscape 修改后另存 EPS。'),
        h('li', 'PDF 通过浏览器打印生成，请在打印对话框中选择「存储为 PDF」，并确保缩放为 100%。'),
        h('li', 'PNG 导出为 600 dpi，满足绝大多数期刊对位图的分辨率要求。')),
      h('h4', '数据安全'),
      h('p', '文件解析、统计计算、作图全部在你的浏览器内完成，原始数据不会上传。只有在使用「AI 识别」与「AI 解读」时，对应的图片或统计摘要才会发送给模型服务。工程会自动保存在本机浏览器中，可随时导出为 .json 备份。'));
    U.modal('使用说明', body);
  }

  function showProject() {
    const body = h('div',
      h('p', '工程文件包含原始数据、整理步骤、图表样式与统计设置，可用于换机器继续分析或与同组同学共享分析流程。'),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
        h('button.btn', { 'data-act': 'exportProject' }, '导出工程 (.json)'),
        h('button.btn', { 'data-act': 'importProjectFile' }, '导入工程 (.json)'),
        h('input', { type: 'file', id: 'projFile', accept: '.json', hidden: true })),
      h('p.small.muted', { style: { marginTop: '12px' } }, '提示：导入工程会替换当前所有数据集，请先导出备份。'));
    const close = U.modal('工程文件', body);
    $('#projFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      f.text().then((t) => {
        try {
          LD.app.importProject(t);
          close();
          renderAll();
          U.toast('工程已载入', 'ok');
        } catch (err) { U.toast('载入失败：' + err.message, 'err'); }
      });
    });
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t || t.disabled) return;
      const act = t.dataset.act;
      if (handlers[act]) {
        e.preventDefault();
        handlers[act](t, e);
      }
    });

    document.addEventListener('change', (e) => {
      const el = e.target;
      if (el.id === 'datasetSelect') {
        LD.app.setActive(el.value);
        renderAll();
        return;
      }
      if (el.dataset.change && changeHandlers[el.dataset.change]) {
        changeHandlers[el.dataset.change](el, e);
        return;
      }
      if (el.id === 'testFamily') { renderTestForm(); return; }
      if (['testY', 'testG', 'testX'].includes(el.id)) { renderTestForm(); return; }
      if (el.id === 'colSearch') { renderTable(); return; }
    });

    document.addEventListener('input', (e) => {
      const el = e.target;
      if (el.id === 'colSearch') { renderTable(); return; }
      if (el.dataset.input === 'setStyleLive') {
        const out = el.parentElement.querySelector('output');
        if (out) out.textContent = el.value;
      }
    });

    $('#rail').addEventListener('click', (e) => {
      const b = e.target.closest('.rail-item');
      if (b) LD.app.go(b.dataset.view);
    });

    $('#btnUndo').addEventListener('click', () => { LD.app.undo(); });
    $('#btnNew').addEventListener('click', () => {
      // 已经在导入页时直接弹文件选择框，否则先跳过去
      if (LD.app.state.view === 'import') { const fi = $('#fileInput'); if (fi) fi.click(); return; }
      LD.app.go('import');
    });

    // 窗口尺寸变化后按新宽度重新计算预览缩放，避免图表被裁或留大片空白
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (LD.app.state.view === 'chart') renderCanvas();
      }, 220);
    });

    // 文件导入
    const fileInput = $('#fileInput');
    fileInput.addEventListener('change', (e) => handleFiles(Array.from(e.target.files)));
    const drop = $('#fileDrop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => handleFiles(Array.from(e.dataTransfer.files)));

    /* 兜住「拖到虚线框以外」的文件：浏览器默认会直接打开文件、把整个页面顶掉，
       用户看到的就是「网站没了」。这里一律拦下，并指回正确的投放区域。 */
    ['dragover', 'drop'].forEach((ev) => {
      window.addEventListener(ev, (e) => {
        if (e.target.closest && e.target.closest('.dropzone')) return; // 交给上面的处理器
        e.preventDefault();
        if (ev !== 'drop') return;
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (!files.length) return;
        U.toast('请把文件拖到「导入数据文件」或「识别图片」的虚线框内', 'warn');
        if (LD.app.state.view !== 'import') LD.app.go('import');
      });
    });

    // 图片
    const imgInput = $('#imgInput');
    imgInput.addEventListener('change', (e) => handleImage(e.target.files[0]));
    const idrop = $('#imgDrop');
    ['dragenter', 'dragover'].forEach((ev) => idrop.addEventListener(ev, (e) => { e.preventDefault(); idrop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => idrop.addEventListener(ev, (e) => { e.preventDefault(); idrop.classList.remove('over'); }));
    idrop.addEventListener('drop', (e) => handleImage(e.dataTransfer.files[0]));

    $('#btnOcr').addEventListener('click', () => handlers.runOcr());
    $('#btnOcrLocal').addEventListener('click', () => handlers.runLocalOcr());
    $('#btnOcrAccept').addEventListener('click', () => handlers.ocrAccept());
    $('#btnOcrAddRow').addEventListener('click', () => handlers.ocrAddRow());
    $('#btnOcrAddCol').addEventListener('click', () => handlers.ocrAddCol());
    $('#btnOcrDiscard').addEventListener('click', () => handlers.ocrDiscard());
    $('#btnPaste').addEventListener('click', () => handlers.parsePaste());
    $('#btnExportCsv').addEventListener('click', () => LD.app.exportCsv('work'));
    $('#btnAutoType').addEventListener('click', () => handlers.autoType());

    $('#btnRunTest').addEventListener('click', runTestFromForm);
    $('#btnInterpret').addEventListener('click', () => handlers.interpret());
    $('#btnDescAll').addEventListener('click', () => { LD.app.recomputeDesc(); renderDescTable(); });

    $('#btnChartPng').addEventListener('click', () => handlers.exportPng());
    $('#btnChartSvg').addEventListener('click', () => handlers.exportSvg());
    $('#btnChartPdf').addEventListener('click', () => handlers.exportPdf());
    $('#btnChartCode').addEventListener('click', () => handlers.chartCode());
    $('#btnStyleReset').addEventListener('click', () => handlers.resetStyle());

    ['annotMode', 'annotTest', 'annotAdj'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.addEventListener('change', () => changeHandlers.annotChange(el));
    });

    $('#btnBuildReport').addEventListener('click', () => buildReport());
    $('#btnAiCaption').addEventListener('click', () => handlers.aiCaption());
    $('#btnReportHtml').addEventListener('click', () => handlers.exportReportHtml());
    $('#btnReportMd').addEventListener('click', () => handlers.copyReportMd());
    $('#btnCopyPy').addEventListener('click', () => handlers.copyPy());
    $('#btnCopyR').addEventListener('click', () => {
      const curve = st().curve;
      const curveAnalysis = (curve && curve.x && curve.ys && curve.ys.length) ? LD.app.curveAnalysis() : null;
      U.copyText(LD.codegen.rCode({
        dataset: LD.app.workDataset(), pipeline: LD.app.pipeline(),
        lastTest: st().lastTest, chart: st().chart,
        curve, curveAnalysis,
        curveFit: (LD.curveUI && curveAnalysis) ? LD.curveUI.validFit(curveAnalysis) : null,
      })).then(() => U.toast('R 代码已复制', 'ok'));
    });
    $('#codeTabs').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t) return;
      codeLang = t.dataset.lang;
      renderCode();
    });
    $('#btnExportXlsx').addEventListener('click', () => handlers.exportXlsx());
    $('#btnExportCsv2').addEventListener('click', () => handlers.exportCsv2());
    $('#btnExportProject').addEventListener('click', () => handlers.exportProject());
    $('#btnExportRaw').addEventListener('click', () => handlers.exportRaw());
    $('#btnHelp').addEventListener('click', () => showHelp());
    $('#btnProject').addEventListener('click', () => showProject());

    window.addEventListener('resize', U.debounce(() => { if (chartEl) renderCanvas(); }, 200));
  }

  function runTestFromForm() {
    const fam = $('#testFamily').value;
    const params = {
      y: $('#testY').value,
      g: $('#testG') && !$('#testG').closest('.field').hidden ? $('#testG').value : null,
      x: $('#testX') && !$('#testXWrap').hidden ? $('#testX').value : null,
      alpha: Number($('#testAlpha').value) || 0.05,
    };
    const mu0El = $('#extra_mu0');
    if (mu0El) params.mu0 = Number(mu0El.value);
    const ga = $('#extra_groupA'), gb = $('#extra_groupB');
    if (ga) { params.groupA = ga.value; st()._groupA = ga.value; }
    if (gb) { params.groupB = gb.value; st()._groupB = gb.value; }
    const xs = $('#extra_xs');
    if (xs) params.xs = Array.from(xs.selectedOptions).map((o) => o.value);

    let res = null;
    try {
      res = LD.app.runTest(fam, params);
    } catch (err) {
      $('#testResult').className = 'result-pane muted';
      $('#testResult').textContent = '分析过程出错：' + err.message + '。请检查所选变量的取值。';
      return;
    }
    if (!res) {
      $('#testResult').className = 'result-pane muted';
      $('#testResult').textContent = LD.app.lastFail || '当前变量组合无法完成该检验，请检查所选列的类型与取值。';
      return;
    }
    renderTestResult();
    renderResults();
    renderTestHint();
  }

  function handleFiles(files) {
    if (!files.length) return;
    const hr = Number($('#optHeaderRow') && $('#optHeaderRow').value);
    const opts = {
      header: $('#optHeader').checked,
      encoding: $('#optEncoding').value,
      // 0 表示自动检测；用户填了正整数才强制指定
      headerRow: Number.isFinite(hr) && hr > 0 ? Math.floor(hr) : undefined,
    };
    let done = 0;
    const total = files.length;
    files.forEach((f) => {
      LD.parse.readFile(f, opts).then((list) => {
        let skipped = 0;
        list.forEach((ds) => {
          ds.meta.fileName = f.name;
          if (ds.meta.skippedRows) skipped += ds.meta.skippedRows;
          LD.app.addDataset(ds, { silent: true });
        });
        done++;
        if (done === total) {
          const ds = LD.app.workDataset();
          const shape = ds ? `：${ds.rows.length} 行 × ${ds.columns.length} 列` : '';
          const extra = skipped ? `，已自动跳过 ${skipped} 行标题` : '';
          U.toast(`已导入 ${total} 个文件${shape}${extra}`, 'ok', 5000);
          LD.app.go('table');
        }
      }).catch((e) => {
        done++;
        U.toast(`${f.name}：${e.message}`, 'err', 6000);
        if (done === total) renderAll();
      });
    });
  }

  function handleImage(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { U.toast('请上传图片文件', 'warn'); return; }
    if (file.size > 12 * 1024 * 1024) { U.toast('图片超过 12 MB，请压缩后重试', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      st().ocr.image = reader.result;
      $('#btnOcr').disabled = false;
      $('#btnOcrLocal').disabled = false;
      $('#ocrStatus').textContent = '图片已载入，可开始识别';
      const img = $('#ocrPreview');
      img.src = reader.result;
      $('#ocrReviewCard').hidden = false;
      if (!st().ocr.table) $('#ocrGrid').innerHTML = '<p class="muted small" style="padding:12px">识别结果将显示在这里。</p>';
      renderOcrReview();
    };
    reader.readAsDataURL(file);
  }

  LD.ui = { bind, renderAll, renderAiStatus, renderOcrReview, renderChartView, fieldControl, readOpValues };
})();
