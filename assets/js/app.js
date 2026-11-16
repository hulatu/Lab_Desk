/* LabDesk · 应用状态与动作 */
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;
  const S = LD.stats;

  const STORE_KEY = 'labdesk.project.v1';

  /** 曲线视图的默认状态。拟合结果不在这里存：它是派生量，渲染时重算，避免工程文件膨胀。 */
  function defaultCurveState() {
    return {
      x: null,
      ys: [],
      pre: {
        crop: { on: false, lo: null, hi: null },
        baseline: { method: 'none', degree: 4, lambda: 1e5, p: 0.01, iter: 10 },
        smooth: { method: 'sg', window: 11, order: 2 },
        deriv: 0,
        norm: 'none',
      },
      peaks: Object.assign({}, LD.curve.PEAK_DEFAULTS),
      fit: { model: 'none', target: null, init: null, result: null },
      style: {
        widthMM: 110, heightMM: 76,
        fontFamily: 'Arial', fontSize: 8,
        lineWidth: 1, symbolSize: 5,
        palette: 'okabe-ito',
        showRaw: true, showPeaks: true, showBaseline: false,
        xLabel: '', yLabel: '',
      },
    };
  }

  function mergeCurve(saved) {
    const d = defaultCurveState();
    const s = saved || {};
    const c = Object.assign(d, s);
    c.pre = Object.assign({}, d.pre, s.pre || {});
    c.pre.crop = Object.assign({}, d.pre.crop, (s.pre || {}).crop || {});
    c.pre.baseline = Object.assign({}, d.pre.baseline, (s.pre || {}).baseline || {});
    c.pre.smooth = Object.assign({}, d.pre.smooth, (s.pre || {}).smooth || {});
    c.peaks = Object.assign({}, d.peaks, s.peaks || {});
    c.fit = Object.assign({}, d.fit, s.fit || {});
    c.fit.result = null; // 拟合结果是派生量，不跨会话保存
    c.style = Object.assign({}, d.style, s.style || {});
    return c;
  }

  function curveSnapshot() {
    return Object.assign({}, state.curve, {
      fit: Object.assign({}, state.curve.fit, { result: null }),
    });
  }

  const state = {
    datasets: [],        // [{id, ds, pipeline:[]}]
    activeId: null,
    view: 'empty',
    chart: {
      type: 'bar',
      enc: { x: null, y: null, series: null, size: null, multi: [], agg: 'mean', method: 'pearson' },
      style: Object.assign({}, LD.charts.STYLE_DEFAULTS),
    },
    curve: defaultCurveState(),
    annot: { mode: 'none', test: 'auto', adj: 'holm', alpha: 0.05, sourceId: null, scope: 'sig' },
    descRows: [],
    descGroup: '',        // 描述统计的分组变量（空 = 不分组）
    lastTest: null,
    results: [],          // 最近的分析结果；不只保留最后一次
    interpretation: '',
    ocr: { image: null, table: null, notes: '' },
    reportHtml: '',
  };

  /* ---------- 派生数据 ---------- */
  function activeEntry() {
    return state.datasets.find((d) => d.id === state.activeId) || null;
  }
  function rawDataset() {
    const e = activeEntry();
    return e ? e.ds : null;
  }
  function pipeline() {
    const e = activeEntry();
    return e ? e.pipeline : [];
  }

  /* 派生数据缓存：一次渲染里 workDataset() 会被调用十几次，
     每次都重跑整条流水线在几万行数据上会明显卡顿。 */
  let wsCache = { key: '', val: null };
  function pipelineKey() {
    const e = activeEntry();
    if (!e) return '';
    const p = e.pipeline;
    return e.id + '|' + p.length + '|' + (p.length ? p[p.length - 1].id : '');
  }
  function workDataset() {
    const raw = rawDataset();
    if (!raw) return null;
    const key = pipelineKey();
    if (wsCache.key === key) return wsCache.val;
    const res = LD.ops.apply(raw, pipeline());
    wsCache = { key, val: res.dataset };
    return res.dataset;
  }
  /** 直接改动了原始数据（如单元格编辑、重新推断类型）后必须调用 */
  function invalidateWork() { wsCache = { key: '', val: null }; }

  function numNames(ds) {
    return ds ? ds.columns.filter((c) => c.type === 'number').map((c) => c.name) : [];
  }
  function catNames(ds) {
    return ds ? ds.columns.filter((c) => c.type !== 'number' && c.type !== 'empty').map((c) => c.name) : [];
  }

  /* ---------- 动作 ---------- */
  function addDataset(ds, opts) {
    const o = opts || {};
    const entry = { id: ds.id, ds, pipeline: [] };
    invalidateWork();
    state.datasets.push(entry);
    state.activeId = ds.id;
    state.descRows = [];
    state.lastTest = null;
    state.interpretation = '';
    state.curve.fit.result = null;
    initChartEncodings();
    initCurveEncodings();
    recomputeDesc();
    if (!o.silent) {
      U.toast(`已载入「${ds.name}」：${ds.rows.length} 行 × ${ds.columns.length} 列`, 'ok');
      go('table');
    }
    persist();
    return entry;
  }

  function removeDataset(id) {
    state.datasets = state.datasets.filter((d) => d.id !== id);
    if (state.activeId === id) state.activeId = state.datasets.length ? state.datasets[0].id : null;
    recomputeDesc();
    persist();
  }

  function setActive(id) {
    state.activeId = id;
    state.descRows = [];
    state.interpretation = '';
    state.curve.fit.result = null;
    state.lastTest = visibleResults()[0] || null;
    recomputeDesc();
    initChartEncodings();
    initCurveEncodings();
    persist();
  }

  const VIEWS = ['import', 'table', 'clean', 'curve', 'stats', 'chart', 'report'];
  function go(view) {
    // 视图名写错时不要把页面清空，回退到一个有效视图
    if (VIEWS.indexOf(view) < 0) view = rawDataset() ? 'table' : 'import';
    if (!rawDataset() && view !== 'import') view = 'empty';
    state.view = view;
    LD.ui.renderAll();
  }

  function pushOp(type, params) {
    const e = activeEntry();
    if (!e) return;
    e.pipeline.push({ type, params, id: U.uid(), at: Date.now() });
    afterPipelineChange();
  }

  /** 一次性追加多条整理操作，只在最后重算/重绘一次（批量修复用） */
  function pushOps(list) {
    const e = activeEntry();
    if (!e || !list || !list.length) return 0;
    list.forEach((o) => {
      const type = o.type || o.op;
      if (!type) return;
      e.pipeline.push({ type, params: o.params || {}, id: U.uid(), at: Date.now() });
    });
    afterPipelineChange();
    return list.length;
  }

  function undo() {
    const e = activeEntry();
    if (!e || !e.pipeline.length) { U.toast('没有可撤销的操作', 'warn'); return; }
    const last = e.pipeline.pop();
    afterPipelineChange();
    U.toast('已撤销：' + LD.ops.summarize(last));
  }

  function removeOp(index) {
    const e = activeEntry();
    if (!e) return;
    e.pipeline.splice(index, 1);
    afterPipelineChange();
  }

  function clearPipeline() {
    const e = activeEntry();
    if (!e) return;
    e.pipeline = [];
    afterPipelineChange();
  }

  function afterPipelineChange() {
    state.interpretation = '';
    state.curve.fit.result = null;
    invalidateWork();
    // 整理步骤变了，之前的结果就不再对应当前数据：从结果工作台隐藏，也不能再作为标注来源
    const vis = visibleResults();
    state.lastTest = vis[0] || null;
    if (state.annot.sourceId && !vis.some((r) => r.id === state.annot.sourceId)) state.annot.sourceId = null;
    recomputeDesc();
    initChartEncodings(true);
    initCurveEncodings(true);
    persist();
    LD.ui.renderAll();
  }

  function recomputeDesc() {
    const ds = workDataset();
    if (!ds) { state.descRows = []; return; }
    state.descRows = ds.columns
      .map((c, i) => {
        if (c.type !== 'number') return null;
        const vals = ds.rows.map((r) => r[i]);
        const d = S.describe(vals);
        return Object.assign({ name: c.name }, d);
      })
      .filter(Boolean);
  }

  /* ---------- 图表编码默认值 ---------- */
  function initChartEncodings(keepExisting) {
    const ds = workDataset();
    if (!ds) return;
    const nums = numNames(ds), cats = catNames(ds);
    const groupCols = LD.charts.groupCandidates(ds);
    const enc = state.chart.enc;
    const valid = (n) => n && ds.columns.some((c) => c.name === n);
    // 响应变量默认取「取值最丰富的数值列」——实验设计变量通常只有少数几个水平
    const richness = (name) => {
      const i = ds.columns.findIndex((c) => c.name === name);
      return new Set(ds.rows.map((r) => r[i])).size;
    };
    const bestY = nums.slice().sort((a, b) => richness(b) - richness(a))[0] || null;
    if (!keepExisting || !valid(enc.y)) enc.y = bestY;
    if (!keepExisting || !valid(enc.x)) {
      // 分组轴优先落在「每个取值有多个观测」的列上：样品编号这类逐行唯一的列
      // 分完组每组只剩 1 个点，箱线图退化成一根横线、柱状图全是单点。
      // 没有可用分组列时再退回另一个数值列（x 与 y 同列只会画出 y = x 的直线）。
      enc.x = groupCols[0] || nums.find((n) => n !== enc.y) || nums[0] || null;
    }
    // 分组默认不启用，避免把重复编号当成比较对象
    if (!keepExisting) enc.series = null;
    else if (enc.series && !valid(enc.series)) enc.series = null;
    // 气泡大小要与纵轴不同列，否则气泡大小就是纵轴本身，没有第三维信息
    if (!keepExisting || !valid(enc.size)) enc.size = nums.find((n) => n !== enc.y) || nums[0] || null;
    const multi = (enc.multi || []).filter((n) => valid(n));
    enc.multi = multi.length >= 2 ? multi : nums.slice(0, Math.min(6, nums.length));
    // 若当前图表类型不再可用，回退到第一个可用类型
    const cur = LD.charts.typeByKey(state.chart.type);
    if (!LD.charts.eligibility(cur, ds).ok) {
      const fallback = LD.charts.TYPES.find((t) => LD.charts.eligibility(t, ds).ok);
      if (fallback) state.chart.type = fallback.key;
    }
    ensureEncodings();
  }

  /** 切换图表类型后，把不再合法的编码列替换为该类型允许的列 */
  function ensureEncodings() {
    const ds = workDataset();
    if (!ds) return;
    const type = LD.charts.typeByKey(state.chart.type);
    const nums = numNames(ds);
    const cats = catNames(ds);
    // 分组轴候选：分类列 + 水平数不多的数值列，且按「每个取值的观测数」排好序
    const groupCols = LD.charts.groupCandidates(ds);
    const all = ds.columns.map((c) => c.name);
    const enc = state.chart.enc;
    // 数值列按「取值丰富度」排序：直方图/散点图的横轴应优先落在真正的响应变量上，
    // 而不是只有两三个水平的实验设计变量（温度、批次之类）。
    const rich = (name) => {
      const i = ds.columns.findIndex((c) => c.name === name);
      return i < 0 ? 0 : new Set(ds.rows.map((r) => r[i])).size;
    };
    const numsRich = nums.slice().sort((a, b) => rich(b) - rich(a));
    (type.fields || []).forEach((f) => {
      if (f.kind === 'multinum') {
        const keep = (enc.multi || []).filter((n) => nums.includes(n));
        enc.multi = keep.length >= 2 ? keep : numsRich.slice(0, Math.min(6, numsRich.length));
        return;
      }
      const list = f.kind === 'num' ? numsRich : (f.kind === 'cat' ? groupCols : all);
      if (f.optional) {
        if (enc[f.k] && !list.includes(enc[f.k])) enc[f.k] = null;
      } else if (!list.includes(enc[f.k])) {
        // 新列要避开其它编码已占用的列：横轴与纵轴同列只会画出 y = x 的直线，
        // 堆叠分组与横轴同列则每组只有一根柱子，堆叠完全失去意义。
        const taken = new Set(Object.keys(enc).filter((k) => k !== f.k).map((k) => enc[k]).filter(Boolean));
        enc[f.k] = list.find((n) => !taken.has(n)) || list.find((n) => n !== enc.y) || list[0] || null;
      }
    });
  }

  /* ---------- 曲线映射默认值 ---------- */
  /**
   * 曲线视图默认把「唯一取值最多、且近似单调」的数值列当横轴。
   * 谱图的波长/时间轴每行都不同；分组列（处理、批次）只有几个取值，
   * 自动选错会让默认图变成一条来回折返的线。
   */
  function initCurveEncodings(keepExisting) {
    const ds = workDataset();
    if (!ds) return;
    const c = state.curve;
    const valid = (n) => n && ds.columns.some((col) => col.name === n);
    const numeric = ds.columns
      .map((col, i) => ({ col, i }))
      .filter((o) => o.col.type === 'number' || o.col.type === 'date');
    const uniqRatio = (i) => new Set(ds.rows.map((r) => r[i])).size / Math.max(1, ds.rows.length);
    // 横轴通常单调递增（时间、波长、2θ）。先按单调性筛一遍，
    // 避免把「产率」这种每行都不同但来回波动的测量列误当成横轴。
    const mono = (i) => {
      let up = 0, down = 0;
      for (let k = 1; k < ds.rows.length; k++) {
        const a = ds.rows[k - 1][i], b = ds.rows[k][i];
        if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b)) {
          if (b > a) up++; else if (b < a) down++;
        }
      }
      const n = up + down;
      return n >= 3 ? Math.max(up, down) / n : 0;
    };
    const sorted = numeric.slice().sort((a, b) => {
      const ma = mono(a.i) >= 0.95 ? 1 : 0;
      const mb = mono(b.i) >= 0.95 ? 1 : 0;
      return (mb - ma) || (uniqRatio(b.i) - uniqRatio(a.i));
    });
    const bestX = sorted.find((o) => uniqRatio(o.i) >= 0.8) || numeric[0] || null;

    if (!keepExisting || !valid(c.x)) c.x = bestX ? bestX.col.name : null;
    // Y 默认落在取值最丰富的数值列上：温度、批次这类设计变量只有两三个水平，
    // 把它们当默认响应变量画出来几乎是一条平线。
    const nums = ds.columns
      .map((col, i) => ({ col, i }))
      .filter((o) => o.col.type === 'number' && o.col.name !== c.x)
      .sort((a, b) => uniqRatio(b.i) - uniqRatio(a.i))
      .map((o) => o.col.name);
    if (!keepExisting || !c.ys.length) c.ys = nums.length ? [nums[0]] : [];
    else c.ys = c.ys.filter((n) => valid(n) && n !== c.x);
    if (!c.ys.length && nums.length) c.ys = [nums[0]];
    if (!c.fit.target || !c.ys.includes(c.fit.target)) c.fit.target = c.ys[0] || null;
    if (c.fit.model !== 'none' && (!c.ys.length || !c.x)) {
      c.fit.model = 'none';
      c.fit.result = null;
    }
  }

  /**
   * 计算当前曲线视图的派生结果：每条 Y 列的预处理曲线与峰列表。
   * 非线性拟合由曲线界面在点击「运行拟合」时单独执行，避免每次渲染都重算。
   */
  function curveAnalysis() {
    const ds = workDataset();
    const c = state.curve;
    if (!ds || !c.x || !c.ys || !c.ys.length) return null;
    const xi = ds.columns.findIndex((col) => col.name === c.x);
    if (xi < 0) return null;
    const xType = ds.columns[xi].type;
    // 日期列转成时间戳，ECharts 的 time 轴与积分/拟合都能直接用
    const x = ds.rows.map((r) => {
      const v = r[xi];
      return xType === 'date' ? Date.parse(v) : v;
    });
    const series = c.ys.map((name) => {
      const yi = ds.columns.findIndex((col) => col.name === name);
      if (yi < 0) return null;
      const y = ds.rows.map((r) => r[yi]);
      const proc = LD.curve.process(x, y, c.pre);
      const peaks = c.peaks && c.peaks.on ? LD.curve.findPeaks(proc.x, proc.y, c.peaks) : [];
      return { name, proc, peaks };
    }).filter(Boolean);
    if (!series.length) return null;
    return { x: c.x, xType, series };
  }

  /* ---------- 统计检验 ---------- */
  const FAMILIES = [
    { key: 'normality', name: '正态性检验（单变量）', y: 'num' },
    { key: 'ttest1', name: '单样本 t 检验', y: 'num', extra: [{ k: 'mu0', label: '检验值 μ₀', type: 'number', def: 0 }] },
    { key: 'ttest2', name: '独立样本 t 检验（两组）', y: 'num', g: 'cat' },
    { key: 'ttestp', name: '配对样本 t 检验', y: 'num', x: 'num' },
    { key: 'mw', name: 'Mann–Whitney U 检验（两组）', y: 'num', g: 'cat' },
    { key: 'wilcox', name: 'Wilcoxon 符号秩检验（配对）', y: 'num', x: 'num' },
    { key: 'anova', name: '单因素方差分析（多组）', y: 'num', g: 'cat' },
    { key: 'kruskal', name: 'Kruskal–Wallis 检验（多组）', y: 'num', g: 'cat' },
    { key: 'corr', name: '相关性分析（Pearson / Spearman）', y: 'num', x: 'num' },
    { key: 'reg', name: '线性回归（OLS）', y: 'num', xs: 'num' },
    { key: 'chisq', name: '卡方独立性检验', y: 'cat', x: 'cat' },
  ];

  /** 上一次检验失败的原因，供界面直接展示，避免只显示「无法完成」这种含糊提示 */
  let lastFail = '';

  function runTest(familyKey, params) {
    const ds = workDataset();
    lastFail = '';
    if (!ds) { lastFail = '请先载入数据。'; return null; }
    const fam = FAMILIES.find((f) => f.key === familyKey);
    if (!fam) { lastFail = '未知的检验类型。'; return null; }
    params = params || {};
    const col = (n) => {
      const i = ds.columns.findIndex((c) => c.name === n);
      return i < 0 ? [] : ds.rows.map((r) => r[i]);
    };
    const alpha = Number(params.alpha) || 0.05;
    const yv = params.y ? col(params.y) : [];
    const xv = params.x ? col(params.x) : [];
    const gv = params.g ? col(params.g) : [];
    let render = null;

    const pnote = (arr, label) => {
      const r = S.shapiroWilk(arr.filter(S.num));
      if (!r) return `${label}：样本量不足，无法检验正态性`;
      return `${label}：Shapiro–Wilk W = ${U.fmt(r.W, 3)}, p = ${U.fmtP(r.p)} → ${r.p < 0.05 ? '偏离正态' : '未见明显偏离'}`;
    };

    switch (familyKey) {
      case 'normality': {
        const nums = yv.filter(S.num);
        if (nums.length < 3) return null;
        const sw = S.shapiroWilk(nums);
        const da = S.dagostino(nums);
        const d = S.describe(nums);
        const p = (sw || da).p;
        render = {
          title: `正态性检验：${params.y}`,
          stats: [
            { k: '样本量 n', v: String(nums.length) },
            { k: 'Shapiro–Wilk W', v: sw ? U.fmt(sw.W, 4) : '—' },
            { k: 'Shapiro–Wilk p', v: sw ? U.fmtP(sw.p) : '—' },
            { k: "D'Agostino K²", v: da ? U.fmt(da.K2, 3) : '—' },
            { k: "D'Agostino p", v: da ? U.fmtP(da.p) : '—' },
            { k: '偏度', v: U.fmt(d.skew, 3) },
            { k: '峰度（超额）', v: U.fmt(d.kurt, 3) },
          ],
          notes: [
            nums.length < 8 ? '样本量小于 8，D\'Agostino 检验不适用，仅参考 Shapiro–Wilk。' : '两个检验结论一致时可信度更高；不一致时以 Shapiro–Wilk 为主。',
            '样本量很大（n > 500）时，Shapiro–Wilk 对微小偏离也会显著，应结合 Q-Q 图与偏度峰度判断。',
          ],
          conclusion: p < alpha
            ? `在 α = ${alpha} 水平下拒绝正态性假设（p = ${U.fmtP(p)}），建议使用非参数检验或先做变量变换。`
            : `在 α = ${alpha} 水平下不能拒绝正态性假设（p = ${U.fmtP(p)}），可认为数据近似服从正态分布。`,
          level: p < alpha ? 'warn' : 'ok',
          text: sw
            ? `Shapiro–Wilk 检验表明，${params.y} 的分布${sw.p < alpha ? '显著偏离' : '与'}正态分布${sw.p < alpha ? '' : '无显著差异'}（W = ${U.fmt(sw.W, 3)}, p ${sw.p < 0.001 ? '< 0.001' : '= ' + U.fmtP(sw.p)}）。`
            : '',
        };
        break;
      }
      case 'ttest1': {
        const r = S.tTestOne(yv, params.mu0 || 0);
        if (!r) { lastFail = `「${params.y}」的有效数值少于 2 个，无法做单样本 t 检验。`; return null; }
        const nrm = S.shapiroWilk(yv.filter(S.num));
        render = {
          title: `单样本 t 检验：${params.y} vs μ₀ = ${params.mu0}`,
          stats: [
            { k: 't', v: U.fmt(r.t, 3) }, { k: 'df', v: String(r.df) }, { k: 'p（双尾）', v: U.fmtP(r.p) },
            { k: '样本均值', v: U.fmt(r.mean, 4) }, { k: '标准差', v: U.fmt(r.sd, 4) },
            { k: '95% CI', v: `${U.fmt(r.ciLow, 4)} ~ ${U.fmt(r.ciHigh, 4)}` },
            { k: "Cohen's d", v: U.fmt(r.d, 3) },
          ],
          notes: [pnote(yv, '正态性'), `效应量 d = ${U.fmt(r.d, 2)}，属于${S.effectLabel(r.d)}效应。`],
          conclusion: r.p < alpha
            ? `样本均值 ${U.fmt(r.mean, 4)} 与 μ₀ = ${params.mu0} 的差异具有统计学意义（p = ${U.fmtP(r.p)}）。`
            : `未发现样本均值与 μ₀ = ${params.mu0} 存在统计学差异（p = ${U.fmtP(r.p)}）。`,
          level: r.p < alpha ? 'ok' : 'warn',
          text: `单样本 t 检验显示，${params.y} 的均值（M = ${U.fmt(r.mean, 3)}, SD = ${U.fmt(r.sd, 3)}）与 ${params.mu0} 相比${r.p < alpha ? '差异显著' : '差异不显著'}，t(${r.df}) = ${U.fmt(r.t, 2)}, p ${r.p < 0.001 ? '< .001' : '= ' + U.fmtP(r.p).replace(/^0/, '')}, d = ${U.fmt(r.d, 2)}。`,
        };
        break;
      }
      case 'ttest2':
      case 'mw': {
        const groups = S.groupBy(gv, yv);
        const labels = Array.from(groups.keys());
        if (labels.length < 2) {
          render = { title: '无法进行两组比较', stats: [], notes: [`「${params.g}」只有一个取值「${labels[0] || '空'}」，无法分组。`], conclusion: '', level: 'bad', text: '' };
          break;
        }
        const a = groups.get(params.groupA || labels[0]);
        const b = groups.get(params.groupB || labels[1]);
        if (!a || !b) { render = { title: '分组选择有误', stats: [], notes: [], conclusion: '', level: 'bad', text: '' }; break; }
        const lev = S.levene([a, b]);
        if (familyKey === 'mw') {
          const r = S.mannWhitney(a, b);
          if (!r) { lastFail = '两组各自至少需要 2 个有效观测才能做 Mann–Whitney 检验。'; return null; }
          render = {
            title: `Mann–Whitney U：${params.y}（${params.groupA || labels[0]} vs ${params.groupB || labels[1]}）`,
            stats: [
              { k: 'U', v: U.fmt(r.U, 1) }, { k: 'Z', v: U.fmt(r.z, 3) }, { k: 'p（双尾）', v: U.fmtP(r.p) },
              { k: `n（${params.groupA || labels[0]}）`, v: String(r.n1) },
              { k: `n（${params.groupB || labels[1]}）`, v: String(r.n2) },
              { k: '中位数 A', v: U.fmt(r.median1, 4) }, { k: '中位数 B', v: U.fmt(r.median2, 4) },
              { k: '效应量 r', v: U.fmt(r.r, 3) },
              { k: '检验方式', v: r.exact ? '精确检验' : '正态近似' },
            ],
            notes: [
              pnote(a, `组 ${params.groupA || labels[0]} 正态性`),
              pnote(b, `组 ${params.groupB || labels[1]} 正态性`),
              r.exact ? '样本量较小且无并列秩，已使用精确检验（不依赖正态近似）。' : '秩和检验不要求正态分布，但对组间方差差异敏感。',
            ],
            conclusion: r.p < alpha
              ? `两组的秩分布差异具有统计学意义（p = ${U.fmtP(r.p)}），${r.median1 > r.median2 ? params.groupA || labels[0] : params.groupB || labels[1]} 组的中位数更高。`
              : `未发现两组秩分布存在统计学差异（p = ${U.fmtP(r.p)}）。`,
            level: r.p < alpha ? 'ok' : 'warn',
            text: `Mann–Whitney U 检验显示，${params.groupA || labels[0]} 组（Mdn = ${U.fmt(r.median1, 3)}）与 ${params.groupB || labels[1]} 组（Mdn = ${U.fmt(r.median2, 3)}）差异${r.p < alpha ? '显著' : '不显著'}，U = ${U.fmt(r.U, 1)}, p ${r.p < 0.001 ? '< .001' : '= ' + U.fmtP(r.p).replace(/^0/, '')}, r = ${U.fmt(r.r, 2)}。`,
            pairs: [{
              a: params.groupA || labels[0], b: params.groupB || labels[1],
              diff: r.median1 - r.median2, stat: r.U, statName: 'U',
              p: r.p, pAdj: r.p,
            }],
            spec: { family: familyKey, y: params.y, g: params.g, alpha, adjust: 'none', method: 'mw' },
          };
          break;
        }
        const welch = lev ? lev.p < 0.05 : true;
        const r = S.tTestTwo(a, b, welch);
        if (!r) { lastFail = '两组各自至少需要 2 个有效观测才能做独立样本 t 检验。'; return null; }
        render = {
          title: `独立样本 t 检验：${params.y}（${params.groupA || labels[0]} vs ${params.groupB || labels[1]}）`,
          stats: [
            { k: 't', v: U.fmt(r.t, 3) }, { k: 'df', v: U.fmt(r.df, 1) }, { k: 'p（双尾）', v: U.fmtP(r.p) },
            { k: '均值差', v: U.fmt(r.diff, 4) },
            { k: '95% CI（差值）', v: `${U.fmt(r.ciLow, 4)} ~ ${U.fmt(r.ciHigh, 4)}` },
            { k: `M ± SD（${params.groupA || labels[0]}）`, v: `${U.fmt(r.m1, 3)} ± ${U.fmt(r.sd1, 3)}` },
            { k: `M ± SD（${params.groupB || labels[1]}）`, v: `${U.fmt(r.m2, 3)} ± ${U.fmt(r.sd2, 3)}` },
            { k: "Cohen's d", v: U.fmt(r.d, 3) },
            { k: "Hedges' g", v: U.fmt(r.g, 3) },
            { k: 'Levene 方差齐性 p', v: lev ? U.fmtP(lev.p) : '—' },
          ],
          notes: [
            pnote(a, `组 ${params.groupA || labels[0]} 正态性`),
            pnote(b, `组 ${params.groupB || labels[1]} 正态性`),
            lev ? (lev.p < 0.05 ? 'Levene 检验显示方差不齐，已自动改用 Welch 校正（不假设方差相等）。' : 'Levene 检验显示方差齐，采用合并方差 t 检验。') : '样本量不足，无法做方差齐性检验，默认使用 Welch 校正。',
          ],
          conclusion: r.p < alpha
            ? `两组均值差异具有统计学意义（p = ${U.fmtP(r.p)}），${r.diff > 0 ? params.groupA || labels[0] : params.groupB || labels[1]} 组更高，效应量 d = ${U.fmt(r.d, 2)}（${S.effectLabel(r.d)}）。`
            : `两组均值差异未达统计学显著（p = ${U.fmtP(r.p)}）。`,
          level: r.p < alpha ? 'ok' : 'warn',
          text: `${welch ? 'Welch 校正' : '独立样本'} t 检验显示，${params.groupA || labels[0]} 组（M = ${U.fmt(r.m1, 3)}, SD = ${U.fmt(r.sd1, 3)}）与 ${params.groupB || labels[1]} 组（M = ${U.fmt(r.m2, 3)}, SD = ${U.fmt(r.sd2, 3)}）差异${r.p < alpha ? '显著' : '不显著'}，t(${U.fmt(r.df, 1)}) = ${U.fmt(r.t, 2)}, p ${r.p < 0.001 ? '< .001' : '= ' + U.fmtP(r.p).replace(/^0/, '')}, d = ${U.fmt(r.d, 2)}。`,
          pairs: [{
            a: params.groupA || labels[0], b: params.groupB || labels[1],
            diff: r.diff, stat: r.t, statName: 't', df: r.df,
            p: r.p, pAdj: r.p,
          }],
          spec: { family: familyKey, y: params.y, g: params.g, alpha, adjust: 'none', method: welch ? 'welch' : 'pooled' },
        };
        break;
      }
      case 'ttestp':
      case 'wilcox': {
        const nPairs = Math.min(yv.length, xv.length);
        if (familyKey === 'wilcox') {
          const r = S.wilcoxon(yv, xv);
          if (!r) {
            render = { title: '无法进行符号秩检验', stats: [], notes: ['有效配对（差值不为 0）少于 5 对，建议改用符号检验或增加样本。'], conclusion: '', level: 'bad', text: '' };
            break;
          }
          render = {
            title: `Wilcoxon 符号秩检验：${params.y} vs ${params.x}`,
            stats: [{ k: 'W', v: U.fmt(r.W, 1) }, { k: 'Z', v: U.fmt(r.z, 3) }, { k: 'p（双尾）', v: U.fmtP(r.p) }, { k: '有效对数', v: String(r.n) }, { k: '效应量 r', v: U.fmt(r.r, 3) }, { k: '检验方式', v: r.exact ? '精确检验' : '正态近似' }],
            notes: [
              '零差值已被剔除，这是符号秩检验的标准做法。',
              r.exact ? '样本量较小且无并列秩，已使用精确检验。' : '样本量较大或存在并列秩，采用带连续性校正的正态近似。',
            ],
            conclusion: r.p < alpha ? `配对差值的中位数显著不为 0（p = ${U.fmtP(r.p)}）。` : `配对差值未达统计学显著（p = ${U.fmtP(r.p)}）。`,
            level: r.p < alpha ? 'ok' : 'warn',
            text: `Wilcoxon 符号秩检验显示，${params.y} 与 ${params.x} 的差异${r.p < alpha ? '显著' : '不显著'}，W = ${U.fmt(r.W, 1)}, p ${r.p < 0.001 ? '< .001' : '= ' + U.fmtP(r.p).replace(/^0/, '')}, r = ${U.fmt(r.r, 2)}。`,
          };
          break;
        }
        const r = S.tTestPaired(yv, xv);
        if (!r) { lastFail = '两列同时有效的配对少于 2 对，无法做配对 t 检验。'; return null; }
        const diffs = [];
        for (let i = 0; i < nPairs; i++) if (S.num(yv[i]) && S.num(xv[i])) diffs.push(yv[i] - xv[i]);
        render = {
          title: `配对样本 t 检验：${params.y} vs ${params.x}`,
          stats: [
            { k: 't', v: U.fmt(r.t, 3) }, { k: 'df', v: String(r.df) }, { k: 'p（双尾）', v: U.fmtP(r.p) },
            { k: '平均差值', v: U.fmt(r.meanDiff, 4) },
            { k: '95% CI（差值）', v: `${U.fmt(r.ciLow, 4)} ~ ${U.fmt(r.ciHigh, 4)}` },
            { k: '有效对数', v: String(r.n) },
            { k: "Cohen's dz", v: U.fmt(r.dz, 3) },
          ],
          notes: [pnote(diffs, '差值正态性'), '配对检验只使用两列都有效的配对；若差值严重偏离正态，应改用 Wilcoxon 符号秩检验。'],
          conclusion: r.p < alpha
            ? `两次测量的差异具有统计学意义（p = ${U.fmtP(r.p)}），平均差值为 ${U.fmt(r.meanDiff, 4)}。`
            : `两次测量的差异未达统计学显著（p = ${U.fmtP(r.p)}）。`,
          level: r.p < alpha ? 'ok' : 'warn',
          text: `配对样本 t 检验显示，${params.y} 与 ${params.x} 的差异${r.p < alpha ? '显著' : '不显著'}，t(${r.df}) = ${U.fmt(r.t, 2)}, p ${r.p < 0.001 ? '< .001' : '= ' + U.fmtP(r.p).replace(/^0/, '')}, dz = ${U.fmt(r.dz, 2)}。`,
        };
        break;
      }
      case 'anova':
      case 'kruskal': {
        const groups = S.groupBy(gv, yv);
        const labels = Array.from(groups.keys());
        const arrs = labels.map((l) => groups.get(l));
        if (labels.length < 2) {
          // params.g 可能为空（数据里根本没有可用作分组的列），此时别拼出「「」只有 0 个取值」这种空引号
          const note = params.g
            ? `「${params.g}」只有 ${labels.length} 个取值，无法分组比较。`
            : '当前数据没有可用于分组的列：请先载入带分组变量的数据，或用「数值分箱」把连续变量变成分组。';
          render = { title: '分组不足', stats: [], notes: [note], conclusion: '', level: 'bad', text: '' };
          break;
        }
        const lev = S.levene(arrs);
        const normNotes = labels.slice(0, 6).map((l) => pnote(groups.get(l), `组 ${l} 正态性`));
        if (familyKey === 'kruskal') {
          const r = S.kruskalWallis(arrs, labels);
          if (!r) {
            render = {
              title: '无法进行 Kruskal–Wallis 检验',
              stats: [],
              notes: [`有效观测只有 ${yv.filter((v) => S.num(v)).length} 个（分 ${labels.length} 组），至少需要 3 个观测。请检查分组变量是否选错。`],
              conclusion: '', level: 'bad', text: '',
            };
            break;
          }
          const pw = S.pairwise(arrs, labels, { method: 'mw', adjust: 'holm' });
          render = {
            title: `Kruskal–Wallis 检验：${params.y} ~ ${params.g}`,
            stats: [
              { k: 'H', v: U.fmt(r.H, 3) }, { k: 'df', v: String(r.df) }, { k: 'p', v: U.fmtP(r.p) },
              { k: '组数 k', v: String(r.k) }, { k: '总样本 N', v: String(r.N) },
              { k: '效应量 ε²', v: U.fmt(r.eps2, 3) },
            ],
            notes: normNotes.concat(['Kruskal–Wallis 不要求正态性；若各组分布形状差异很大，应把结论理解为「随机优势」而非中位数差异。']),
            table: {
              columns: ['比较', '中位数差', 'U', 'p（原始）', 'p（Holm）'],
              rows: pw.map((x) => [`${x.a} vs ${x.b}`, U.fmt(x.diff, 3), U.fmt(x.stat, 1), U.fmtP(x.p), U.fmtP(x.pAdj)]),
            },
            conclusion: r.p < alpha ? `至少有一组的分布与其他组不同（p = ${U.fmtP(r.p)}），见下方两两比较。` : `各组分布无统计学差异（p = ${U.fmtP(r.p)}）。`,
            level: r.p < alpha ? 'ok' : 'warn',
            text: `Kruskal–Wallis 检验显示，不同 ${params.g} 下 ${params.y} 的分布差异${r.p < alpha ? '显著' : '不显著'}，H(${r.df}) = ${U.fmt(r.H, 2)}, p ${r.p < 0.001 ? '< .001' : '= ' + U.fmtP(r.p).replace(/^0/, '')}。`,
            pairs: pw,
            spec: { family: familyKey, y: params.y, g: params.g, alpha, adjust: 'holm', method: 'mw' },
          };
          break;
        }
        const r = S.oneWayAnova(arrs, labels);
        if (!r) {
          const valid = yv.filter((v) => S.num(v)).length;
          render = {
            title: '无法进行方差分析',
            stats: [],
            notes: [`「${params.g}」分了 ${labels.length} 组，但有效观测只有 ${valid} 个，至少要有某一组包含 2 个以上观测。若这是「样品编号」这类逐行唯一的列，请换成真正的分组变量（如处理、批次）。`],
            conclusion: '', level: 'bad', text: '',
          };
          break;
        }
        // 方差齐 → 合并方差 t；方差不齐 → Welch t。之前两个分支都写成 welch，
        // 导致「方差齐」时仍用 Welch，事后比较的标题与算法也对不上。
        const method = lev && lev.p >= 0.05 ? 'pooled' : 'welch';
        const pw = S.pairwise(arrs, labels, { method, adjust: 'holm' });
        render = {
          title: `单因素方差分析：${params.y} ~ ${params.g}`,
          stats: [
            { k: 'F', v: `${U.fmt(r.F, 3)}` },
            { k: 'df', v: `${r.df1}, ${r.df2}` },
            { k: 'p', v: U.fmtP(r.p) },
            { k: 'η²', v: U.fmt(r.eta2, 3) },
            { k: 'ω²', v: U.fmt(r.omega2, 3) },
            { k: 'MS组间 / MS组内', v: `${U.fmt(r.msb, 3)} / ${U.fmt(r.msw, 3)}` },
            { k: 'Levene p', v: lev ? U.fmtP(lev.p) : '—' },
          ],
          notes: normNotes.concat([
            lev ? (lev.p < 0.05 ? 'Levene 检验显示方差不齐（p < 0.05），F 检验偏激进；下方两两比较已改用 Welch t，整体结论建议结合 Kruskal–Wallis 结果。' : 'Levene 检验显示方差齐，满足方差分析前提。') : '',
          ].filter(Boolean)),
          table: {
            columns: ['组别', 'n', '均值', '标准差', '标准误'],
            rows: r.groupStats.map((g) => [g.label, g.n, U.fmt(g.mean, 3), U.fmt(g.sd, 3), U.fmt(g.se, 3)]),
          },
          table2: {
            title: method === 'welch' ? '两两比较（Welch t + Holm 校正）' : '两两比较（合并方差 t + Holm 校正）',
            columns: ['比较', '均值差', 't', 'p（原始）', 'p（Holm）', '显著性'],
            rows: pw.map((x) => [`${x.a} vs ${x.b}`, U.fmt(x.diff, 3), U.fmt(x.stat, 2), U.fmtP(x.p), U.fmtP(x.pAdj), U.stars(x.pAdj)]),
          },
          conclusion: r.p < alpha
            ? `不同 ${params.g} 之间 ${params.y} 的差异具有统计学意义（p = ${U.fmtP(r.p)}，η² = ${U.fmt(r.eta2, 2)}，${r.eta2 > 0.14 ? '大' : r.eta2 > 0.06 ? '中等' : '小'}效应）。`
            : `不同 ${params.g} 之间未发现统计学差异（p = ${U.fmtP(r.p)}）。`,
          level: r.p < alpha ? 'ok' : 'warn',
          text: `单因素方差分析显示，不同 ${params.g} 下 ${params.y} 差异${r.p < alpha ? '显著' : '不显著'}，F(${r.df1}, ${r.df2}) = ${U.fmt(r.F, 2)}, p ${r.p < 0.001 ? '< .001' : '= ' + U.fmtP(r.p).replace(/^0/, '')}, η² = ${U.fmt(r.eta2, 2)}。`,
          pairs: pw,
          spec: { family: familyKey, y: params.y, g: params.g, alpha, adjust: 'holm', method },
        };
        break;
      }
      case 'corr': {
        const pr = S.pearson(yv, xv);
        const sp = S.spearman(yv, xv);
        if (!pr) { lastFail = '两列同时有效的观测少于 3 个，无法计算相关系数。'; return null; }
        const strength = (r) => {
          const a = Math.abs(r);
          return a < 0.1 ? '可忽略' : a < 0.3 ? '弱' : a < 0.5 ? '中等' : a < 0.7 ? '较强' : '强';
        };
        render = {
          title: `相关性分析：${params.y} 与 ${params.x}`,
          stats: [
            { k: 'Pearson r', v: U.fmt(pr.r, 4) },
            { k: 'p（双尾）', v: U.fmtP(pr.p) },
            { k: '95% CI（Fisher z）', v: (() => {
              const z = 0.5 * Math.log((1 + pr.r) / (1 - pr.r));
              const se = 1 / Math.sqrt(pr.n - 3);
              const lo = Math.tanh(z - 1.96 * se), hi = Math.tanh(z + 1.96 * se);
              return `${U.fmt(lo, 3)} ~ ${U.fmt(hi, 3)}`;
            })() },
            { k: 'Spearman ρ', v: sp ? U.fmt(sp.rho, 4) : '—' },
            { k: 'Spearman p', v: sp ? U.fmtP(sp.p) : '—' },
            { k: '有效样本 n', v: String(pr.n) },
          ],
          notes: [
            'Pearson 相关系数要求两变量近似正态且关系为线性；若关系为单调非线性，请以 Spearman ρ 为准。',
            sp && Math.abs(sp.rho - pr.r) > 0.15 ? 'Pearson 与 Spearman 差异较大，提示存在离群点或非线性关系。' : '',
          ].filter(Boolean),
          conclusion: pr.p < alpha
            ? `${params.y} 与 ${params.x} 存在${pr.r > 0 ? '正' : '负'}相关（r = ${U.fmt(pr.r, 3)}，${strength(pr.r)}强度，p = ${U.fmtP(pr.p)}）。`
            : `未发现 ${params.y} 与 ${params.x} 的线性相关（r = ${U.fmt(pr.r, 3)}，p = ${U.fmtP(pr.p)}）。`,
          level: pr.p < alpha ? 'ok' : 'warn',
          text: `${params.y} 与 ${params.x} 呈${pr.p < alpha ? (pr.r > 0 ? '显著正相关' : '显著负相关') : '不显著的'}关系，r(${pr.df}) = ${U.fmt(pr.r, 2)}, p ${pr.p < 0.001 ? '< .001' : '= ' + U.fmtP(pr.p).replace(/^0/, '')}。`,
          spec: { family: 'corr', y: params.y, x: params.x, g: null, alpha },
        };
        break;
      }
      case 'reg': {
        const xs = (params.xs || []).filter((n) => n !== params.y);
        if (!xs.length) return null;
        const fit = S.ols(yv, xs.map(col), xs);
        if (!fit) {
          render = { title: '无法拟合回归模型', stats: [], notes: ['有效样本不足或自变量存在完全共线性。'], conclusion: '', level: 'bad', text: '' };
          break;
        }
        const hiVif = fit.vif.filter((v) => v > 5).length;
        render = {
          title: `线性回归：${params.y} ~ ${xs.join(' + ')}`,
          stats: [
            { k: 'R²', v: U.fmt(fit.r2, 4) },
            { k: '调整 R²', v: U.fmt(fit.adjR2, 4) },
            { k: 'F', v: `${U.fmt(fit.F, 3)} (${fit.dfModel}, ${fit.dfErr})` },
            { k: '模型 p', v: U.fmtP(fit.pF) },
            { k: 'RMSE', v: U.fmt(fit.rmse, 4) },
            { k: '样本量 n', v: String(fit.n) },
            { k: 'Durbin–Watson', v: U.fmt(fit.durbinWatson, 3) },
          ],
          table: {
            columns: ['变量', 'B', '标准误', 't', 'p', '95% CI', '标准化 β', 'VIF'],
            rows: fit.coef.map((c, i) => [
              c.name, U.fmt(c.b, 4), U.fmt(c.se, 4), U.fmt(c.t, 2), U.fmtP(c.p),
              `${U.fmt(c.ciLow, 3)} ~ ${U.fmt(c.ciHigh, 3)}`,
              c.std === null ? '—' : U.fmt(c.std, 3),
              i === 0 ? '—' : U.fmt(fit.vif[i - 1], 2),
            ]),
          },
          notes: [
            `模型解释了 ${(fit.r2 * 100).toFixed(1)}% 的因变量变异。`,
            hiVif ? `存在 VIF > 5 的自变量，提示多重共线性，系数解释需谨慎。` : '各自变量 VIF 均小于 5，共线性不构成问题。',
            fit.n < xs.length * 10 ? `样本量（n = ${fit.n}）相对自变量个数偏少，建议至少每个自变量 10 个样本。` : '',
            fit.durbinWatson < 1.5 || fit.durbinWatson > 2.5 ? 'Durbin–Watson 偏离 2，提示残差可能存在自相关。' : '',
          ].filter(Boolean),
          conclusion: fit.pF < alpha
            ? `回归模型整体显著（F = ${U.fmt(fit.F, 2)}, p = ${U.fmtP(fit.pF)}），R² = ${U.fmt(fit.r2, 3)}。`
            : `回归模型整体不显著（p = ${U.fmtP(fit.pF)}），不宜据此做预测。`,
          level: fit.pF < alpha ? 'ok' : 'warn',
          text: `多元线性回归模型${fit.pF < alpha ? '显著' : '不显著'}，F(${fit.dfModel}, ${fit.dfErr}) = ${U.fmt(fit.F, 2)}, p ${fit.pF < 0.001 ? '< .001' : '= ' + U.fmtP(fit.pF).replace(/^0/, '')}, 调整 R² = ${U.fmt(fit.adjR2, 2)}。`,
          spec: { family: 'reg', y: params.y, xs, g: null, alpha },
        };
        break;
      }
      case 'chisq': {
        const ct = S.contingency(yv, xv);
        if (ct.rowLabels.length < 2 || ct.colLabels.length < 2) {
          render = { title: '无法构建列联表', stats: [], notes: ['两个变量都需要至少 2 个不同取值。'], conclusion: '', level: 'bad', text: '' };
          break;
        }
        const r = S.chiSquare(ct.table, ct.rowLabels, ct.colLabels);
        if (!r) {
          render = { title: '无法进行卡方检验', stats: [], notes: ['列联表总计数为 0，没有可用的观测。'], conclusion: '', level: 'bad', text: '' };
          break;
        }
        render = {
          title: `卡方独立性检验：${params.y} × ${params.x}`,
          stats: [
            { k: 'χ²', v: U.fmt(r.chi2, 3) }, { k: 'df', v: String(r.df) }, { k: 'p', v: U.fmtP(r.p) },
            { k: 'N', v: String(r.N) }, { k: "Cramér's V", v: U.fmt(r.cramersV, 3) },
            { k: '最小期望频数', v: U.fmt(r.minExp, 2) },
          ],
          table: {
            columns: [''].concat(ct.colLabels),
            rows: ct.table.map((row, i) => [ct.rowLabels[i]].concat(row.map((v) => String(v)))),
          },
          notes: [
            r.minExp < 5 ? `有 ${r.lowCount} 个单元格的期望频数小于 5，卡方近似可能不准确，建议使用 Fisher 精确检验或合并类别。` : '所有单元格期望频数均 ≥ 5，满足卡方检验前提。',
            r.df === 1 ? '2×2 列联表未做 Yates 连续性校正；样本量较小时建议以 Fisher 精确检验为准。' : '',
          ].filter(Boolean),
          conclusion: r.p < alpha
            ? `两个分类变量不独立（p = ${U.fmtP(r.p)}），存在关联，关联强度 Cramér's V = ${U.fmt(r.cramersV, 2)}。`
            : `未发现两个分类变量之间存在关联（p = ${U.fmtP(r.p)}）。`,
          level: r.p < alpha ? 'ok' : 'warn',
          text: `卡方检验显示，${params.y} 与 ${params.x} ${r.p < alpha ? '存在显著关联' : '无显著关联'}，χ²(${r.df}) = ${U.fmt(r.chi2, 2)}, p ${r.p < 0.001 ? '< .001' : '= ' + U.fmtP(r.p).replace(/^0/, '')}。`,
        };
        break;
      }
      default: break;
    }

    if (!render) return null;
    const key = state.activeId + '|' + pipelineKey() + '|' + familyKey + '|' + JSON.stringify(params);
    const oldIdx = state.results.findIndex((r) => r.key === key);
    const entry = {
      id: oldIdx >= 0 ? state.results[oldIdx].id : U.uid(),
      key, family: familyKey, params, render, at: Date.now(),
      datasetId: state.activeId,
    };
    if (oldIdx >= 0) state.results.splice(oldIdx, 1);
    state.results.unshift(entry);
    state.results = state.results.slice(0, 20);
    state.lastTest = entry;
    state.interpretation = '';
    persist();
    return entry;
  }

  function resultById(id) {
    return state.results.find((r) => r.id === id) || null;
  }

  /** 当前数据集 + 当前整理流水线的结果键前缀 */
  function resultKeyPrefix() {
    return state.activeId ? state.activeId + '|' + pipelineKey() + '|' : '';
  }

  /** 当前数据集的、且数据没被后续整理改过的分析结果 */
  function visibleResults() {
    const prefix = resultKeyPrefix();
    return state.results.filter((r) => {
      if (r.datasetId && r.datasetId !== state.activeId) return false;
      // 整理步骤变更后旧结果先隐藏（撤销整理还能再看到），避免拿旧数据的 p 值出图
      if (r.key && prefix && r.key.indexOf(prefix) !== 0) return false;
      return true;
    });
  }

  function removeResult(id) {
    state.results = state.results.filter((r) => r.id !== id);
    if (state.lastTest && state.lastTest.id === id) state.lastTest = visibleResults()[0] || null;
    if (state.annot.sourceId === id) state.annot.sourceId = null;
    persist();
    LD.ui.renderAll();
  }

  function clearResults() {
    state.results = [];
    state.lastTest = null;
    state.annot.sourceId = null;
    persist();
    LD.ui.renderAll();
  }

  /**
   * 把一次检验的结果直接承接成图表：分组检验 → 柱状/箱线/小提琴，
   * 相关/回归 → 散点 + 拟合线。显著性标注沿用该检验的两两比较结果，
   * 不再让图表页自己重算一套。
   */
  function plotTestResult(id, kind) {
    const r = id ? resultById(id) : state.lastTest;
    if (!r || !r.render || !r.render.spec) {
      U.toast('这个结果没有可用的变量信息，无法直接出图。', 'warn');
      return false;
    }
    if (r.datasetId && r.datasetId !== state.activeId) {
      U.toast('这个结果属于另一个数据集，请先切换到对应数据集再出图。', 'warn');
      return false;
    }
    const spec = r.render.spec;
    const k = kind || 'bar';

    if (!spec.g) {
      if ((spec.family === 'corr' || spec.family === 'reg') && r.params) {
        state.chart.type = 'scatter';
        state.chart.enc.x = spec.family === 'corr' ? r.params.x : (r.params.xs || [])[0] || null;
        state.chart.enc.y = r.params.y;
        state.chart.enc.series = null;
        state.chart.style.fitLine = true;
        state.annot.mode = 'none';
        state.annot.sourceId = null;
        ensureEncodings();
        go('chart');
        U.toast('已按回归/相关结果生成散点图', 'ok');
        return true;
      }
      U.toast('这个检验没有分组变量，暂时无法直接出图。', 'warn');
      return false;
    }

    state.chart.type = ['bar', 'box', 'violin'].includes(k) ? k : 'bar';
    state.chart.enc.x = spec.g;
    state.chart.enc.y = spec.y;
    state.chart.enc.series = null;
    state.chart.enc.agg = 'mean';
    if (state.chart.type === 'bar') state.chart.style.errType = 'sd';
    state.annot.mode = (r.render.pairs && r.render.pairs.length) ? 'letters' : 'none';
    state.annot.test = spec.method === 'mw' ? 'mw' : 'welch';
    state.annot.adj = spec.adjust || 'holm';
    state.annot.alpha = spec.alpha || 0.05;
    state.annot.sourceId = r.id;
    ensureEncodings();
    go('chart');
    const label = { bar: '柱状图（均值 ± 标准差）', box: '箱线图', violin: '小提琴图' }[state.chart.type] || '图表';
    U.toast(`已按「${r.render.title}」生成${label}`, 'ok', 4200);
    return true;
  }

  /* ---------- 持久化 ---------- */
  let saveTimer = null;
  let storageWarned = false;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const payload = {
          version: 1,
          savedAt: Date.now(),
          activeId: state.activeId,
          datasets: state.datasets.map((e) => ({ ds: e.ds, pipeline: e.pipeline })),
          chart: state.chart,
          curve: curveSnapshot(),
          annot: state.annot,
          results: state.results,
          descGroup: state.descGroup,
        };
        const json = JSON.stringify(payload);
        if (json.length > 4.5 * 1024 * 1024) {
          // 静默跳过会让用户以为工程还在自动保存，刷新后数据消失却毫无提示
          if (!storageWarned) {
            storageWarned = true;
            U.toast('数据超过浏览器本地存储上限（约 4.5 MB），自动保存已暂停。请用「工程 → 导出工程」备份，或先抽样/删列减小体积。', 'warn', 9000);
          }
          return;
        }
        localStorage.setItem(STORE_KEY, json);
      } catch (e) {
        if (!storageWarned) {
          storageWarned = true;
          U.toast('浏览器本地存储写入失败（可能空间不足或处于隐私模式）。请用「工程 → 导出工程」手动备份。', 'warn', 9000);
        }
      }
    }, 700);
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.datasets) || !data.datasets.length) return false;
      invalidateWork();
      state.datasets = data.datasets.map((e) => ({ id: e.ds.id, ds: e.ds, pipeline: e.pipeline || [] }));
      state.activeId = state.datasets.some((d) => d.id === data.activeId) ? data.activeId : state.datasets[0].id;
      if (data.chart) {
        state.chart.type = data.chart.type || 'bar';
        state.chart.enc = Object.assign(state.chart.enc, data.chart.enc || {});
        state.chart.style = Object.assign({}, LD.charts.STYLE_DEFAULTS, data.chart.style || {});
      }
      if (data.annot) state.annot = Object.assign(state.annot, data.annot);
      state.descGroup = data.descGroup || '';
      state.results = Array.isArray(data.results) ? data.results.slice(0, 20) : [];
      state.lastTest = visibleResults()[0] || null;
      if (data.curve) state.curve = mergeCurve(data.curve);
      recomputeDesc();
      initChartEncodings(true);
      initCurveEncodings(true);
      return true;
    } catch (e) { return false; }
  }

  function clearProject() {
    localStorage.removeItem(STORE_KEY);
  }

  function exportProject() {
    const payload = {
      app: 'LabDesk', version: 1, savedAt: new Date().toISOString(),
      datasets: state.datasets.map((e) => ({ ds: e.ds, pipeline: e.pipeline })),
      activeId: state.activeId, chart: state.chart, curve: curveSnapshot(), annot: state.annot,
      results: state.results, descGroup: state.descGroup,
    };
    U.download('labdesk-project-' + new Date().toISOString().slice(0, 10) + '.json',
      JSON.stringify(payload, null, 1), 'application/json');
  }

  function importProject(text) {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.datasets)) throw new Error('不是有效的 LabDesk 工程文件');
    invalidateWork();
    state.datasets = data.datasets.map((e) => ({ id: e.ds.id || U.uid(), ds: e.ds, pipeline: e.pipeline || [] }));
    state.activeId = state.datasets.length ? state.datasets[0].id : null;
    if (data.chart) {
      state.chart.type = data.chart.type || 'bar';
      state.chart.enc = Object.assign({}, state.chart.enc, data.chart.enc || {});
      state.chart.style = Object.assign({}, LD.charts.STYLE_DEFAULTS, data.chart.style || {});
    }
    if (data.curve) state.curve = mergeCurve(data.curve);
    state.descGroup = data.descGroup || '';
    state.results = Array.isArray(data.results) ? data.results.slice(0, 20) : [];
    state.lastTest = visibleResults()[0] || null;
    recomputeDesc();
    initChartEncodings(true);
    initCurveEncodings(true);
    persist();
  }

  /* ---------- 导出数据 ---------- */
  function toMatrix(ds) {
    const header = ds.columns.map((c) => c.name);
    return [header].concat(ds.rows.map((r) => r.map((v) => (v === null ? '' : v))));
  }

  function exportCsv(which) {
    const ds = which === 'raw' ? rawDataset() : workDataset();
    if (!ds) return;
    const m = toMatrix(ds);
    const csv = m.map((row) => row.map((v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    U.download((which === 'raw' ? 'raw-' : '') + ds.name.replace(/[\\/:*?"<>|]/g, '_') + '.csv',
      '\uFEFF' + csv, 'text/csv;charset=utf-8');
  }

  function exportXlsx(which) {
    const ds = which === 'raw' ? rawDataset() : workDataset();
    if (!ds) return;
    if (typeof XLSX === 'undefined') { U.toast('表格库未加载', 'err'); return; }
    const ws = XLSX.utils.aoa_to_sheet(toMatrix(ds));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'data');
    XLSX.writeFile(wb, ds.name.replace(/[\\/:*?"<>|]/g, '_') + '.xlsx');
  }

  /* ---------- 初始化 ---------- */
  function storageAvailable() {
    try {
      const k = '__labdesk_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  function init() {
    LD.ui.bind();
    if (LD.curveUI) LD.curveUI.bind();
    if (restore()) {
      state.view = 'table';
    } else {
      state.view = 'import';
    }
    LD.ui.renderAll();
    // 隐私模式 / 内嵌浏览器常禁用 localStorage，此时刷新就会丢工程，必须让用户知道
    if (!storageAvailable()) {
      U.toast('当前浏览器禁用了本地存储：刷新或关闭页面后工程不会保留，请用「工程 → 导出工程」随时备份', 'warn', 9000);
    }
    LD.ai.init().then(() => LD.ui.renderAiStatus());
  }

  LD.app = {
    state, FAMILIES,
    activeEntry, rawDataset, pipeline, workDataset, numNames, catNames,
    addDataset, removeDataset, setActive, go, pushOp, pushOps, undo, removeOp, clearPipeline,
    afterPipelineChange, recomputeDesc, initChartEncodings, ensureEncodings,
    initCurveEncodings, curveAnalysis, defaultCurveState, mergeCurve,
    invalidateWork, resultById, visibleResults, removeResult, clearResults, plotTestResult,
    runTest, persist, restore, clearProject, exportProject, importProject,
    exportCsv, exportXlsx, toMatrix,
    get working() { return workDataset(); },
    get lastFail() { return lastFail; },
  };

  document.addEventListener('DOMContentLoaded', init);
})();
