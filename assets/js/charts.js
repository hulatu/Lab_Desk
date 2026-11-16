/* LabDesk · 图表构建
   图表类型按数据列类型自动启用/禁用；所有图形按真实物理尺寸（mm）渲染，
   导出 600 dpi 位图或矢量 SVG 时保持字号与线宽符合期刊要求。
*/
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;
  const S = LD.stats;

  const MM2PX = 96 / 25.4; // 96 dpi 下的毫米转像素

  const STYLE_DEFAULTS = {
    widthMM: 85, heightMM: 62,
    fontFamily: 'Arial', fontSize: 8,
    lineWidth: 1, symbolSize: 6,
    palette: 'okabe-ito',
    gridShow: false, tickIn: true, borderBox: true,
    legendShow: true, legendPos: 'top',
    titleShow: false, titleText: '',
    xLabel: '', yLabel: '', yNameVertical: false,
    errType: 'sd', alpha: 0.88, jitter: 0, rotateX: 0, logY: false, fitLine: true,
    barWidth: 0.62, binCount: 0,
  };

  const FONTS = [
    ['Arial', 'Arial / Helvetica（无衬线，多数期刊首选）'],
    ['Times New Roman', 'Times New Roman（衬线，部分期刊要求）'],
    ['Georgia', 'Georgia（衬线，屏幕更清晰）'],
    ['"Helvetica Neue"', 'Helvetica Neue'],
    ['"Source Han Sans SC"', '思源黑体（中文图注）'],
    ['"Songti SC"', '宋体（中文正文）'],
  ];

  /* ==================== 数据聚合 ==================== */
  function colOf(ds, name) {
    const i = ds.columns.findIndex((c) => c.name === name);
    return i < 0 ? null : { index: i, ...ds.columns[i] };
  }
  function valuesOf(ds, name) {
    const c = colOf(ds, name);
    return c ? ds.rows.map((r) => r[c.index]) : [];
  }
  function numsOf(ds, name) {
    return valuesOf(ds, name).map((v) => (typeof v === 'number' ? v : U.parseNum(v)));
  }

  function aggValue(arr, agg) {
    if (!arr.length) return null;
    switch (agg) {
      case 'sum': return arr.reduce((a, b) => a + b, 0);
      case 'median': return S.quantile(arr.slice().sort((a, b) => a - b), 0.5);
      case 'count': return arr.length;
      case 'min': return Math.min(...arr);
      case 'max': return Math.max(...arr);
      default: return S.mean(arr);
    }
  }

  function errValue(arr, kind) {
    if (arr.length < 2) return 0;
    const sd = S.sd(arr);
    if (kind === 'sd') return sd;
    if (kind === 'se') return sd / Math.sqrt(arr.length);
    if (kind === 'ci') return S.tCrit(0.025, arr.length - 1) * sd / Math.sqrt(arr.length);
    return 0;
  }

  /** 按 x（可选 series）聚合，返回 {categories, series:[{name, points:[{mean,err,n}]}]} */
  function aggregate(ds, xName, yName, seriesName, agg, errKind) {
    const xi = colOf(ds, xName), yi = colOf(ds, yName);
    if (!xi || !yi) return null;
    const si = seriesName ? colOf(ds, seriesName) : null;
    const xIsNum = xi.type === 'number' || xi.type === 'date';
    const buckets = new Map();
    const cats = [];
    ds.rows.forEach((r) => {
      const xv = r[xi.index];
      if (xv === null || xv === undefined || xv === '') return;
      const yv = typeof r[yi.index] === 'number' ? r[yi.index] : U.parseNum(r[yi.index]);
      if (!isFinite(yv)) return;
      const key = String(xv);
      if (!buckets.has(key)) { buckets.set(key, { x: xv, bySeries: new Map() }); cats.push(xv); }
      const b = buckets.get(key);
      const sk = si ? String(r[si.index] === null ? '（空）' : r[si.index]) : '__single';
      if (!b.bySeries.has(sk)) b.bySeries.set(sk, []);
      b.bySeries.get(sk).push(yv);
    });

    if (xIsNum) cats.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    else {
      const numLike = cats.every((c) => !isNaN(parseFloat(c)) && /^-?\d+(\.\d+)?$/.test(String(c).trim()));
      if (numLike) cats.sort((a, b) => parseFloat(a) - parseFloat(b));
    }

    const seriesNames = new Set();
    buckets.forEach((b) => b.bySeries.forEach((_, k) => seriesNames.add(k)));
    const names = Array.from(seriesNames);
    const ordered = names.includes('__single') ? ['__single'] : names;

    const series = ordered.map((sn) => ({
      name: sn === '__single' ? yName : sn,
      points: cats.map((c) => {
        const arr = (buckets.get(String(c)) || { bySeries: new Map() }).bySeries.get(sn) || [];
        const m = aggValue(arr, agg);
        return { x: c, mean: m, err: errValue(arr, errKind), n: arr.length };
      }),
    }));

    return {
      categories: cats,
      series,
      xIsNum,
      xType: xi.type,
      multi: ordered.length > 1,
    };
  }

  /* ==================== 图表类型定义 ==================== */
  const TYPES = [
    {
      key: 'bar', name: '柱状图', req: '分类列 + 数值列',
      fields: [
        { k: 'x', label: '分类轴 (X)', kind: 'cat' },
        { k: 'y', label: '数值 (Y)', kind: 'num' },
        { k: 'series', label: '分组（可选）', kind: 'cat', optional: true },
      ],
      build: (c) => barOption(c, false),
    },
    {
      key: 'barH', name: '条形图', req: '分类列 + 数值列',
      fields: [
        { k: 'x', label: '分类轴 (Y)', kind: 'cat' },
        { k: 'y', label: '数值 (X)', kind: 'num' },
        { k: 'series', label: '分组（可选）', kind: 'cat', optional: true },
      ],
      build: (c) => barOption(c, true),
    },
    {
      key: 'barStack', name: '堆叠柱状图', req: '分类列 + 数值列 + 分组列',
      fields: [
        { k: 'x', label: '分类轴 (X)', kind: 'cat' },
        { k: 'y', label: '数值 (Y)', kind: 'num' },
        { k: 'series', label: '堆叠分组', kind: 'cat', required: true },
      ],
      build: (c) => barOption(c, false, 'stack'),
    },
    {
      key: 'barPct', name: '百分比堆叠图', req: '分类列 + 数值列 + 分组列',
      fields: [
        { k: 'x', label: '分类轴 (X)', kind: 'cat' },
        { k: 'y', label: '数值 (Y)', kind: 'num' },
        { k: 'series', label: '堆叠分组', kind: 'cat', required: true },
      ],
      build: (c) => barOption(c, false, 'pct'),
    },
    {
      key: 'line', name: '折线图', req: '数值 / 时间 / 分类轴 + 数值列',
      fields: [
        { k: 'x', label: '横轴 (X)', kind: 'any' },
        { k: 'y', label: '纵轴 (Y)', kind: 'num' },
        { k: 'series', label: '分组（可选）', kind: 'cat', optional: true },
      ],
      build: (c) => lineOption(c, false),
    },
    {
      key: 'area', name: '面积图', req: '数值 / 时间轴 + 数值列',
      fields: [
        { k: 'x', label: '横轴 (X)', kind: 'any' },
        { k: 'y', label: '纵轴 (Y)', kind: 'num' },
        { k: 'series', label: '分组（可选）', kind: 'cat', optional: true },
      ],
      build: (c) => lineOption(c, true),
    },
    {
      key: 'scatter', name: '散点图', req: '两个数值列',
      fields: [
        { k: 'x', label: '横轴 (X)', kind: 'num' },
        { k: 'y', label: '纵轴 (Y)', kind: 'num' },
        { k: 'series', label: '分组（可选）', kind: 'cat', optional: true },
      ],
      build: (c) => scatterOption(c, false),
    },
    {
      key: 'bubble', name: '气泡图', req: '三个数值列',
      fields: [
        { k: 'x', label: '横轴 (X)', kind: 'num' },
        { k: 'y', label: '纵轴 (Y)', kind: 'num' },
        { k: 'size', label: '气泡大小', kind: 'num', required: true },
        { k: 'series', label: '分组（可选）', kind: 'cat', optional: true },
      ],
      build: (c) => scatterOption(c, true),
    },
    {
      key: 'box', name: '箱线图', req: '分类列 + 数值列',
      fields: [
        { k: 'x', label: '分组轴 (X)', kind: 'cat' },
        { k: 'y', label: '数值 (Y)', kind: 'num' },
      ],
      build: (c) => boxOption(c),
    },
    {
      key: 'violin', name: '小提琴图', req: '分类列 + 数值列',
      fields: [
        { k: 'x', label: '分组轴 (X)', kind: 'cat' },
        { k: 'y', label: '数值 (Y)', kind: 'num' },
      ],
      build: (c) => violinOption(c),
    },
    {
      key: 'hist', name: '直方图', req: '一个数值列',
      fields: [{ k: 'x', label: '数值列', kind: 'num' }],
      build: (c) => histOption(c),
    },
    {
      key: 'heat', name: '相关性热力图', req: '至少两个数值列',
      fields: [{ k: 'multi', label: '参与变量', kind: 'multinum' }],
      build: (c) => heatOption(c),
    },
    {
      key: 'pie', name: '饼图', req: '分类列 + 数值列',
      fields: [
        { k: 'x', label: '分类', kind: 'cat' },
        { k: 'y', label: '数值', kind: 'num' },
      ],
      build: (c) => pieOption(c, false),
    },
    {
      key: 'donut', name: '环形图', req: '分类列 + 数值列',
      fields: [
        { k: 'x', label: '分类', kind: 'cat' },
        { k: 'y', label: '数值', kind: 'num' },
      ],
      build: (c) => pieOption(c, true),
    },
  ];

  function typeByKey(k) { return TYPES.find((t) => t.key === k) || TYPES[0]; }

  /* ==================== 可用性判断 ==================== */
  function columnSets(ds) {
    const num = ds ? ds.columns.filter((c) => c.type === 'number').map((c) => c.name) : [];
    const cat = ds ? ds.columns.filter((c) => c.type === 'category' || c.type === 'text' || c.type === 'date').map((c) => c.name) : [];
    return { num, cat, all: ds ? ds.columns.map((c) => c.name) : [] };
  }

  /**
   * 可作「分类轴 / 分组轴」的列，按适宜度从好到差排序。
   *
   * 除了分类列，水平数不多的数值列也算——温度 60/80/100 这种实验因子放在箱线图
   * 横轴上才是常规画法，硬要求「先数值分箱」是把本来能画的情况判成不能画。
   *
   * 排序按「每个取值的平均观测数」：样品编号这种每行唯一的标识列每组只剩 1 个点，
   * 箱线图会退化成一堆横线、柱状图全是单点高度，必须排到最后；
   * 真正有重复的分组变量（处理、批次、温度水平）排前面。
   */
  function groupCandidates(ds) {
    if (!ds) return [];
    const out = [];
    ds.columns.forEach((c, i) => {
      const vals = ds.rows.map((r) => r[i]).filter((v) => v !== null && v !== undefined && v !== '');
      const u = new Set(vals).size;
      if (u <= 1) return;                        // 常数列没有分组信息
      const rep = vals.length / u;
      const isCat = c.type !== 'number';
      // 连续数值列当分组轴会画成一片无意义的刻度，必须先分箱
      if (!isCat && (u > 12 || rep < 1.5)) return;
      const rank = rep < 1.5 ? 2 : (u <= 12 ? 0 : 1);
      out.push({ name: c.name, rank, u, i });
    });
    return out.sort((a, b) => a.rank - b.rank || a.u - b.u || a.i - b.i).map((o) => o.name);
  }

  function eligibility(type, ds) {
    const { num, cat } = columnSets(ds);
    if (!ds || !ds.rows.length) return { ok: false, reason: '请先载入数据' };
    const g = groupCandidates(ds);
    switch (type.key) {
      case 'scatter':
        return num.length >= 2 ? { ok: true } : { ok: false, reason: '需要 2 个数值列（当前 ' + num.length + ' 个）' };
      case 'bubble':
        return num.length >= 3 ? { ok: true } : { ok: false, reason: '需要 3 个数值列（当前 ' + num.length + ' 个）' };
      case 'hist':
        return num.length >= 1 ? { ok: true } : { ok: false, reason: '需要至少 1 个数值列' };
      case 'heat':
        return num.length >= 2 ? { ok: true } : { ok: false, reason: '需要至少 2 个数值列才能计算相关系数' };
      case 'box':
      case 'violin':
        if (!num.length) return { ok: false, reason: '需要 1 个数值列' };
        if (!g.length) return { ok: false, reason: '需要 1 个分组列（分类列，或温度/批次这类水平数不多的数值列；连续变量可先用「数值分箱」转成分组）' };
        return { ok: true };
      case 'barStack':
      case 'barPct':
        if (!num.length) return { ok: false, reason: '需要 1 个数值列' };
        if (g.length < 2) return { ok: false, reason: '需要 2 个分组列（一个作横轴、一个作堆叠分组）' };
        return { ok: true };
      case 'line':
      case 'area':
        // 只有一列数值时，横轴只能取它自己 → 画出来是一条 y = x 的直线，毫无信息量。
        // 要么有两个数值列，要么另有一个分组列可以当横轴。
        if (num.length >= 2) return { ok: true };
        if (num.length && g.some((n) => n !== num[0])) return { ok: true };
        return { ok: false, reason: '需要 2 个数值列，或 1 个数值列 + 1 个分组列作横轴（只有一列时横轴只能取它自己，画出来是一条直线）' };
      default:
        if (!num.length) return { ok: false, reason: '需要 1 个数值列' };
        if (!g.length) return { ok: false, reason: '需要 1 个分组列（分类列，或水平数不多的数值列；连续变量可先用「数值分箱」转成分组）' };
        return { ok: true };
    }
  }

  /* ==================== 公共坐标轴 / 样式 ==================== */
  function baseStyle(style) {
    const pal = U.palette(style.palette);
    const K = style.k || 1;
    const px = style.fontSize * 96 / 72;
    return {
      pal,
      font: `${px}px ${style.fontFamily}`,
      fontSize: px,
      axisLine: { lineStyle: { color: '#222', width: style.lineWidth } },
      axisTick: { show: true, inside: style.tickIn, length: (style.tickIn ? 3 : 4) * K, lineStyle: { color: '#222', width: style.lineWidth } },
      /* 刻度文字不要设 lineHeight：ECharts 用行高判断标签是否重叠，
         行高被放大到字号的 1.35 倍后，密集刻度会被判成「挤在一起」而被抽掉，
         表现为坐标轴首尾刻度凭空消失（0 和 5 不显示，只剩 1~4）。 */
      axisLabel: { color: '#222', fontSize: px, fontFamily: style.fontFamily, margin: 5 * K },
      nameStyle: { color: '#222', fontSize: px, fontFamily: style.fontFamily, lineHeight: Math.round(px * 1.4) },
      splitLine: { show: style.gridShow, lineStyle: { color: '#e8e8e8', width: 0.6 * K, type: 'dashed' } },
      gap: 30 * K,
      /* X 轴标签一旦旋转，标题就要相应下移，否则会压在标签上 */
      gapX: (30 + (style.rotateX > 0 ? 16 : 0)) * K,
    };
  }

  function axisName(style, axis, fallback) {
    const label = axis === 'x' ? style.xLabel : style.yLabel;
    const txt = (label || fallback || '').trim();
    return txt || '';
  }

  /**
   * Y 轴标题。中文竖排在 canvas 里字距过密、且容易和刻度数字挤在一起，
   * 默认改为期刊常见的「横排置于轴顶端上方」（Nature/Science 风格）；
   * style.yNameVertical 为真时仍走竖排（Origin 风格）。
   */
  function yNameBlock(style, text) {
    const K = style.k || 1;
    const st = baseStyle(style);
    if (style.yNameVertical) {
      return { name: text, nameLocation: 'middle', nameGap: 30 * K, nameTextStyle: st.nameStyle };
    }
    return {
      name: text,
      nameLocation: 'end',
      nameGap: 8 * K,
      nameTextStyle: Object.assign({}, st.nameStyle, { align: 'left', verticalAlign: 'bottom' }),
    };
  }

  function titleBlock(style) {
    const K = style.k || 1;
    if (!style.titleShow || !String(style.titleText || '').trim()) return {};
    return {
      title: {
        text: style.titleText,
        left: 'center', top: 2 * K,
        textStyle: { fontSize: (style.fontSize + 1) * 96 / 72, fontFamily: style.fontFamily, fontWeight: 'bold', color: '#111' },
      },
    };
  }

  function legendBlock(style, names) {
    const K = style.k || 1;
    if (!style.legendShow || names.length < 2) return { show: false };
    const pos = style.legendPos;
    const base = {
      show: true,
      data: names.slice(),
      itemWidth: style.fontSize * 1.4, itemHeight: style.fontSize * 0.9,
      itemGap: style.fontSize * 0.7,
      textStyle: { fontSize: style.fontSize * 96 / 72, fontFamily: style.fontFamily, color: '#222', lineHeight: Math.round(style.fontSize * 96 / 72 * 1.35) },
      icon: 'roundRect',
    };
    if (pos === 'top') return { ...base, top: 2 * K, left: 'center', orient: 'horizontal' };
    if (pos === 'right') return { ...base, right: 2 * K, top: 'middle', orient: 'vertical' };
    if (pos === 'bottom') return { ...base, bottom: 2 * K, left: 'center', orient: 'horizontal' };
    return { ...base, left: 2 * K, top: 'middle', orient: 'vertical' };
  }

  function gridBlock(style, extra) {
    const K = style.k || 1;
    const hasTitle = style.titleShow && String(style.titleText || '').trim();
    /* 横排的 Y 轴标题画在轴顶端上方，需要额外的顶部留白 */
    let top = (style.yNameVertical ? 10 : 26) * K;
    if (hasTitle) top += 18 * K;
    if (style.legendShow && style.legendPos === 'top') top += 18 * K;
    let bottom = 30 * K;
    if (style.rotateX > 0) bottom += 22 * K;
    if (style.legendShow && style.legendPos === 'bottom') bottom += 18 * K;
    const right = 22 * K + (style.legendShow && style.legendPos === 'right' ? 64 * K : 0);
    /* left 需要同时容纳「刻度数字」和「竖排 y 轴标题」：
       标题画在轴线左侧 nameGap(30px) 处，宽度约一个字号，
       若 left 只有 30 会被画布边缘裁掉（表现为只露出半个字）。 */
    const left = 46 * K + (style.legendShow && style.legendPos === 'left' ? 64 * K : 0);
    return Object.assign({ left, right, top, bottom, containLabel: true }, extra || {});
  }

  /** 把坐标轴上限取整到 1/2/5 × 10^k，避免出现 92.29995686233045 这类刻度 */
  function niceCeil(x) {
    if (!isFinite(x) || x === 0) return 1;
    const sign = x < 0 ? -1 : 1;
    const v = Math.abs(x);
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const f = v / base;
    let nf;
    if (f <= 1) nf = 1; else if (f <= 2) nf = 2; else if (f <= 2.5) nf = 2.5;
    else if (f <= 5) nf = 5; else nf = 10;
    return sign * nf * base;
  }

  /* ==================== 显著性标注 ==================== */
  function bracketSeries(annot, style) {
    if (!annot || !annot.length) return null;
    const st = baseStyle(style);
    return {
      type: 'custom',
      name: '__annot',
      z: 20,
      silent: true,
      data: annot.map((a) => [a.i, a.j, a.y, a.text]),
      renderItem: (params, api) => {
        const i = api.value(0), j = api.value(1), yv = api.value(2), text = api.value(3);
        const p1 = api.coord([i, yv]);
        const p2 = api.coord([j, yv]);
        const h = 7 * (style.k || 1);
        const y = p1[1];
        const lw = Math.max(0.6 * (style.k || 1), style.lineWidth * 0.8);
        return {
          type: 'group',
          children: [
            { type: 'line', shape: { x1: p1[0], y1: y, x2: p2[0], y2: y }, style: { stroke: '#333', lineWidth: lw } },
            { type: 'line', shape: { x1: p1[0], y1: y, x2: p1[0], y2: y + h }, style: { stroke: '#333', lineWidth: lw } },
            { type: 'line', shape: { x1: p2[0], y1: y, x2: p2[0], y2: y + h }, style: { stroke: '#333', lineWidth: lw } },
            {
              type: 'text',
              style: {
                text: String(text), x: (p1[0] + p2[0]) / 2, y: y - 3 * (style.k || 1),
                textAlign: 'center', textVerticalAlign: 'bottom',
                fill: '#222', fontSize: st.fontSize, fontFamily: style.fontFamily,
                // 白底把穿过的括号线盖住，星号不会和线条糊在一起
                backgroundColor: 'rgba(255,255,255,0.92)', padding: [1, 2],
              },
            },
          ],
        };
      },
    };
  }

  /* ==================== 柱状图 ==================== */
  function barOption(ctx, horizontal, mode) {
    const { ds, enc, style, annot } = ctx;
    const agg = aggregate(ds, enc.x, enc.y, mode === 'stack' || mode === 'pct' ? enc.series : enc.series, enc.agg || 'mean', style.errType);
    if (!agg) return null;
    const st = baseStyle(style);
    const cats = agg.categories.map((c) => String(c));

    let seriesData = agg.series;
    if (mode === 'pct') {
      const totals = cats.map((_, i) => seriesData.reduce((s, se) => s + (se.points[i].mean || 0), 0));
      seriesData = seriesData.map((se) => ({
        ...se,
        points: se.points.map((p, i) => ({ ...p, mean: totals[i] ? (p.mean || 0) / totals[i] * 100 : 0, err: 0 })),
      }));
    }

    const showErr = style.errType !== 'none' && mode !== 'pct' && !horizontal;
    const series = seriesData.map((se, si) => {
      const color = st.pal[si % st.pal.length];
      const isStack = mode === 'stack' || mode === 'pct';
      const base = {
        name: se.name,
        type: 'bar',
        stack: isStack ? 'total' : undefined,
        barMaxWidth: 42,
        barGap: isStack ? undefined : '12%',
        itemStyle: { color: U.alpha(color, style.alpha), borderColor: color, borderWidth: style.lineWidth * 0.5, borderRadius: 0 },
        emphasis: { focus: 'series' },
        data: se.points.map((p) => (p.mean === null ? null : +p.mean.toFixed(6))),
      };
      if (showErr) {
        const errs = se.points.map((p) => (p.mean === null ? null : +p.err.toFixed(6)));
        base.data = se.points.map((p, i) => ({ value: p.mean === null ? null : +p.mean.toFixed(6), __err: errs[i] }));
      }
      return base;
    });

    if (showErr) {
      const custom = {
        type: 'custom',
        name: '__err',
        z: 10,
        silent: true,
        renderItem: (params, api) => {
          const ci = api.value(0), val = api.value(1), lo = api.value(2), hi = api.value(3);
          const c = api.coord([ci, val]);
          const pl = api.coord([ci, lo]);
          const ph = api.coord([ci, hi]);
          const w = Math.min(6, api.size([1, 0])[0] * 0.12);
          const lw = Math.max(0.6, style.lineWidth * 0.8);
          const stroke = '#333';
          return {
            type: 'group',
            children: [
              { type: 'line', shape: { x1: c[0], y1: pl[1], x2: c[0], y2: ph[1] }, style: { stroke, lineWidth: lw } },
              { type: 'line', shape: { x1: c[0] - w, y1: pl[1], x2: c[0] + w, y2: pl[1] }, style: { stroke, lineWidth: lw } },
              { type: 'line', shape: { x1: c[0] - w, y1: ph[1], x2: c[0] + w, y2: ph[1] }, style: { stroke, lineWidth: lw } },
            ],
          };
        },
        data: seriesData.reduce((acc, se) => {
          se.points.forEach((p, i) => {
            if (p.mean === null) return;
            acc.push([i, p.mean, p.mean - p.err, p.mean + p.err]);
          });
          return acc;
        }, []),
        encode: { x: 0, y: [1, 2, 3] },
      };
      series.push(custom);
    }

    const catName = axisName(style, horizontal ? 'y' : 'x', enc.x);
    const valName = axisName(style, horizontal ? 'x' : 'y', mode === 'pct' ? '占比 (%)' : enc.y);
    const plainAxisName = (text) => ({ name: text, nameLocation: 'middle', nameGap: st.gapX, nameTextStyle: st.nameStyle });
    const catAxis = Object.assign({
      type: 'category',
      data: cats,
      axisLine: st.axisLine,
      axisTick: st.axisTick,
      axisLabel: { ...st.axisLabel, rotate: style.rotateX, interval: 0, hideOverlap: true },
      splitLine: { show: false },
    }, horizontal ? yNameBlock(style, catName) : plainAxisName(catName));
    const valAxis = Object.assign({
      type: 'value',
      axisLine: { show: style.borderBox, lineStyle: st.axisLine.lineStyle },
      axisTick: { ...st.axisTick, inside: style.tickIn },
      axisLabel: st.axisLabel,
      splitLine: st.splitLine,
      scale: false,
    }, horizontal ? plainAxisName(valName) : yNameBlock(style, valName));
    if (mode === 'pct') { valAxis.max = 100; valAxis.min = 0; }

    const maxVal = Math.max(...seriesData.map((se) => Math.max(...se.points.map((p) => (p.mean || 0) + (p.err || 0)))), 0);
    if (annot && annot.length && !horizontal) {
      const topY = Math.max(maxVal, ...annot.map((a) => a.y || 0));
      valAxis.max = niceCeil(topY * 1.06);
    }

    const bracket = bracketSeries(annot, style);

    const opt = {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: style.fontFamily },
      ...titleBlock(style),
      legend: legendBlock(style, seriesData.map((s) => s.name)),
      grid: gridBlock(style, horizontal ? { left: 62, bottom: 30 } : null),
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      series: bracket ? series.concat([bracket]) : series,
      tooltip: { show: false },
    };
    if (horizontal) {
      opt.yAxis.inverse = true;
    }
    return opt;
  }

  /* ==================== 折线 / 面积 ==================== */
  function lineOption(ctx, area) {
    const { ds, enc, style, annot } = ctx;
    const agg = aggregate(ds, enc.x, enc.y, enc.series, enc.agg || 'mean', style.errType);
    if (!agg) return null;
    const st = baseStyle(style);
    const useValueAxis = agg.xIsNum;
    const showErr = style.errType !== 'none';

    const series = agg.series.map((se, si) => {
      const color = st.pal[si % st.pal.length];
      const data = agg.categories.map((c, i) => {
        const p = se.points[i];
        if (p.mean === null) return null;
        return useValueAxis ? [Number(c), +p.mean.toFixed(6)] : +p.mean.toFixed(6);
      });
      return {
        name: se.name,
        type: 'line',
        smooth: false,
        symbol: 'circle',
        symbolSize: style.symbolSize,
        showSymbol: agg.categories.length <= 60,
        lineStyle: { width: style.lineWidth * 1.4, color },
        itemStyle: { color, borderColor: '#fff', borderWidth: style.lineWidth * 0.6 },
        areaStyle: area ? { color: U.alpha(color, 0.18) } : undefined,
        data,
        emphasis: { focus: 'series' },
        connectNulls: false,
      };
    });

    if (showErr) {
      series.push({
        type: 'custom',
        name: '__err',
        z: 9,
        silent: true,
        renderItem: (params, api) => {
          const xv = api.value(0), val = api.value(1), lo = api.value(2), hi = api.value(3);
          const c = api.coord([xv, val]);
          const pl = api.coord([xv, lo]);
          const ph = api.coord([xv, hi]);
          const w = 4, lw = Math.max(0.6, style.lineWidth * 0.8), stroke = '#333';
          return {
            type: 'group',
            children: [
              { type: 'line', shape: { x1: c[0], y1: pl[1], x2: c[0], y2: ph[1] }, style: { stroke, lineWidth: lw } },
              { type: 'line', shape: { x1: c[0] - w, y1: pl[1], x2: c[0] + w, y2: pl[1] }, style: { stroke, lineWidth: lw } },
              { type: 'line', shape: { x1: c[0] - w, y1: ph[1], x2: c[0] + w, y2: ph[1] }, style: { stroke, lineWidth: lw } },
            ],
          };
        },
        data: agg.series.reduce((acc, se) => {
          se.points.forEach((p, i) => {
            if (p.mean === null) return;
            const xv = useValueAxis ? Number(agg.categories[i]) : i;
            acc.push([xv, p.mean, p.mean - p.err, p.mean + p.err]);
          });
          return acc;
        }, []),
        encode: { x: 0, y: [1, 2, 3] },
        xAxisIndex: 0,
      });
    }

    const xAxis = useValueAxis
      ? {
        type: agg.xType === 'date' ? 'time' : 'value',
        name: axisName(style, 'x', enc.x), nameLocation: 'middle', nameGap: st.gapX, nameTextStyle: st.nameStyle,
        axisLine: { show: style.borderBox, lineStyle: st.axisLine.lineStyle },
        axisTick: { ...st.axisTick, inside: style.tickIn },
        axisLabel: st.axisLabel,
        splitLine: st.splitLine,
        scale: true,
      }
      : {
        type: 'category',
        data: agg.categories.map((c) => String(c)),
        boundaryGap: false,
        name: axisName(style, 'x', enc.x), nameLocation: 'middle', nameGap: st.gapX, nameTextStyle: st.nameStyle,
        axisLine: st.axisLine, axisTick: st.axisTick,
        axisLabel: { ...st.axisLabel, rotate: style.rotateX, hideOverlap: true },
        splitLine: { show: false },
      };

    const yAxis = {
      type: style.logY ? 'log' : 'value',
      ...yNameBlock(style, axisName(style, 'y', enc.y)),
      axisLine: { show: style.borderBox, lineStyle: st.axisLine.lineStyle },
      axisTick: { ...st.axisTick, inside: style.tickIn },
      axisLabel: st.axisLabel,
      splitLine: st.splitLine,
      scale: !style.logY,
    };

    const bracket = bracketSeries(annot, style);

    return {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: style.fontFamily },
      ...titleBlock(style),
      legend: legendBlock(style, series.filter((s) => s.name !== '__err').map((s) => s.name)),
      grid: gridBlock(style),
      xAxis,
      yAxis,
      series: bracket ? series.concat([bracket]) : series,
      tooltip: { show: false },
    };
  }

  /* ==================== 散点 / 气泡 ==================== */
  function scatterOption(ctx, bubble) {
    const { ds, enc, style } = ctx;
    const xi = colOf(ds, enc.x), yi = colOf(ds, enc.y);
    if (!xi || !yi) return null;
    const si = enc.series ? colOf(ds, enc.series) : null;
    const zi = bubble && enc.size ? colOf(ds, enc.size) : null;
    const st = baseStyle(style);

    const groups = new Map();
    ds.rows.forEach((r) => {
      const xv = typeof r[xi.index] === 'number' ? r[xi.index] : U.parseNum(r[xi.index]);
      const yv = typeof r[yi.index] === 'number' ? r[yi.index] : U.parseNum(r[yi.index]);
      if (!isFinite(xv) || !isFinite(yv)) return;
      const key = si ? String(r[si.index]) : enc.y;
      if (!groups.has(key)) groups.set(key, []);
      const zv = zi ? (typeof r[zi.index] === 'number' ? r[zi.index] : U.parseNum(r[zi.index])) : null;
      groups.get(key).push([xv, yv, isFinite(zv) ? zv : null]);
    });

    const zAll = bubble ? Array.from(groups.values()).flat().map((d) => d[2]).filter((v) => v !== null) : [];
    const zMin = zAll.length ? Math.min(...zAll) : 0;
    const zMax = zAll.length ? Math.max(...zAll) : 1;

    const series = [];
    let si2 = 0;
    groups.forEach((pts, name) => {
      const color = st.pal[si2 % st.pal.length];
      si2++;
      const data = pts.map((p) => {
        if (!bubble) return [p[0], p[1]];
        const t = zMax > zMin ? (p[2] - zMin) / (zMax - zMin) : 0.5;
        return { value: [p[0], p[1], p[2]], symbolSize: style.symbolSize * 1.2 + t * style.symbolSize * 3.2 };
      });
      series.push({
        name: String(name),
        type: 'scatter',
        data,
        symbolSize: bubble ? undefined : style.symbolSize,
        itemStyle: { color: U.alpha(color, style.alpha), borderColor: color, borderWidth: style.lineWidth * 0.5 },
        emphasis: { focus: 'series' },
      });

      if (style.fitLine && pts.length >= 3 && !bubble) {
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const fit = S.ols(ys, [xs], [enc.x]);
        if (fit && isFinite(fit.coef[1].b)) {
          const xmin = Math.min(...xs), xmax = Math.max(...xs);
          const b0 = fit.coef[0].b, b1 = fit.coef[1].b;
          series.push({
            name: '__fit',
            type: 'line',
            showSymbol: false,
            silent: true,
            data: [[xmin, b0 + b1 * xmin], [xmax, b0 + b1 * xmax]],
            lineStyle: { width: style.lineWidth * 1.2, color, type: 'dashed' },
            itemStyle: { color },
          });
        }
      }
    });

    return {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: style.fontFamily },
      ...titleBlock(style),
      legend: legendBlock(style, Array.from(groups.keys()).map(String)),
      grid: gridBlock(style),
      xAxis: {
        type: 'value', scale: true,
        name: axisName(style, 'x', enc.x), nameLocation: 'middle', nameGap: st.gapX, nameTextStyle: st.nameStyle,
        axisLine: { show: style.borderBox, lineStyle: st.axisLine.lineStyle },
        axisTick: { ...st.axisTick, inside: style.tickIn },
        axisLabel: st.axisLabel, splitLine: st.splitLine,
      },
      yAxis: {
        type: 'value', scale: true,
        ...yNameBlock(style, axisName(style, 'y', enc.y)),
        axisLine: { show: style.borderBox, lineStyle: st.axisLine.lineStyle },
        axisTick: { ...st.axisTick, inside: style.tickIn },
        axisLabel: st.axisLabel, splitLine: st.splitLine,
      },
      series: series.filter((s) => s.name !== '__fit').concat(series.filter((s) => s.name === '__fit')),
      tooltip: { show: false },
    };
  }

  /* ==================== 箱线 / 小提琴 ==================== */
  function groupSeries(ds, xName, yName) {
    const xi = colOf(ds, xName), yi = colOf(ds, yName);
    if (!xi || !yi) return null;
    const map = new Map();
    ds.rows.forEach((r) => {
      const yv = typeof r[yi.index] === 'number' ? r[yi.index] : U.parseNum(r[yi.index]);
      if (!isFinite(yv)) return;
      const k = String(r[xi.index] === null ? '（空）' : r[xi.index]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(yv);
    });
    const labels = Array.from(map.keys());
    return { labels, groups: labels.map((l) => map.get(l)) };
  }

  function boxOption(ctx) {
    const { ds, enc, style, annot } = ctx;
    const g = groupSeries(ds, enc.x, enc.y);
    if (!g) return null;
    const st = baseStyle(style);
    const data = g.groups.map((arr) => {
      const sx = arr.slice().sort((a, b) => a - b);
      return [sx[0], S.quantile(sx, 0.25), S.quantile(sx, 0.5), S.quantile(sx, 0.75), sx[sx.length - 1]];
    });
    const dataMax = Math.max(...g.groups.flat());
    const top = annot && annot.length ? Math.max(dataMax, ...annot.map((a) => a.y || 0)) : null;
    return {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: style.fontFamily },
      ...titleBlock(style),
      grid: gridBlock(style),
      xAxis: {
        type: 'category', data: g.labels,
        name: axisName(style, 'x', enc.x), nameLocation: 'middle', nameGap: st.gapX, nameTextStyle: st.nameStyle,
        axisLine: st.axisLine, axisTick: st.axisTick,
        axisLabel: { ...st.axisLabel, rotate: style.rotateX, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', scale: true, max: top === null ? undefined : niceCeil(top * 1.02),
        ...yNameBlock(style, axisName(style, 'y', enc.y)),
        axisLine: { show: style.borderBox, lineStyle: st.axisLine.lineStyle },
        axisTick: { ...st.axisTick, inside: style.tickIn },
        axisLabel: st.axisLabel, splitLine: st.splitLine,
      },
      series: [{
        type: 'boxplot',
        data,
        boxWidth: [8, 42],
        itemStyle: { color: U.alpha(st.pal[0], 0.28), borderColor: st.pal[0], borderWidth: style.lineWidth },
        emphasis: { itemStyle: { borderWidth: style.lineWidth * 1.6 } },
      }].concat(annot && annot.length ? [bracketSeries(annot, style)] : []),
      tooltip: { show: false },
    };
  }

  function kde(values, grid, bw) {
    const n = values.length;
    const sdv = S.sd(values) || 1;
    const h = bw || 1.06 * sdv * Math.pow(n, -0.2);
    return grid.map((x) => {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const u = (x - values[i]) / h;
        s += Math.exp(-0.5 * u * u);
      }
      return s / (n * h * Math.sqrt(2 * Math.PI));
    });
  }

  function violinOption(ctx) {
    const { ds, enc, style, annot } = ctx;
    const g = groupSeries(ds, enc.x, enc.y);
    if (!g) return null;
    const st = baseStyle(style);
    const all = g.groups.flat();
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.05 || 1;
    const grid = [];
    const STEPS = 60;
    for (let i = 0; i <= STEPS; i++) grid.push(lo - pad + (hi - lo + 2 * pad) * i / STEPS);

    const profiles = g.groups.map((arr) => {
      const d = kde(arr, grid);
      const mx = Math.max(...d) || 1;
      return { values: arr, dens: d.map((v) => v / mx) };
    });

    const items = profiles.map((p, i) => ({ i, profile: p }));

    return {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: style.fontFamily },
      ...titleBlock(style),
      grid: gridBlock(style),
      xAxis: {
        type: 'category', data: g.labels, boundaryGap: true,
        name: axisName(style, 'x', enc.x), nameLocation: 'middle', nameGap: st.gapX, nameTextStyle: st.nameStyle,
        axisLine: st.axisLine, axisTick: st.axisTick,
        axisLabel: { ...st.axisLabel, rotate: style.rotateX, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: Math.floor((lo - pad) * 10) / 10,
        max: Math.max(Math.ceil((hi + pad) * 10) / 10,
          annot && annot.length ? niceCeil(Math.max(hi, ...annot.map((a) => a.y || 0)) * 1.02) : -Infinity),
        ...yNameBlock(style, axisName(style, 'y', enc.y)),
        axisLine: { show: style.borderBox, lineStyle: st.axisLine.lineStyle },
        axisTick: { ...st.axisTick, inside: style.tickIn },
        axisLabel: st.axisLabel, splitLine: st.splitLine,
      },
      series: [{
        type: 'custom',
        name: enc.y,
        data: items.map((it) => [it.i, it]),
        renderItem: (params, api) => {
          const it = items[params.dataIndex];
          const catIdx = it.i;
          const cx = api.coord([catIdx, 0])[0];
          const halfW = Math.min(28, api.size([1, 0])[0] * 0.36);
          const left = [], right = [];
          it.profile.dens.forEach((d, k) => {
            const py = api.coord([catIdx, grid[k]])[1];
            left.push([cx - d * halfW, py]);
            right.push([cx + d * halfW, py]);
          });
          const color = st.pal[params.dataIndex % st.pal.length];
          const sx = it.profile.values.slice().sort((a, b) => a - b);
          const med = S.quantile(sx, 0.5);
          const q1 = S.quantile(sx, 0.25), q3 = S.quantile(sx, 0.75);
          const pMed = api.coord([catIdx, med])[1];
          const pQ1 = api.coord([catIdx, q1])[1];
          const pQ3 = api.coord([catIdx, q3])[1];
          const boxW = Math.max(3, halfW * 0.14);
          return {
            type: 'group',
            children: [
              { type: 'polygon', shape: { points: left.concat(right.reverse()) }, style: { fill: U.alpha(color, 0.3), stroke: color, lineWidth: style.lineWidth } },
              { type: 'line', shape: { x1: cx - boxW, y1: pQ3, x2: cx + boxW, y2: pQ3 }, style: { stroke: '#333', lineWidth: Math.max(0.8, style.lineWidth) } },
              { type: 'line', shape: { x1: cx - boxW, y1: pQ1, x2: cx + boxW, y2: pQ1 }, style: { stroke: '#333', lineWidth: Math.max(0.8, style.lineWidth) } },
              { type: 'line', shape: { x1: cx - boxW, y1: pQ1, x2: cx - boxW, y2: pQ3 }, style: { stroke: '#333', lineWidth: Math.max(0.8, style.lineWidth) } },
              { type: 'line', shape: { x1: cx + boxW, y1: pQ1, x2: cx + boxW, y2: pQ3 }, style: { stroke: '#333', lineWidth: Math.max(0.8, style.lineWidth) } },
              { type: 'line', shape: { x1: cx - boxW, y1: pMed, x2: cx + boxW, y2: pMed }, style: { stroke: '#111', lineWidth: Math.max(1, style.lineWidth * 1.4) } },
            ],
          };
        },
      }].concat(annot && annot.length ? [bracketSeries(annot, style)] : []),
      tooltip: { show: false },
    };
  }

  /* ==================== 直方图 ==================== */
  function histOption(ctx) {
    const { ds, enc, style } = ctx;
    const vals = numsOf(ds, enc.x).filter(isFinite);
    if (!vals.length) return null;
    const st = baseStyle(style);
    const n = vals.length;
    const k = style.binCount > 0 ? style.binCount : Math.max(4, Math.round(Math.sqrt(n)) || 6);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = hi - lo || 1;
    const edges = Array.from({ length: k + 1 }, (_, i) => lo + span * i / k);
    const counts = new Array(k).fill(0);
    vals.forEach((v) => {
      let b = Math.floor((v - lo) / span * k);
      if (b >= k) b = k - 1;
      if (b < 0) b = 0;
      counts[b]++;
    });
    const labels = counts.map((_, i) => {
      const a = edges[i], b = edges[i + 1];
      return `${U.fmt(a, 2)}~${U.fmt(b, 2)}`;
    });

    return {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: style.fontFamily },
      ...titleBlock(style),
      grid: gridBlock(style, { bottom: 74 * (style.k || 1) }),
      xAxis: {
        type: 'category', data: labels,
        /* 分组区间标签默认旋转 40°，占用的垂直空间远大于一行文字，
           标题的 nameGap 必须把这段高度算进去，否则会压在标签上。 */
        name: axisName(style, 'x', enc.x), nameLocation: 'middle',
        nameGap: st.gap + 34 * (style.k || 1), nameTextStyle: st.nameStyle,
        axisLine: st.axisLine, axisTick: st.axisTick,
        axisLabel: { ...st.axisLabel, rotate: style.rotateX || 40, hideOverlap: true, interval: 'auto' },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        minInterval: 1, // 频数只能是整数，避免出现 3/6/9 这类刻度
        ...yNameBlock(style, axisName(style, 'y', '频数')),
        axisLine: { show: style.borderBox, lineStyle: st.axisLine.lineStyle },
        axisTick: { ...st.axisTick, inside: style.tickIn },
        axisLabel: st.axisLabel, splitLine: st.splitLine,
      },
      series: [{
        type: 'bar',
        data: counts,
        barWidth: '96%',
        itemStyle: { color: U.alpha(st.pal[0], style.alpha), borderColor: st.pal[0], borderWidth: style.lineWidth },
      }],
      tooltip: { show: false },
    };
  }

  /* ==================== 热力图 ==================== */
  function heatOption(ctx) {
    const { ds, enc, style } = ctx;
    let cols = (enc.multi && enc.multi.length ? enc.multi : ds.columns.filter((c) => c.type === 'number').map((c) => c.name)).slice(0, 12);
    // 常数变量无法计算相关系数，直接排除，避免出现整行空白
    cols = cols.filter((name) => {
      const v = numsOf(ds, name).filter(isFinite);
      if (v.length < 3) return false;
      return Math.max(...v) - Math.min(...v) > 1e-12;
    });
    if (cols.length < 2) return null;
    const st = baseStyle(style);
    const data = cols.map((c) => ({ name: c, values: numsOf(ds, c) }));
    const mat = S.corrMatrix(data, enc.method || 'pearson');
    const cells = [];
    for (let i = 0; i < cols.length; i++) {
      for (let j = 0; j < cols.length; j++) cells.push([j, i, +mat[i][j].toFixed(3)]);
    }
    const short = cols.map((c) => (c.length > 10 ? c.slice(0, 9) + '…' : c));

    return {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: style.fontFamily },
      ...titleBlock(style),
      grid: gridBlock(style, { left: 10 * (style.k || 1), right: 10 * (style.k || 1), top: 12 * (style.k || 1), bottom: 26 * (style.k || 1), containLabel: true }),
      xAxis: {
        type: 'category', data: short, splitArea: { show: false },
        axisLine: st.axisLine, axisTick: st.axisTick,
        axisLabel: { ...st.axisLabel, rotate: 45, interval: 0, hideOverlap: false },
      },
      yAxis: {
        type: 'category', data: short, inverse: true,
        axisLine: st.axisLine, axisTick: st.axisTick,
        axisLabel: { ...st.axisLabel, interval: 0 },
      },
      visualMap: {
        min: -1, max: 1, calculable: false, orient: 'horizontal',
        left: 'center', bottom: 0, itemWidth: 12 * (style.k || 1), itemHeight: 90 * (style.k || 1),
        text: ['1', '-1'], textGap: 4,
        textStyle: { fontSize: style.fontSize * 96 / 72, fontFamily: style.fontFamily },
        inRange: { color: ['#2166AC', '#67A9CF', '#F7F7F7', '#EF8A62', '#B2182B'] },
      },
      series: [{
        type: 'heatmap',
        data: cells,
        label: {
          show: cols.length <= 8,
          fontSize: style.fontSize * 96 / 72,
          fontFamily: style.fontFamily,
          formatter: (p) => (Math.abs(p.value[2]) >= 0.995 ? p.value[2].toFixed(2) : p.value[2].toFixed(2)),
        },
        itemStyle: { borderColor: '#fff', borderWidth: 1 },
      }],
      tooltip: { show: false },
    };
  }

  /* ==================== 饼图 ==================== */
  function pieOption(ctx, donut) {
    const { ds, enc, style } = ctx;
    const agg = aggregate(ds, enc.x, enc.y, null, 'sum', 'none');
    if (!agg) return null;
    const st = baseStyle(style);
    const data = agg.categories.map((c, i) => ({
      name: String(c),
      value: +(agg.series[0].points[i].mean || 0).toFixed(4),
    })).filter((d) => d.value > 0);
    const total = data.reduce((s, d) => s + d.value, 0) || 1;

    return {
      animation: false,
      backgroundColor: '#fff',
      textStyle: { fontFamily: style.fontFamily },
      ...titleBlock(style),
      legend: legendBlock(style, data.map((d) => d.name)),
      series: [{
        type: 'pie',
        radius: donut ? ['42%', '68%'] : ['0%', '66%'],
        center: ['50%', style.legendPos === 'right' ? '52%' : '54%'],
        data,
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 1.2 * (style.k || 1) },
        label: {
          show: true,
          fontSize: style.fontSize * 96 / 72,
          fontFamily: style.fontFamily,
          lineHeight: Math.round(style.fontSize * 96 / 72 * 1.35),
          formatter: (p) => `${p.name}\n${(p.value / total * 100).toFixed(1)}%`,
        },
        labelLine: { length: 8 * (style.k || 1), length2: 8 * (style.k || 1), lineStyle: { width: 0.8 * (style.k || 1) } },
        color: data.map((_, i) => U.alpha(st.pal[i % st.pal.length], style.alpha)),
      }],
      tooltip: { show: false },
    };
  }

  /* ==================== 显著性计算（供标注使用） ==================== */
  /**
   * opts.rows 传入时，直接使用上一次检验得到的两两比较结果，
   * 不再按图表的 X/Y 重新算一套——这是「检验 → 出图」能对上的关键。
   */
  function computeAnnotations(ds, enc, mode, testMethod, adj, alpha, opts, scope) {
    if (mode === 'none') return { list: [], note: '' };
    const o = opts || {};
    const xi = colOf(ds, enc.x), yi = colOf(ds, enc.y);
    if (!xi || !yi) return { list: [], note: '' };
    const g = groupSeries(ds, enc.x, enc.y);
    if (!g || g.labels.length < 2) return { list: [], note: '至少需要两个分组才能做两两比较' };

    let rows;
    let method;
    let note;
    if (o.rows && o.rows.length) {
      rows = o.rows.filter((r) => g.labels.includes(r.a) && g.labels.includes(r.b));
      method = o.method || '';
      note = o.note || '';
      if (!rows.length) return { list: [], rows: [], note: '检验结果的分组与当前图表不一致，请重新选择 X/Y 或清除标注来源。' };
    } else {
      method = testMethod;
      if (method === 'auto') {
        const normal = g.groups.map((arr) => {
          const r = S.shapiroWilk(arr);
          return r ? r.p : 1;
        });
        const allNormal = normal.every((p) => p > 0.05);
        const lev = S.levene(g.groups);
        method = allNormal && lev && lev.p > 0.05 ? 'welch' : 'mw';
      }
      rows = S.pairwise(g.groups, g.labels, { method, adjust: adj });
      const sigCount = rows.filter((r) => r.pAdj < alpha).length;
      note = `${method === 'mw' ? 'Mann–Whitney U' : 'Welch t'} 两两比较，${adj === 'none' ? '未校正' : adj === 'bonf' ? 'Bonferroni' : 'Holm'} 校正；${sigCount}/${rows.length} 对差异显著（α = ${alpha}）`;
    }

    const useP = mode === 'p';
    const sc = scope || 'sig';
    const sigCount = rows.filter((r) => r.pAdj < alpha).length;
    let draw;
    if (sc === 'ref') {
      /* 六组以上时，15 对全画出来一定会堆成梯子。只和对照组比是论文里最常见的做法。 */
      const ref = g.labels[0];
      draw = rows.filter((r) => r.a === ref || r.b === ref);
    } else if (sc === 'all') {
      draw = rows.slice();
    } else {
      draw = rows.filter((r) => r.pAdj < alpha);
    }

    /* 括号排版：先按跨度从短到长排序，再放进「同一层互不重叠」的最低层。
       六组数据有 15 对比较，如果按比较顺序逐条往上堆，括号会叠成一堵墙；
       分层之后相邻比较落在同一层，长跨度放在更高层，读数最清楚。 */
    draw = draw
      .map((r) => {
        let i = g.labels.indexOf(r.a), j = g.labels.indexOf(r.b);
        if (i > j) { const t = i; i = j; j = t; }
        return { r, i, j };
      })
      .filter((d) => d.i >= 0 && d.j >= 0 && d.i !== d.j)
      .sort((a, b) => (a.j - a.i) - (b.j - b.i) || a.i - b.i);

    const levels = [];
    draw.forEach((d) => {
      let lv = 0;
      /* 端点相接的相邻比较可以放在同一层：A–B 与 B–C 共用 B 处的竖线，
         视觉上是一条带刻度的横线，比把每一对单独抬高一层紧凑得多。 */
      while (levels[lv] && levels[lv].some((iv) => !(d.j <= iv[0] || d.i >= iv[1]))) lv++;
      (levels[lv] = levels[lv] || []).push([d.i, d.j]);
      d.level = lv;
    });

    const all = g.groups.flat();
    const ymax = Math.max(...all);
    const ymin = Math.min(...all);
    const step = (ymax - ymin) * 0.09 || 1;
    const list = draw.map((d) => ({
      i: d.i,
      j: d.j,
      level: d.level,
      y: ymax + step * (0.6 + d.level * 1.35),
      text: useP ? `p = ${U.fmtP(d.r.pAdj)}` : U.stars(d.r.pAdj),
      p: d.r.pAdj, raw: d.r.p, a: d.r.a, b: d.r.b,
    }));

    let layoutNote = '';
    if (sc === 'sig') {
      layoutNote = sigCount
        ? `仅标注显著的 ${sigCount} 对（共 ${rows.length} 对）`
        : `没有任何一对达到 α = ${alpha} 的显著水平，未绘制括号；把「比较范围」改成「全部两两比较」可查看 ns`;
    } else if (sc === 'ref') {
      layoutNote = `仅与第一组「${g.labels[0]}」比较，共 ${draw.length} 对（${draw.filter((r) => r.pAdj < alpha).length} 对显著）`;
    } else {
      layoutNote = `显示全部 ${rows.length} 对比较（${sigCount} 对显著）`;
    }
    if (layoutNote) note = note ? note + '；' + layoutNote : layoutNote;

    return {
      list,
      rows,
      method,
      note,
      ymax: list.length ? Math.max(...list.map((l) => l.y)) : null,
    };
  }

  /* ==================== 描述性说明 ==================== */
  function describeNote(type, enc, style, ds) {
    const bits = [];
    if (['bar', 'barH', 'barStack', 'barPct'].includes(type)) {
      bits.push(`柱高为${({ mean: '均值', sum: '合计', median: '中位数', count: '计数', min: '最小值', max: '最大值' }[enc.agg || 'mean'])}`);
      if (style.errType !== 'none' && type !== 'barPct') bits.push(`误差棒为 ${({ sd: '标准差 (SD)', se: '标准误 (SEM)', ci: '95% 置信区间' }[style.errType])}`);
      if (type === 'barPct') bits.push('按行归一化为 100%');
    }
    if (['line', 'area'].includes(type)) {
      if (style.errType !== 'none') bits.push(`误差棒为 ${({ sd: '标准差 (SD)', se: '标准误 (SEM)', ci: '95% 置信区间' }[style.errType])}`);
      bits.push('同一 X 值有多次测量时自动取均值');
    }
    if (['scatter', 'bubble'].includes(type)) bits.push(style.fitLine ? '虚线为最小二乘线性拟合' : '未绘制拟合线');
    if (type === 'violin') bits.push('曲线为高斯核密度估计（Silverman 带宽），内部箱体为四分位距');
    if (type === 'heat') bits.push(`数值为 ${enc.method === 'spearman' ? 'Spearman 秩' : 'Pearson'} 相关系数，颜色由蓝（负）到红（正）；常数变量无法计算相关系数，已自动排除`);
    if (type === 'hist') bits.push('组数按平方根法则自动确定，可在样式中调整');
    bits.push(`图幅 ${style.widthMM} × ${style.heightMM} mm，字号 ${style.fontSize} pt`);
    return bits.join('；');
  }

  /* ==================== 对外接口 ==================== */
  let chartInstance = null;

  function sizeOf(style) {
    return {
      w: Math.round(style.widthMM * MM2PX),
      h: Math.round(style.heightMM * MM2PX),
    };
  }

  /** 预览时按比例放大整体尺寸，保证屏幕可读；导出始终使用真实毫米尺寸 */
  /**
   * 预览放大：画布按 k 倍渲染，字号/线宽/尺寸同比放大。
   * 注意 k 会被写回 style.k，供布局常量（grid 边距、nameGap、legend 尺寸等）
   * 一并换算——否则放大的只是文字，留白仍是原尺寸，标题就会压到刻度上。
   */
  function scaleStyle(style, k) {
    const kk = k || 1;
    return Object.assign({}, style, {
      k: kk,
      widthMM: style.widthMM * kk,
      heightMM: style.heightMM * kk,
      fontSize: style.fontSize * kk,
      lineWidth: style.lineWidth * kk,
      symbolSize: style.symbolSize * kk,
    });
  }

  function render(el, ctx) {
    const type = typeByKey(ctx.type);
    const s = scaleStyle(ctx.style, ctx.scale || 1);
    const opt = type.build(Object.assign({}, ctx, { style: s }));
    if (!opt) return null;
    const { w, h } = sizeOf(s);
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    if (!chartInstance) chartInstance = echarts.init(el, null, { renderer: 'canvas' });
    chartInstance.resize({ width: w, height: h });
    chartInstance.setOption(opt, true);
    return opt;
  }

  function currentOption() {
    return chartInstance ? chartInstance.getOption() : null;
  }

  function exportPNG(ctx, filename) {
    const type = typeByKey(ctx.type);
    const opt = type.build(ctx);
    if (!opt) return;
    const { w, h } = sizeOf(ctx.style);
    const holder = document.createElement('div');
    holder.style.cssText = `position:absolute;left:-99999px;top:0;width:${w}px;height:${h}px;`;
    document.body.appendChild(holder);
    const inst = echarts.init(holder, null, { renderer: 'canvas', width: w, height: h, devicePixelRatio: 1 });
    inst.setOption(opt, true);
    const url = inst.getDataURL({ type: 'png', pixelRatio: 600 / 96, backgroundColor: '#fff' });
    inst.dispose();
    holder.remove();
    U.download(filename || 'figure.png', dataURLtoBlob(url), 'image/png');
  }

  function dataURLtoBlob(dataurl) {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8 = new Uint8Array(n);
    while (n--) u8[n] = bstr.charCodeAt(n);
    return new Blob([u8], { type: mime });
  }

  function buildSVG(ctx) {
    const type = typeByKey(ctx.type);
    const opt = type.build(ctx);
    if (!opt) return null;
    const { w, h } = sizeOf(ctx.style);
    const holder = document.createElement('div');
    holder.style.cssText = `position:absolute;left:-99999px;top:0;width:${w}px;height:${h}px;`;
    document.body.appendChild(holder);
    const inst = echarts.init(holder, null, { renderer: 'svg', width: w, height: h });
    inst.setOption(opt, true);
    let text = '';
    try {
      if (typeof inst.renderToSVGString === 'function') text = inst.renderToSVGString();
    } catch (e) { text = ''; }
    if (!text) {
      const svg = holder.querySelector('svg');
      if (svg) text = new XMLSerializer().serializeToString(svg);
    }
    inst.dispose();
    holder.remove();
    if (!text) return null;
    // 写入真实物理尺寸，保证导入 Illustrator / Word 时大小正确
    try {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const el = doc.documentElement;
      el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!el.getAttribute('viewBox')) el.setAttribute('viewBox', `0 0 ${w} ${h}`);
      el.setAttribute('width', ctx.style.widthMM + 'mm');
      el.setAttribute('height', ctx.style.heightMM + 'mm');
      text = new XMLSerializer().serializeToString(el);
    } catch (e) { /* 保底使用原始输出 */ }
    return text;
  }

  function exportSVG(ctx, filename) {
    const text = buildSVG(ctx);
    if (!text) return false;
    U.download(filename || 'figure.svg', text, 'image/svg+xml;charset=utf-8');
    return true;
  }

  /** 按真实物理尺寸打印为 PDF（浏览器打印对话框里选择「存储为 PDF」，矢量输出） */
  function printPDF(ctx) {
    const text = buildSVG(ctx);
    if (!text) return false;
    const w = ctx.style.widthMM, h = ctx.style.heightMM;
    const win = window.open('', '_blank');
    if (!win) { U.toast('浏览器拦截了弹窗，请允许后重试', 'warn'); return false; }
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Figure</title>
<style>
@page { size: ${w}mm ${h}mm; margin: 0; }
html,body{margin:0;padding:0;}
svg{display:block;width:${w}mm;height:${h}mm;}
</style></head><body>${text}
<script>window.onload=function(){setTimeout(function(){window.print();},180);};<\/script>
</body></html>`);
    win.document.close();
    return true;
  }

  LD.charts = {
    TYPES, STYLE_DEFAULTS, FONTS, typeByKey, eligibility, columnSets, groupCandidates,
    render, buildSVG, exportPNG, exportSVG, printPDF, computeAnnotations,
    describeNote, aggregate, groupSeries, valuesOf, numsOf, colOf, sizeOf, MM2PX,
    get instance() { return chartInstance; },
    resetInstance() { if (chartInstance) { chartInstance.dispose(); chartInstance = null; } },
  };
})();
