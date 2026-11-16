/* LabDesk · 曲线分析界面
   --------------------------------------------------------------------------
   左侧参数、右侧预览的分栏与「图表绘制」保持一致。所有控件都是原生 DOM，
   不引入框架；参数变化后只重算派生结果，不改原始数据。
   ========================================================================== */
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;
  const h = U.h;
  const $ = U.$;
  const MM2PX = 96 / 25.4;

  const st = () => LD.app.state;
  const C = () => LD.app.state.curve;

  let chartInst = null;
  let residualInst = null;
  let bound = false;
  let cache = { key: '', value: null };

  /* ==================== 分析缓存 ==================== */
  function dataKey() {
    const c = C();
    const ds = LD.app.workDataset();
    return [
      st().activeId,
      ds ? ds.rows.length + 'x' + ds.columns.length : '-',
      LD.app.pipeline().map((s) => s.id).join(','),
      JSON.stringify(c.pre),
      c.x,
      (c.ys || []).join('|'),
    ].join('::');
  }

  function analysisKey() {
    return dataKey() + '::' + JSON.stringify(C().peaks);
  }

  function analyze() {
    const key = analysisKey();
    if (cache.key === key) return cache.value;
    const v = LD.app.curveAnalysis();
    cache = { key, value: v };
    return v;
  }

  function fitSig(a) {
    if (!a) return '';
    const c = C();
    return dataKey() + '::' + c.fit.model + '::' + c.fit.target + '::' + JSON.stringify(c.fit.init || {});
  }

  function currentFit(a) {
    const c = C();
    const r = c.fit.result;
    if (!r || !c.fit.model || c.fit.model === 'none') return null;
    if (r._sig !== fitSig(a)) return null;
    return r;
  }

  function validFit(a) {
    const r = currentFit(a);
    return r && r.ok ? r : null;
  }

  /* ==================== 小工具 ==================== */
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function inputNum(v) {
    if (v === null || v === undefined || !isFinite(v)) return '';
    return String(+Number(v).toPrecision(8));
  }

  function field(label, control) {
    return h('label.field', h('span', label), control);
  }

  function selectEl(attrs, options, value) {
    return h('select', attrs, options.map((o) => {
      const val = Array.isArray(o) ? o[0] : o;
      const txt = Array.isArray(o) ? o[1] : o;
      return h('option', { value: val, selected: String(val) === String(value) }, txt);
    }));
  }

  function xRange() {
    const ds = LD.app.workDataset();
    const c = C();
    if (!ds || !c.x) return [null, null];
    const i = ds.columns.findIndex((col) => col.name === c.x);
    if (i < 0) return [null, null];
    const type = ds.columns[i].type;
    let lo = Infinity, hi = -Infinity;
    ds.rows.forEach((r) => {
      let v = r[i];
      if (type === 'date') v = Date.parse(v);
      if (typeof v === 'number' && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    });
    return isFinite(lo) ? [lo, hi] : [null, null];
  }

  function bestY(c) {
    const ds = LD.app.workDataset();
    if (!ds) return null;
    let best = null, bestN = -1;
    ds.columns.forEach((col, i) => {
      if (col.type !== 'number' || col.name === c.x) return;
      const n = new Set(ds.rows.map((r) => r[i])).size;
      if (n > bestN) { bestN = n; best = col.name; }
    });
    return best;
  }

  function sanitizeName(s) {
    return String(s || 'curve').replace(/[\\/:*?"<>|\s]+/g, '_');
  }

  /* ==================== 左侧面板 ==================== */
  function renderMap() {
    const ds = LD.app.workDataset();
    const box = $('#curveMap');
    if (!box || !ds) return;
    const c = C();
    box.innerHTML = '';
    const xs = ds.columns.filter((col) => col.type === 'number' || col.type === 'date').map((col) => col.name);
    const ys = ds.columns.filter((col) => col.type === 'number' && col.name !== c.x).map((col) => col.name);

    box.appendChild(field('横轴 X', selectEl({ 'data-curve': 'x' }, xs, c.x)));

    const multi = h('select', {
      multiple: true,
      size: Math.min(5, Math.max(3, ys.length)),
      'data-curve': 'ys',
      style: { height: 'auto', minHeight: '62px' },
    }, ys.map((n) => h('option', { value: n, selected: (c.ys || []).includes(n) }, n)));
    box.appendChild(field('纵轴 Y', multi));
    box.appendChild(h('p.muted.small', { style: { margin: '2px 0 0' } },
      '可多选，多条曲线叠加显示；峰表会逐条列出。按 Ctrl / ⌘ 点选。'));
    if (!c.x || !c.ys.length) {
      box.appendChild(h('p.muted.small', { style: { color: 'var(--warn)' } },
        '需要至少 1 个数值横轴和 1 个数值纵轴。若数据不是「x–y」结构，请先在「数据表」确认列类型。'));
    }
  }

  function renderPre() {
    const box = $('#curvePre');
    if (!box) return;
    const c = C();
    const pre = c.pre;
    box.innerHTML = '';

    // 裁剪
    box.appendChild(h('div.style-sep', '裁剪范围'));
    const [lo, hi] = xRange();
    const isDate = (() => {
      const ds = LD.app.workDataset();
      if (!ds || !c.x) return false;
      const col = ds.columns.find((x) => x.name === c.x);
      return col && col.type === 'date';
    })();
    box.appendChild(field('启用裁剪', h('input', {
      type: 'checkbox', 'data-pre': 'crop.on', checked: !!pre.crop.on,
    })));
    if (pre.crop.on) {
      if (isDate) {
        box.appendChild(h('p.muted.small', '日期轴暂不支持裁剪输入，可先用「整理清洗 → 筛选行」限定时间范围。'));
      } else {
        box.appendChild(field('起点', h('input', {
          type: 'number', step: 'any', 'data-pre': 'crop.lo',
          value: inputNum(pre.crop.lo === null || pre.crop.lo === undefined ? lo : pre.crop.lo),
        })));
        box.appendChild(field('终点', h('input', {
          type: 'number', step: 'any', 'data-pre': 'crop.hi',
          value: inputNum(pre.crop.hi === null || pre.crop.hi === undefined ? hi : pre.crop.hi),
        })));
      }
    }

    // 基线
    box.appendChild(h('div.style-sep', '基线校正'));
    box.appendChild(field('方法', selectEl({ 'data-pre': 'baseline.method' }, [
      ['none', '不校正'], ['als', 'ALS 非对称最小二乘'], ['poly', '多项式'], ['linear', '端点连线'], ['min', '减去最小值'],
    ], pre.baseline.method)));
    if (pre.baseline.method === 'poly') {
      box.appendChild(field('多项式阶数', h('input', {
        type: 'number', min: '1', max: '8', step: '1', 'data-pre': 'baseline.degree', value: inputNum(pre.baseline.degree),
      })));
    } else if (pre.baseline.method === 'als') {
      box.appendChild(field('平滑强度 λ', selectEl({ 'data-pre': 'baseline.lambda' }, [
        [1e4, '1×10⁴（贴合更紧）'], [1e5, '1×10⁵（常用）'], [1e6, '1×10⁶'], [1e7, '1×10⁷（更平滑）'],
      ], pre.baseline.lambda)));
      box.appendChild(field('非对称系数 p', selectEl({ 'data-pre': 'baseline.p' }, [
        [0.001, '0.001'], [0.01, '0.01（常用）'], [0.05, '0.05（更贴峰）'],
      ], pre.baseline.p)));
    }

    // 平滑
    box.appendChild(h('div.style-sep', '平滑'));
    box.appendChild(field('方法', selectEl({ 'data-pre': 'smooth.method' }, [
      ['none', '不平滑'], ['sg', 'Savitzky–Golay'], ['moving', '移动平均'], ['median', '中值滤波'], ['gaussian', '高斯'],
    ], pre.smooth.method)));
    if (pre.smooth.method !== 'none') {
      box.appendChild(field('窗口（点）', h('input', {
        type: 'number', min: '3', max: '101', step: '2', 'data-pre': 'smooth.window', value: inputNum(pre.smooth.window),
      })));
    }
    if (pre.smooth.method === 'sg') {
      box.appendChild(field('多项式阶数', selectEl({ 'data-pre': 'smooth.order' }, [
        [1, '1（保峰形）'], [2, '2（常用）'], [3, '3'], [4, '4（易过拟合）'],
      ], pre.smooth.order)));
    }

    // 求导与归一化
    box.appendChild(h('div.style-sep', '求导与归一化'));
    box.appendChild(field('导数阶数', selectEl({ 'data-pre': 'deriv' }, [
      [0, '不求导'], [1, '一阶导数'], [2, '二阶导数'],
    ], pre.deriv)));
    box.appendChild(field('归一化', selectEl({ 'data-pre': 'norm' }, [
      ['none', '不归一化'], ['max', '除以最大值'], ['area', '曲线下面积 = 1'], ['minmax', 'Min–Max 到 0–1'],
      ['snv', 'SNV 标准正态变换'], ['vector', '向量归一化'],
    ], pre.norm)));
    box.appendChild(h('p.muted.small', { style: { margin: '2px 0 0' } },
      '顺序固定为：裁剪 → 基线 → 平滑 → 求导 → 归一化。求导会复用平滑窗口。'));
  }

  function renderPeaks() {
    const box = $('#curvePeaks');
    if (!box) return;
    const c = C();
    const p = c.peaks;
    box.innerHTML = '';
    box.appendChild(field('启用寻峰', h('input', { type: 'checkbox', 'data-peak': 'peaks.on', checked: !!p.on })));
    if (!p.on) {
      box.appendChild(h('p.muted.small', '关闭后不计算峰，预览只显示曲线。'));
      return;
    }
    box.appendChild(field('相对峰高 ≥ (%)', h('input', {
      type: 'number', min: '0', max: '100', step: '0.5', 'data-peak': 'relHeight', value: inputNum(p.relHeight),
    })));
    box.appendChild(field('相对显著度 ≥ (%)', h('input', {
      type: 'number', min: '0', max: '100', step: '0.5', 'data-peak': 'relProminence', value: inputNum(p.relProminence),
    })));
    box.appendChild(field('峰间最小间隔（点）', h('input', {
      type: 'number', min: '1', max: '500', step: '1', 'data-peak': 'distance', value: inputNum(p.distance),
    })));
    box.appendChild(field('最多保留峰数', h('input', {
      type: 'number', min: '1', max: '200', step: '1', 'data-peak': 'maxPeaks', value: inputNum(p.maxPeaks),
    })));
    const a = analyze();
    const n = a ? a.series.reduce((s, x) => s + x.peaks.length, 0) : 0;
    box.appendChild(h('p.muted.small', { style: { margin: '2px 0 0' } },
      `当前检出 ${n} 个峰。显著度用于过滤「侧翼比峰顶还高」的假峰；间距用于防止一个宽峰被拆成两个。`));
  }

  function guessFor(model, a) {
    if (!model || !a) return {};
    const c = C();
    const s = a.series.find((x) => x.name === (c.fit.target || a.series[0].name)) || a.series[0];
    try { return model.guess(s.proc.x, s.proc.y) || {}; } catch (e) { return {}; }
  }

  function renderFit() {
    const box = $('#curveFit');
    if (!box) return;
    const c = C();
    box.innerHTML = '';
    box.appendChild(field('模型', selectEl({ 'data-fit': 'model' }, [
      ['none', '不拟合'],
    ].concat(LD.curve.MODELS.map((m) => [m.key, m.name])), c.fit.model)));

    if (!c.fit.model || c.fit.model === 'none') {
      box.appendChild(h('p.muted.small', '选择模型后可估计参数、标准误与 95% 置信区间。拟合作用于「预处理后」的曲线。'));
      return;
    }

    const a = analyze();
    if (!a) {
      box.appendChild(h('p.muted.small', '请先选择有效的 X / Y 列。'));
      return;
    }

    const model = LD.curve.modelByKey(c.fit.model);
    if (!model) return;
    box.appendChild(field('拟合曲线', selectEl({ 'data-fit': 'target' }, a.series.map((s) => [s.name, s.name]), c.fit.target)));

    const guess = guessFor(model, a);
    const init = c.fit.init || {};
    model.params.forEach((prm) => {
      const v = init[prm.k] !== undefined && init[prm.k] !== null ? init[prm.k] : guess[prm.k];
      box.appendChild(field(prm.label, h('input', {
        type: 'number', step: 'any', 'data-fit-param': prm.k, value: inputNum(v),
      })));
    });

    box.appendChild(h('p.muted.small', { style: { margin: '2px 0 0' } }, model.formula));
    const actions = h('div', { style: { display: 'flex', gap: '6px', marginTop: '2px' } },
      h('button.btn.primary.sm', { 'data-act': 'curveFitRun' }, '运行拟合'),
      h('button.btn.ghost.sm', { 'data-act': 'curveFitGuess' }, '重新猜测初值'));
    box.appendChild(actions);

    const fit = validFit(a);
    if (fit) {
      box.appendChild(h('p.muted.small', { style: { color: fit.r2 >= 0.9 ? 'var(--ok, #0a7)' : 'var(--warn)' } },
        `R² = ${U.fmt(fit.r2, 4)}　RMSE = ${U.fmt(fit.rmse, 4)}　n = ${fit.n}`));
    } else if (c.fit.result && c.fit.result.ok) {
      box.appendChild(h('p.muted.small', '参数或数据已改变，请重新运行拟合。'));
    }
  }

  function renderStyle() {
    const box = $('#curveStyle');
    if (!box) return;
    const s = C().style;
    box.innerHTML = '';
    box.appendChild(field('图幅宽 (mm)', h('input', {
      type: 'number', min: '40', max: '220', step: '5', 'data-style': 'widthMM', value: inputNum(s.widthMM),
    })));
    box.appendChild(field('图幅高 (mm)', h('input', {
      type: 'number', min: '30', max: '160', step: '5', 'data-style': 'heightMM', value: inputNum(s.heightMM),
    })));
    box.appendChild(field('字号 (pt)', h('input', {
      type: 'number', min: '5', max: '16', step: '0.5', 'data-style': 'fontSize', value: inputNum(s.fontSize),
    })));
    box.appendChild(field('线宽', h('input', {
      type: 'number', min: '0.4', max: '3', step: '0.1', 'data-style': 'lineWidth', value: inputNum(s.lineWidth),
    })));
    box.appendChild(field('配色', selectEl({ 'data-style': 'palette' },
      Object.keys(U.PALETTES).map((k) => [k, U.PALETTES[k].label]), s.palette)));
    box.appendChild(field('字体', selectEl({ 'data-style': 'fontFamily' }, LD.charts.FONTS, s.fontFamily)));
    box.appendChild(field('X 轴标题', h('input', {
      type: 'text', 'data-style': 'xLabel', value: s.xLabel || '', placeholder: '默认取列名',
    })));
    box.appendChild(field('Y 轴标题', h('input', {
      type: 'text', 'data-style': 'yLabel', value: s.yLabel || '', placeholder: '默认取列名',
    })));
    box.appendChild(field('显示原始曲线', h('input', { type: 'checkbox', 'data-style': 'showRaw', checked: !!s.showRaw })));
    box.appendChild(field('显示基线', h('input', { type: 'checkbox', 'data-style': 'showBaseline', checked: !!s.showBaseline })));
    box.appendChild(field('显示峰值标记', h('input', { type: 'checkbox', 'data-style': 'showPeaks', checked: !!s.showPeaks })));
    box.appendChild(h('p.muted.small', { style: { margin: '2px 0 0' } },
      '单栏图常用 85 mm，双栏 170 mm；字号 7–8 pt、线宽 1 pt 是多数期刊的常见要求。'));
  }

  /* ==================== 图表 ==================== */
  function sizeOf(k) {
    const s = C().style;
    return {
      w: Math.round(s.widthMM * MM2PX * k),
      h: Math.round(s.heightMM * MM2PX * k),
    };
  }

  function previewScale(el) {
    const s = C().style;
    const avail = (el.parentElement && el.parentElement.clientWidth ? el.parentElement.clientWidth : 720) - 20;
    const target = s.widthMM * MM2PX;
    return U.clamp(avail / target, 0.7, 2.6);
  }

  function buildOption(a, k) {
    const c = C();
    const pal = U.palette(c.style.palette);
    const fs = c.style.fontSize * 96 / 72 * k;
    const lw = c.style.lineWidth * k;
    const font = c.style.fontFamily;
    const series = [];
    const legend = [];
    const xTitle = String(c.style.xLabel || '').trim() || a.x;
    const yTitle = String(c.style.yLabel || '').trim() || (a.series.length === 1 ? a.series[0].name : '信号');

    a.series.forEach((s, si) => {
      const color = pal[si % pal.length];
      if (c.style.showRaw) {
        series.push({
          name: '__raw' + si,
          type: 'line',
          data: s.proc.x.map((x, i) => [x, s.proc.raw[i]]),
          showSymbol: false,
          silent: true,
          lineStyle: { width: Math.max(0.6, 0.8 * k), color: '#c3cbd3' },
          itemStyle: { color: '#c3cbd3' },
          z: 1,
        });
      }
      if (c.style.showBaseline && s.proc.baseline) {
        series.push({
          name: '__base' + si,
          type: 'line',
          data: s.proc.x.map((x, i) => [x, s.proc.baseline[i]]),
          showSymbol: false,
          silent: true,
          lineStyle: { width: Math.max(0.6, 0.9 * k), color: '#8a949e', type: 'dashed' },
          itemStyle: { color: '#8a949e' },
          z: 2,
        });
      }
      series.push({
        name: s.name,
        type: 'line',
        data: s.proc.x.map((x, i) => [x, s.proc.y[i]]),
        showSymbol: false,
        lineStyle: { width: Math.max(0.8, 1.6 * k), color },
        itemStyle: { color },
        emphasis: { focus: 'series' },
        z: 3,
      });
      legend.push(s.name);

      if (c.peaks.on && c.style.showPeaks !== false && s.peaks.length) {
        series.push({
          name: '__peak' + si,
          type: 'scatter',
          data: s.peaks.map((p) => [p.x, p.y]),
          symbol: 'triangle',
          symbolSize: 7 * k,
          itemStyle: { color, borderColor: '#fff', borderWidth: 0.8 * k },
          label: {
            show: a.series.length === 1 && s.peaks.length <= 15,
            position: 'top',
            formatter: (p) => U.fmt(p.data[0], 3),
            fontSize: Math.max(7, 7 * k),
            fontFamily: font,
            color: '#333',
          },
          silent: true,
          z: 5,
        });
      }
    });

    const fit = validFit(a);
    if (fit) {
      series.push({
        name: '拟合',
        type: 'line',
        data: fit.x.map((x, i) => [x, fit.fitted[i]]),
        showSymbol: false,
        silent: true,
        lineStyle: { width: Math.max(0.8, 1.5 * k), color: '#111', type: 'dashed' },
        itemStyle: { color: '#111' },
        z: 4,
      });
      legend.push('拟合');
    }

    const axisLabel = { color: '#222', fontSize: fs, fontFamily: font };    const axisLine = { lineStyle: { color: '#222', width: lw } };
    const axisTick = { show: true, inside: true, length: 3 * k, lineStyle: { color: '#222', width: lw } };

    return {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: font },
      legend: {
        show: legend.length > 1,
        data: legend,
        top: 0,
        left: 'center',
        orient: 'horizontal',
        itemWidth: 16 * k,
        itemHeight: 8 * k,
        itemGap: 10 * k,
        textStyle: { fontSize: fs, fontFamily: font, color: '#222' },
      },
      grid: { left: 62 * k, right: 24 * k, top: 34 * k, bottom: 46 * k, containLabel: true },
      xAxis: {
        type: a.xType === 'date' ? 'time' : 'value',
        name: xTitle,
        nameLocation: 'middle',
        nameGap: 28 * k,
        nameTextStyle: { color: '#222', fontSize: fs, fontFamily: font },
        axisLine,
        axisTick,
        axisLabel,
        splitLine: { show: false },
        scale: true,
      },
      yAxis: {
        type: 'value',
        name: yTitle,
        nameLocation: 'end',
        nameGap: 8 * k,
        nameTextStyle: { color: '#222', fontSize: fs, fontFamily: font, align: 'left', verticalAlign: 'bottom' },
        axisLine,
        axisTick,
        axisLabel,
        splitLine: { show: false },
        scale: true,
      },
      series,
      tooltip: { show: false },
    };
  }

  function renderChart() {
    const el = $('#curveCanvas');
    if (!el) return;
    if (typeof echarts === 'undefined') {
      el.innerHTML = '<p class="muted small" style="padding:20px">图表库未加载。</p>';
      return;
    }
    const a = analyze();
    if (!a) {
      el.innerHTML = '<p class="muted small" style="padding:20px">请选择横轴与纵轴后查看曲线。</p>';
      if (chartInst) { chartInst.clear(); }
      renderResidual(null);
      return;
    }
    const k = previewScale(el);
    const dim = sizeOf(k);
    const w = dim.w, hh = dim.h;
    el.style.width = w + 'px';
    el.style.height = hh + 'px';
    if (!chartInst) chartInst = echarts.init(el, null, { renderer: 'canvas' });
    chartInst.resize({ width: w, height: hh });
    chartInst.setOption(buildOption(a, k), true);
    renderResidual(a);
  }

  function renderResidual(a) {
    const card = $('#curveResidualCard');
    const el = $('#curveResidual');
    if (!card || !el) return;
    const fit = a ? validFit(a) : null;
    if (!fit) {
      card.hidden = true;
      if (residualInst) { residualInst.clear(); }
      return;
    }
    card.hidden = false;
    const c = C();
    const fs = Math.max(7, c.style.fontSize * 96 / 72 * 0.9);
    const lw = Math.max(0.8, c.style.lineWidth);
    const w = el.parentElement ? el.parentElement.clientWidth - 20 : 600;
    el.style.width = Math.max(320, w) + 'px';
    el.style.height = '150px';
    if (!residualInst) residualInst = echarts.init(el, null, { renderer: 'canvas' });
    residualInst.resize({ width: Math.max(320, w), height: 150 });
    residualInst.setOption({
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: c.style.fontFamily },
      grid: { left: 54, right: 18, top: 12, bottom: 30, containLabel: true },
      xAxis: {
        type: a.xType === 'date' ? 'time' : 'value',
        axisLine: { lineStyle: { color: '#222', width: lw } },
        axisTick: { show: true, inside: true, lineStyle: { color: '#222', width: lw } },
        axisLabel: { color: '#222', fontSize: fs, fontFamily: c.style.fontFamily },
        splitLine: { show: false },
        scale: true,
      },
      yAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: '#222', width: lw } },
        axisTick: { show: true, inside: true, lineStyle: { color: '#222', width: lw } },
        axisLabel: { color: '#222', fontSize: fs, fontFamily: c.style.fontFamily },
        splitLine: { show: false },
      },
      series: [{
        type: 'line',
        data: fit.x.map((x, i) => [x, fit.residuals[i]]),
        showSymbol: true,
        symbolSize: 3,
        lineStyle: { width: lw, color: '#D55E00' },
        itemStyle: { color: '#D55E00' },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: 0 }],
          lineStyle: { type: 'dashed', color: '#888', width: 0.8 },
          label: { show: false },
        },
      }],
      tooltip: { show: false },
    }, true);
  }

  /* ==================== 表格 ==================== */
  function renderPeakTable() {
    const host = $('#curvePeakTable');
    if (!host) return;
    host.innerHTML = '';
    const a = analyze();
    if (!a) {
      host.appendChild(h('p.muted.small', { style: { padding: '12px 14px' } }, '选择数据后显示峰列表。'));
      return;
    }
    if (!C().peaks.on) {
      host.appendChild(h('p.muted.small', { style: { padding: '12px 14px' } }, '寻峰已关闭。勾选「启用寻峰」后可自动列出峰位、峰高、FWHM 与面积。'));
      return;
    }
    const rows = [];
    a.series.forEach((s) => s.peaks.forEach((p, i) => {
      rows.push([s.name, i + 1, p.x, p.y, p.prominence, p.fwhm, p.area]);
    }));
    if (!rows.length) {
      host.appendChild(h('p.muted.small', { style: { padding: '12px 14px' } }, '当前阈值下没有检出峰。可降低「相对峰高」或「显著度」。'));
      return;
    }
    const table = h('table');
    table.appendChild(h('thead', h('tr', ['曲线', '序号', '峰位', '峰高', '显著度', 'FWHM', '面积'].map((t, i) => h('th' + (i > 1 ? '.num' : ''), t)))));
    const tb = h('tbody');
    rows.forEach((r) => {
      tb.appendChild(h('tr',
        h('td', String(r[0])),
        h('td.num', String(r[1])),
        h('td.num', U.fmt(r[2], 4)),
        h('td.num', U.fmt(r[3], 4)),
        h('td.num', U.fmt(r[4], 3)),
        h('td.num', r[5] === null ? '—' : U.fmt(r[5], 4)),
        h('td.num', r[6] === null ? '—' : U.fmt(r[6], 4))));
    });
    table.appendChild(tb);
    host.appendChild(table);
  }

  function renderFitTable() {
    const host = $('#curveFitTable');
    const tag = $('#curveFitTag');
    if (!host) return;
    host.innerHTML = '';
    const a = analyze();
    const c = C();
    if (!a || !c.fit.model || c.fit.model === 'none') {
      if (tag) { tag.textContent = '未拟合'; tag.className = 'tag'; }
      host.appendChild(h('p.muted.small', { style: { padding: '12px 14px' } }, '在左侧选择模型并运行拟合后，这里显示参数估计、标准误与置信区间。'));
      return;
    }
    const cur = currentFit(a);
    if (!cur) {
      if (tag) { tag.textContent = c.fit.result && c.fit.result.ok ? '结果已失效' : '待运行'; tag.className = 'tag'; }
      host.appendChild(h('p.muted.small', { style: { padding: '12px 14px' } },
        c.fit.result && c.fit.result.ok ? '数据或参数已改变，请点击「运行拟合」重新计算。' : '点击「运行拟合」开始计算。'));
      return;
    }
    if (!cur.ok) {
      if (tag) { tag.textContent = '拟合失败'; tag.className = 'tag warn'; }
      host.appendChild(h('p.muted.small', { style: { padding: '12px 14px' } }, cur.message || '拟合未能收敛。'));
      return;
    }
    const fit = cur;

    if (tag) {
      tag.textContent = `R² = ${U.fmt(fit.r2, 3)}`;
      tag.className = 'tag' + (fit.r2 >= 0.9 ? ' ok' : ' warn');
    }

    const stats = [
      ['模型', fit.modelName || fit.model],
      ['目标曲线', fit.target],
      ['有效点 n', String(fit.n)],
      ['R²', U.fmt(fit.r2, 4)],
      ['调整 R²', U.fmt(fit.adjR2, 4)],
      ['RMSE', U.fmt(fit.rmse, 4)],
      ['AIC', U.fmt(fit.aic, 1)],
      ['残差自由度', String(fit.dof)],
      ['迭代次数', String(fit.iterations)],
      ['收敛', fit.converged ? '是' : '否'],
    ];
    const sg = h('div.res-grid', { style: { padding: '10px 14px 0' } });
    stats.forEach((s) => sg.appendChild(h('div.res-stat', h('div.k', s[0]), h('div.v', s[1]))));
    host.appendChild(sg);

    const table = h('table');
    table.appendChild(h('thead', h('tr', ['参数', '估计值', '标准误', '95% CI', '状态'].map((t, i) => h('th' + (i > 0 ? '.num' : ''), t)))));
    const tb = h('tbody');
    fit.paramList.forEach((p) => {
      tb.appendChild(h('tr',
        h('td', p.label),
        h('td.num', U.fmt(p.value, 5)),
        h('td.num', isFinite(p.se) ? U.fmt(p.se, 4) : '—'),
        h('td.num', isFinite(p.ciLow) ? `${U.fmt(p.ciLow, 4)} ~ ${U.fmt(p.ciHigh, 4)}` : '—'),
        h('td', p.atBound ? '停在边界' : '正常')));
    });
    table.appendChild(tb);
    host.appendChild(h('div.table-wrap', { style: { marginTop: '10px' } }, table));

    if (fit.warnings && fit.warnings.length) {
      const ul = h('ul.assume-list', { style: { padding: '0 14px 12px 30px' } });
      fit.warnings.forEach((w) => ul.appendChild(h('li', w)));
      host.appendChild(ul);
    }
  }

  function renderNote() {
    const el = $('#curveNote');
    if (!el) return;
    const a = analyze();
    if (!a) { el.textContent = ''; return; }
    const c = C();
    const n = a.series.reduce((s, x) => s + x.peaks.length, 0);
    const fit = validFit(a);
    const bits = [
      `${a.series.length} 条曲线`,
      `${a.series[0].proc.x.length} 个有效点`,
      c.peaks.on ? `检出 ${n} 个峰` : '未寻峰',
    ];
    if (c.style.showRaw) bits.push('灰线为原始曲线');
    if (c.style.showBaseline && a.series.some((s) => s.proc.baseline)) bits.push('虚线为基线');
    if (fit) bits.push(`拟合 ${fit.modelName}，R² = ${U.fmt(fit.r2, 3)}`);
    el.textContent = bits.join('　·　');
  }

  /* ==================== 总渲染 ==================== */
  function render() {
    const ds = LD.app.workDataset();
    if (!ds) return;
    const c = C();
    if (!c.x || !c.ys.length) LD.app.initCurveEncodings(true);
    renderMap();
    renderPre();
    renderPeaks();
    renderFit();
    renderStyle();
    renderChart();
    renderPeakTable();
    renderFitTable();
    renderNote();
  }

  /* ==================== 交互 ==================== */
  function readFitInit() {
    const out = {};
    document.querySelectorAll('#curveFit input[data-fit-param]').forEach((el) => {
      if (el.value === '') return;
      const v = Number(el.value);
      if (isFinite(v)) out[el.dataset.fitParam] = v;
    });
    return Object.keys(out).length ? out : null;
  }

  function onChange(e) {
    const el = e.target;
    const c = C();
    if (el.dataset.style) {
      const v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value);
      setPath(c.style, el.dataset.style, v);
      renderChart();
      renderNote();
      return;
    }
    if (el.dataset.curve === 'x') {
      c.x = el.value || null;
      // 换了横轴，旧的裁剪范围不再有意义，避免把整条曲线裁没
      c.pre.crop = { on: false, lo: null, hi: null };
      c.ys = (c.ys || []).filter((n) => n !== c.x);
      if (!c.ys.length) {
        const y = bestY(c);
        if (y) c.ys = [y];
      }
      if (c.fit.target && !c.ys.includes(c.fit.target)) c.fit.target = c.ys[0] || null;
      render();
      return;
    }
    if (el.dataset.curve === 'ys') {
      c.ys = Array.from(el.selectedOptions).map((o) => o.value).filter((n) => n !== c.x);
      if (!c.ys.length) {
        const y = bestY(c);
        if (y) c.ys = [y];
      }
      if (c.fit.target && !c.ys.includes(c.fit.target)) c.fit.target = c.ys[0] || null;
      render();
      return;
    }
    if (el.dataset.pre) {
      const v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value);
      setPath(c.pre, el.dataset.pre, v);
      if (el.dataset.pre === 'crop.on' && el.checked) {
        const [lo, hi] = xRange();
        if (c.pre.crop.lo === null || c.pre.crop.lo === undefined) c.pre.crop.lo = lo;
        if (c.pre.crop.hi === null || c.pre.crop.hi === undefined) c.pre.crop.hi = hi;
      }
      if (el.dataset.pre === 'deriv') c.pre.deriv = Number(el.value);
      render();
      return;
    }
    if (el.dataset.peak) {
      const v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value);
      setPath(c.peaks, el.dataset.peak, v);
      render();
      return;
    }
    if (el.dataset.fit === 'model') {
      c.fit.model = el.value;
      c.fit.init = null;
      c.fit.result = null;
      render();
      return;
    }
    if (el.dataset.fit === 'target') {
      c.fit.target = el.value;
      c.fit.init = null;
      c.fit.result = null;
      render();
    }
  }

  function onInput(e) {
    const el = e.target;
    const c = C();
    if (el.dataset.style) {
      const v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value);
      setPath(c.style, el.dataset.style, v);
      renderChart();
      return;
    }
    if (el.dataset.pre) {
      setPath(c.pre, el.dataset.pre, el.value === '' ? null : Number(el.value));
      renderChart();
      renderPeakTable();
      renderFitTable();
      renderNote();
      return;
    }
    if (el.dataset.peak) {
      setPath(c.peaks, el.dataset.peak, el.value === '' ? 0 : Number(el.value));
      renderChart();
      renderPeakTable();
      renderNote();
      return;
    }
    if (el.dataset.fitParam) {
      c.fit.init = readFitInit();
      renderFitTable();
    }
  }

  function runFit() {
    const a = analyze();
    if (!a) return;
    const c = C();
    const target = a.series.find((s) => s.name === (c.fit.target || a.series[0].name)) || a.series[0];
    c.fit.target = target.name;
    const init = readFitInit();
    c.fit.init = init;
    const r = LD.curve.fit(target.proc.x, target.proc.y, c.fit.model, { init });
    r._sig = fitSig(a);
    r.target = target.name;
    c.fit.result = r;
    renderChart();
    renderFitTable();
    renderNote();
    if (!r.ok) U.toast(r.message || '拟合失败', 'warn', 5000);
  }

  function resetPre() {
    C().pre = LD.app.defaultCurveState().pre;
    C().fit.result = null;
    render();
    U.toast('预处理参数已复位', 'ok');
  }

  function resetStyle() {
    C().style = Object.assign({}, LD.app.defaultCurveState().style);
    render();
    U.toast('出图样式已复位', 'ok');
  }

  function peakRows() {
    const a = analyze();
    if (!a) return [];
    const rows = [];
    a.series.forEach((s) => s.peaks.forEach((p, i) => {
      rows.push([s.name, i + 1, p.x, p.y, p.prominence, p.fwhm, p.area]);
    }));
    return rows;
  }

  function copyPeaks() {
    const rows = peakRows();
    if (!rows.length) { U.toast('当前没有可复制的峰', 'warn'); return; }
    const text = [['曲线', '序号', '峰位', '峰高', '显著度', 'FWHM', '面积'].join('\t')]
      .concat(rows.map((r) => r.map((v) => (v === null ? '' : String(v))).join('\t'))).join('\n');
    U.copyText(text).then(() => U.toast(`已复制 ${rows.length} 个峰`, 'ok'));
  }

  function exportPeaksCsv() {
    const rows = peakRows();
    if (!rows.length) { U.toast('当前没有可导出的峰', 'warn'); return; }
    const esc = (s) => (/[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
    const csv = [['曲线', '序号', '峰位', '峰高', '显著度', 'FWHM', '面积'].join(',')]
      .concat(rows.map((r) => r.map(esc).join(','))).join('\r\n');
    U.download('peaks-' + sanitizeName(LD.app.workDataset().name) + '.csv', '﻿' + csv, 'text/csv;charset=utf-8');
  }

  function offscreenOption(a) {
    return buildOption(a, 1);
  }

  function exportPNG() {
    const a = analyze();
    if (!a) { U.toast('没有可导出的曲线', 'warn'); return; }
    const opt = offscreenOption(a);
    const { w, h: hh } = sizeOf(1);
    const holder = document.createElement('div');
    holder.style.cssText = `position:absolute;left:-99999px;top:0;width:${w}px;height:${hh}px;`;
    document.body.appendChild(holder);
    const inst = echarts.init(holder, null, { renderer: 'canvas', width: w, height: hh, devicePixelRatio: 1 });
    inst.setOption(opt, true);
    const url = inst.getDataURL({ type: 'png', pixelRatio: 600 / 96, backgroundColor: '#fff' });
    inst.dispose();
    holder.remove();
    const arr = url.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    const u8 = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
    U.download('curve-' + sanitizeName(LD.app.workDataset().name) + '.png', new Blob([u8], { type: mime }), 'image/png');
    U.toast('已导出 600 dpi PNG（物理尺寸 ' + C().style.widthMM + ' mm）', 'ok');
  }

  function buildSVG() {
    const a = analyze();
    if (!a) return null;
    const opt = offscreenOption(a);
    const { w, h: hh } = sizeOf(1);
    const holder = document.createElement('div');
    holder.style.cssText = `position:absolute;left:-99999px;top:0;width:${w}px;height:${hh}px;`;
    document.body.appendChild(holder);
    const inst = echarts.init(holder, null, { renderer: 'svg', width: w, height: hh });
    inst.setOption(opt, true);
    let text = '';
    try {
      if (typeof inst.renderToSVGString === 'function') text = inst.renderToSVGString();
    } catch (e) { text = ''; }
    inst.dispose();
    holder.remove();
    if (!text) return null;
    try {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const el = doc.documentElement;
      el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!el.getAttribute('viewBox')) el.setAttribute('viewBox', `0 0 ${w} ${hh}`);
      el.setAttribute('width', C().style.widthMM + 'mm');
      el.setAttribute('height', C().style.heightMM + 'mm');
      text = new XMLSerializer().serializeToString(el);
    } catch (e) { /* 保底 */ }
    return text;
  }

  function exportSVG() {
    const text = buildSVG();
    if (!text) { U.toast('SVG 生成失败', 'err'); return; }
    U.download('curve-' + sanitizeName(LD.app.workDataset().name) + '.svg', text, 'image/svg+xml;charset=utf-8');
    U.toast('已导出矢量 SVG', 'ok');
  }

  /** 按真实物理尺寸打开打印窗口；在打印对话框里选「存储为 PDF」即得矢量 PDF */
  function printPDF() {
    const text = buildSVG();
    if (!text) { U.toast('PDF 生成失败', 'err'); return; }
    const s = C().style;
    const win = window.open('', '_blank');
    if (!win) { U.toast('浏览器拦截了弹窗，请允许后重试', 'warn'); return; }
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Figure</title>
<style>
@page { size: ${s.widthMM}mm ${s.heightMM}mm; margin: 0; }
html,body{margin:0;padding:0;}
svg{display:block;width:${s.widthMM}mm;height:${s.heightMM}mm;}
</style></head><body>${text}
<script>window.onload=function(){setTimeout(function(){window.print();},180);};<\/script>
</body></html>`);
    win.document.close();
    U.toast('已打开打印窗口，选择「存储为 PDF」即可得到矢量图', 'ok', 5000);
  }

  /** 导出处理后的曲线数据（x + 各条 Y 的预处理结果） */
  function exportCurveCsv() {
    const a = analyze();
    if (!a || !a.series.length) { U.toast('没有可导出的曲线', 'warn'); return; }
    const n = Math.min.apply(null, a.series.map((s) => s.proc.x.length));
    const header = [a.x].concat(a.series.map((s) => s.name + '_处理后'));
    const esc = (v) => {
      const str = v === null || v === undefined || !isFinite(v) ? '' : String(+Number(v).toPrecision(10));
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = [header.map(esc).join(',')];
    for (let i = 0; i < n; i++) {
      lines.push([a.series[0].proc.x[i]].concat(a.series.map((s) => s.proc.y[i])).map(esc).join(','));
    }
    U.download('curve-' + sanitizeName(LD.app.workDataset().name) + '.csv',
      '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    U.toast(`已导出 ${n} 行处理后曲线数据`, 'ok');
  }

  function showCode() {
    const a = analyze();
    if (!a) { U.toast('没有可生成的代码', 'warn'); return; }
    if (!LD.codegen || !LD.codegen.curveCode) { U.toast('代码生成器未加载', 'err'); return; }
    const code = LD.codegen.curveCode({ analysis: a, curve: C(), fit: validFit(a) });
    const pre = h('pre.code-block', { style: { maxHeight: '420px' } }, code.python);
    const body = h('div',
      h('div.tabs', { style: { marginBottom: '8px' } },
        h('button.tab.active', { 'data-code-lang': 'py' }, 'Python'),
        h('button.tab', { 'data-code-lang': 'r' }, 'R')),
      pre);
    body.addEventListener('click', (e) => {
      const t = e.target.closest('[data-code-lang]');
      if (!t) return;
      body.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === t));
      pre.textContent = t.dataset.codeLang === 'r' ? code.r : code.python;
    });
    U.modal('曲线处理与拟合代码', body, [
      { label: '复制 Python', primary: true, onClick: () => U.copyText(code.python).then(() => U.toast('Python 代码已复制', 'ok')) },
      { label: '复制 R', onClick: () => U.copyText(code.r).then(() => U.toast('R 代码已复制', 'ok')) },
    ]);
  }

  /* ==================== 绑定 ==================== */
  function bind() {
    if (bound) return;
    const view = document.getElementById('view-curve');
    if (!view) return;
    bound = true;
    view.addEventListener('change', onChange);
    view.addEventListener('input', U.debounce(onInput, 220));
    document.getElementById('btnCurveReset').addEventListener('click', resetPre);
    document.getElementById('btnCurveStyleReset').addEventListener('click', resetStyle);
    document.getElementById('btnCurveCopyPeaks').addEventListener('click', copyPeaks);
    document.getElementById('btnCurvePeaksCsv').addEventListener('click', exportPeaksCsv);
    document.getElementById('btnCurvePng').addEventListener('click', exportPNG);
    document.getElementById('btnCurveSvg').addEventListener('click', exportSVG);
    document.getElementById('btnCurvePdf').addEventListener('click', printPDF);
    document.getElementById('btnCurveCsv').addEventListener('click', exportCurveCsv);
    document.getElementById('btnCurveCode').addEventListener('click', showCode);

    view.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t || t.disabled) return;
      if (t.dataset.act === 'curveFitRun') runFit();
      else if (t.dataset.act === 'curveFitGuess') {
        C().fit.init = null;
        C().fit.result = null;
        render();
      }
    });

    window.addEventListener('resize', U.debounce(() => {
      if (LD.app.state.view === 'curve') { renderChart(); }
    }, 180));
  }

  LD.curveUI = { render, bind, analyze, validFit, exportPNG, exportSVG, buildSVG };
})();
