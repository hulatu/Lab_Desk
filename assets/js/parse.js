/* LabDesk · 文件解析与类型推断 */
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;

  /* ---------- 编码解码 ---------- */
  function decodeBuffer(buf, encoding) {
    const enc = encoding || 'auto';
    if (enc !== 'auto') {
      try { return new TextDecoder(enc).decode(buf); } catch (e) { /* 回退 */ }
    }
    // 自动：先按 UTF-8 严格解码，失败则按 GB18030
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      try { return new TextDecoder('gb18030').decode(buf); } catch (e2) {
        return new TextDecoder('utf-8').decode(buf);
      }
    }
  }

  /* ---------- 分隔符探测 ---------- */
  function sniffDelimiter(text) {
    const lines = text.slice(0, 8000).split(/\r?\n/).filter((l) => l.trim()).slice(0, 50);
    const cands = ['\t', ',', ';', '|'];
    let best = ',', bestScore = -1;
    cands.forEach((d) => {
      const counts = lines.map((l) => l.split(d).length).filter((c) => c >= 2);
      // 只有 1 条「两列以上」的行不足以说明问题；至少 2 条才当成候选
      if (counts.length < 2) return;
      // 取出现最多的列数作为「真实列数」；元数据行的列数通常更少，不参与
      const freq = new Map();
      counts.forEach((c) => freq.set(c, (freq.get(c) || 0) + 1));
      let mode = 2, modeN = -1;
      freq.forEach((n, c) => { if (n > modeN || (n === modeN && c < mode)) { modeN = n; mode = c; } });
      const m = counts.reduce((a, b) => a + b, 0) / counts.length;
      const varr = counts.reduce((a, b) => a + (b - m) * (b - m), 0) / counts.length;
      // 列数越稳定、能切出的列越多，得分越高
      const score = counts.length * (mode - 1) / (1 + varr);
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  /* ---------- RFC4180 CSV 解析 ---------- */
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = '', inQuotes = false, i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // 去掉全空行
    return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  }

  /* ---------- 类型推断 ---------- */
  const DATE_RE = /^(\d{4})[-/.](\d{1,2})([-/.](\d{1,2}))?([ T](\d{1,2}):(\d{2})(:(\d{2}))?)?$/;

  function looksLikeDate(v) {
    if (v instanceof Date) return true;
    if (typeof v !== 'string') return false;
    return DATE_RE.test(v.trim());
  }

  function toDateString(v) {
    if (v instanceof Date) {
      const p = (x) => String(x).padStart(2, '0');
      return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return String(v).trim().replace(/\//g, '-').replace(/\./g, '-');
  }

  function inferType(values) {
    const nonBlank = values.filter((v) => !U.isBlank(v) && v !== '—');
    if (!nonBlank.length) return 'empty';
    let numOk = 0, dateOk = 0;
    nonBlank.forEach((v) => {
      if (typeof v === 'number') { numOk++; return; }
      if (!Number.isNaN(U.parseNum(v))) numOk++;
      if (looksLikeDate(v)) dateOk++;
    });
    if (numOk / nonBlank.length >= 0.8) return 'number';
    if (dateOk / nonBlank.length >= 0.9) return 'date';
    const uniq = new Set(nonBlank.map((v) => String(v)));
    if (uniq.size <= Math.max(30, Math.ceil(nonBlank.length * 0.5))) return 'category';
    return 'text';
  }

  function coerceColumn(values, type) {
    if (type === 'number') {
      return values.map((v) => {
        if (U.isBlank(v)) return null;
        const n = U.parseNum(v);
        return Number.isNaN(n) ? null : n;
      });
    }
    if (type === 'date') {
      return values.map((v) => (U.isBlank(v) ? null : toDateString(v)));
    }
    return values.map((v) => (U.isBlank(v) ? null : String(v).trim()));
  }

  /* ---------- 构造数据集 ---------- */
  function buildDataset(name, headerNames, rawRows, meta) {
    // 规整列名：去空、去重
    const seen = new Map();
    const names = headerNames.map((h, i) => {
      let s = String(h === null || h === undefined ? '' : h).trim();
      if (!s) s = '列' + (i + 1);
      if (seen.has(s)) {
        const c = seen.get(s) + 1;
        seen.set(s, c);
        s = s + '_' + c;
      } else seen.set(s, 1);
      return s;
    });

    const colValues = names.map((_, j) => rawRows.map((r) => r[j]));
    const columns = names.map((nm, j) => {
      const type = inferType(colValues[j]);
      return { name: nm, type };
    });

    const rows = rawRows.map((r) => columns.map((c, j) => coerceColumn([r[j]], c.type)[0]));

    // 丢弃完全空白的行
    const cleanRows = rows.filter((r) => r.some((v) => v !== null && v !== ''));

    return {
      id: U.uid(),
      name: name || '未命名数据集',
      source: (meta && meta.source) || 'file',
      meta: meta || {},
      columns,
      rows: cleanRows,
      createdAt: Date.now(),
    };
  }

  /**
   * 探测表头所在行。科研表格常在第一行写表名（多为合并单元格）或写单位说明，
   * 真正的列名在下面一两行。若直接把第一行当表头，列名会变成「列2」「列3」，
   * 数值列还会因为混入表头文字被整列判成文本——图表于是全部变灰、无法使用。
   * 规则保持保守：只有「当前行非空单元格 ≤ 1 且下一行 ≥ 2」时才下移，最多 3 行。
   */
  function detectHeaderIndex(matrix) {
    const nonEmpty = (r) => (r || []).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').length;
    // 找到第一行「有 2 个及以上非空单元格」的行，它才可能是真正的列名行
    let firstWide = -1;
    const scan = Math.min(matrix.length, 6);
    for (let r = 0; r < scan; r++) {
      if (nonEmpty(matrix[r]) >= 2) { firstWide = r; break; }
    }
    // 找不到宽行（单列表格），或第一行本身就是宽行 → 表头就在第一行
    if (firstWide <= 0) return 0;
    // 宽行之前若混有「多列内容」，说明第一行已经是正经表头，不要下移
    for (let r = 0; r < firstWide; r++) if (nonEmpty(matrix[r]) > 1) return 0;
    return firstWide;
  }

  function fromMatrix(matrix, opts) {
    const o = opts || {};
    if (!matrix.length) throw new Error('文件里没有可解析的数据行');
    const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
    const norm = matrix.map((r) => {
      const c = r.slice();
      while (c.length < width) c.push(null);
      return c;
    });
    let header, body;
    const meta = Object.assign({}, o.meta || {});
    if (o.header === false) {
      header = Array.from({ length: width }, (_, i) => '列' + (i + 1));
      body = norm;
    } else if (o.headerRow !== undefined && o.headerRow !== null && o.headerRow >= 0 && o.headerRow < norm.length) {
      // 用户手动指定的表头行优先：仪器导出的文本经常有好几行元数据
      const hi = Math.floor(o.headerRow);
      if (hi > 0) meta.skippedRows = hi;
      header = norm[hi];
      body = norm.slice(hi + 1);
    } else {
      const hi = detectHeaderIndex(norm);
      if (hi > 0) meta.skippedRows = hi;
      header = norm[hi];
      body = norm.slice(hi + 1);
    }
    return buildDataset(o.name, header, body, meta);
  }

  /* ---------- 各格式读取 ---------- */
  function readText(file, encoding) {
    return file.arrayBuffer().then((buf) => decodeBuffer(buf, encoding));
  }

  function parseTextToDataset(text, name, opts) {
    const o = opts || {};
    const delim = o.delimiter || sniffDelimiter(text);
    const matrix = parseDelimited(text, delim);
    if (!matrix.length) throw new Error('未解析到任何数据行，请检查分隔符或编码');
    const ds = fromMatrix(matrix, { header: o.header !== false, headerRow: o.headerRow, name, meta: { source: 'text', delimiter: delim } });
    ds.meta.delimiter = delim;
    return ds;
  }

  function parseJsonToDataset(text, name) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
    const arr = Array.isArray(data) ? data
      : (data && Array.isArray(data.data) ? data.data
        : (data && Array.isArray(data.rows) ? data.rows : null));
    if (!arr) throw new Error('JSON 需要是对象数组，或包含 data / rows 数组');
    if (!arr.length) throw new Error('JSON 数组为空');
    if (Array.isArray(arr[0])) {
      return fromMatrix(arr, { header: true, name, meta: { source: 'json' } });
    }
    const keys = [];
    arr.forEach((o2) => Object.keys(o2 || {}).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
    const matrix = [keys].concat(arr.map((o2) => keys.map((k) => (o2[k] === undefined ? null : o2[k]))));
    return fromMatrix(matrix, { header: true, name, meta: { source: 'json' } });
  }

  function parseWorkbook(buf, name, opts) {
    if (typeof XLSX === 'undefined') throw new Error('表格解析库未加载');
    const o = opts || {};
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true, cellNF: false, cellText: false });
    const out = [];
    wb.SheetNames.forEach((sn) => {
      const ws = wb.Sheets[sn];
      if (!ws || !ws['!ref']) return;
      const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      if (!matrix.length) return;
      try {
        const ds = fromMatrix(matrix, {
          header: true,
          headerRow: o.headerRow,
          name: wb.SheetNames.length > 1 ? `${name} · ${sn}` : name,
          meta: { source: 'excel', sheet: sn },
        });
        if (ds.rows.length) out.push(ds);
      } catch (e) { /* 跳过空表 */ }
    });
    if (!out.length) throw new Error('工作簿中没有可用数据');
    return out;
  }

  /* ---------- 统一入口 ---------- */
  function readFile(file, opts) {
    const o = opts || {};
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const baseName = file.name.replace(/\.[^.]+$/, '');

    if (ext === 'numbers') {
      return Promise.reject(new Error('Apple Numbers 的 .numbers 是专有二进制格式，浏览器无法直接解析。请在 Numbers 中「文件 → 导出为 → Excel」后再导入。'));
    }
    if (ext === 'sav' || ext === 'dta' || ext === 'sas7bdat') {
      return Promise.reject(new Error(`.${ext} 是统计软件专有格式。请在 SPSS / Stata / SAS 中导出为 CSV 或 XLSX 后再导入。`));
    }
    if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'ods') {
      return file.arrayBuffer().then((buf) => parseWorkbook(buf, baseName, { headerRow: o.headerRow }));
    }
    if (ext === 'json') {
      return readText(file, 'utf-8').then((t) => [parseJsonToDataset(t, baseName)]);
    }
    // 其余按分隔文本处理
    return readText(file, o.encoding).then((text) => {
      // Excel 导出的 UTF-8 BOM
      const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
      return [parseTextToDataset(clean, baseName, { header: o.header, headerRow: o.headerRow, encoding: o.encoding })];
    });
  }

  /* ---------- 示例数据 ---------- */
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function sampleCatalyst() {
    const r = rng(20240501);
    const header = ['催化剂', '温度_℃', '时间_h', '产率_%', '选择性_%', '批次'];
    const rows = [];
    const cats = ['Cat-A', 'Cat-B', 'Cat-C'];
    const temps = [60, 80, 100];
    cats.forEach((cat, ci) => {
      temps.forEach((t) => {
        for (let rep = 1; rep <= 6; rep++) {
          const base = 52 + ci * 4.5 + (t - 60) * 0.42;
          const y = base + gauss(r) * 3.2;
          const sel = 88 + ci * 1.6 - (t - 60) * 0.05 + gauss(r) * 1.8;
          // 高温段缩短保温时间：让「时间」是真实有变异的协变量，而不是一列常数
          const tH = (t === 60 ? 3.0 : t === 80 ? 2.0 : 1.4) + gauss(r) * 0.12;
          rows.push([cat, t, +Math.max(0.5, tH).toFixed(2), +y.toFixed(2), +Math.min(99.9, sel).toFixed(2), 'B' + rep]);
        }
      });
    });
    return fromMatrix([header].concat(rows), { header: true, name: '示例 · 催化剂产率', meta: { source: 'sample' } });
  }

  function sampleGrowth() {
    const r = rng(778899);
    const header = ['时间_h', '对照组', '低剂量组', '中剂量组', '高剂量组'];
    const rows = [];
    for (let t = 0; t <= 24; t += 2) {
      const base = 0.08 * Math.exp(0.22 * t);
      rows.push([
        t,
        +(base + gauss(r) * 0.03).toFixed(3),
        +(base * 0.92 + gauss(r) * 0.03).toFixed(3),
        +(base * 0.74 + gauss(r) * 0.03).toFixed(3),
        +(base * 0.55 + gauss(r) * 0.03).toFixed(3),
      ]);
    }
    return fromMatrix([header].concat(rows), { header: true, name: '示例 · 生长曲线', meta: { source: 'sample' } });
  }

  function sampleMulti() {
    const r = rng(31415926);
    const header = ['样品编号', '烧结温度_℃', '保温时间_min', '晶粒尺寸_nm', '致密度_%', '硬度_HV', '抗弯强度_MPa', '孔隙率_%'];
    const rows = [];
    for (let i = 1; i <= 36; i++) {
      const temp = 1300 + Math.round(r() * 8) * 25;
      const hold = 30 + Math.round(r() * 6) * 15;
      const grain = 180 + (temp - 1300) * 0.42 + hold * 0.8 + gauss(r) * 22;
      const density = 99.2 - Math.max(0, (temp - 1500)) * 0.004 - Math.abs(gauss(r)) * 0.6;
      const hardness = 12.5 + grain * 0.012 + density * 0.15 + gauss(r) * 0.6;
      const strength = 480 + hardness * 18 + gauss(r) * 28;
      const porosity = Math.max(0.05, 100 - density + gauss(r) * 0.15);
      rows.push([
        'S' + String(i).padStart(2, '0'), temp, hold,
        +grain.toFixed(1), +Math.min(99.9, density).toFixed(2),
        +hardness.toFixed(1), +strength.toFixed(0), +porosity.toFixed(2),
      ]);
    }
    return fromMatrix([header].concat(rows), { header: true, name: '示例 · 陶瓷烧结多指标', meta: { source: 'sample' } });
  }

  function sampleTreated() {
    const r = rng(606060);
    const header = ['处理组', '重复', '酶活_U/mL', '蛋白浓度_mg/mL'];
    const rows = [];
    [['空白对照', 42, 4.2], ['低浓度', 55, 4.1], ['中浓度', 68, 3.9], ['高浓度', 61, 4.0]].forEach((g) => {
      for (let i = 1; i <= 8; i++) {
        rows.push([g[0], i, +(g[1] + gauss(r) * 4.5).toFixed(1), +(g[2] + gauss(r) * 0.25).toFixed(2)]);
      }
    });
    return fromMatrix([header].concat(rows), { header: true, name: '示例 · 四组酶活', meta: { source: 'sample' } });
  }

  LD.parse = {
    readFile, parseTextToDataset, parseJsonToDataset, buildDataset, fromMatrix,
    inferType, coerceColumn, decodeBuffer, sniffDelimiter, parseDelimited,
    SAMPLES: [
      { key: 'catalyst', name: '催化剂产率（3 催化剂 × 3 温度 × 6 重复）', desc: '单因素方差分析 + 带误差棒柱状图', make: sampleCatalyst },
      { key: 'treated', name: '四组酶活对比（每组 8 重复）', desc: '多组比较、非参数检验、箱线图', make: sampleTreated },
      { key: 'growth', name: '生长曲线（时间序列 4 组）', desc: '折线图、双因素趋势', make: sampleGrowth },
      { key: 'multi', name: '陶瓷烧结多指标（36 样品 8 变量）', desc: '相关热力图、多元回归', make: sampleMulti },
    ],
  };
})();
