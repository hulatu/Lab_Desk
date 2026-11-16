/* LabDesk · 数据整理操作流水线
   每个操作都是纯函数，按顺序作用于工作副本；原始数据永不被修改。
*/
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;
  const S = LD.stats;

  const clone = (ds) => ({
    id: ds.id,
    name: ds.name,
    source: ds.source,
    meta: ds.meta,
    createdAt: ds.createdAt,
    columns: ds.columns.map((c) => ({ ...c })),
    rows: ds.rows.map((r) => r.slice()),
  });

  function colIndex(ds, name) {
    return ds.columns.findIndex((c) => c.name === name);
  }

  function numCols(ds) {
    return ds.columns.filter((c) => c.type === 'number').map((c) => c.name);
  }

  /* ---------- 表达式编译 ---------- */
  const FN = {
    ln: Math.log, log: Math.log, log10: Math.log10, log2: Math.log2,
    exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs, pow: Math.pow,
    min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    PI: Math.PI, E: Math.E,
    round: (x, d) => {
      if (!isFinite(x)) return x;
      const m = Math.pow(10, d || 0);
      return Math.round(x * m) / m;
    },
    ifnull: (a, b) => (a === null || a === undefined || Number.isNaN(a) ? b : a),
    sq: (x) => x * x,
    inv: (x) => 1 / x,
    pct: (x) => x * 100,
  };

  /**
   * 计算列表达式白名单。
   *
   * 这里必须拦一道：表达式最终会进 `new Function`，而工程文件可以被分享、
   * 被导入。若不加限制，别人发来的一个 .json 就能在打开工程时执行任意 JS。
   * 只允许「列引用 + 数字 + 四则/比较运算 + 内置函数名」，赋值、箭头函数、
   * 引号、花括号、分号、反引号一律拒绝。
   */
  const ALLOWED_IDS = new Set(Object.keys(FN).concat(['true', 'false', 'null', 'Infinity', 'NaN']));

  function sanitizeExpr(expr) {
    const src = String(expr === undefined || expr === null ? '' : expr);
    if (!src.trim()) throw new Error('表达式不能为空');
    if (src.length > 500) throw new Error('表达式过长（上限 500 字符）');
    // 列引用里可能有中文、空格、括号，先整体替换掉再检查
    const stripped = src.replace(/\[[^\]]*\]/g, '0');
    if (/[;{}\[\]'"`\\]/.test(stripped)) {
      throw new Error('表达式只能包含列名 [列名]、数字、运算符和内置函数');
    }
    // 逐个扫描标识符；跳过数字内部的 e（1e-3）和紧跟在数字/小数点后的片段，
    // 否则 log10 会被数字处理误伤，1e-3 里的 e 又会被当成函数名
    const ids = [];
    const re = /[A-Za-z_][A-Za-z0-9_]*/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      if (m.index > 0 && /[0-9.]/.test(stripped[m.index - 1])) continue;
      ids.push(m[0]);
    }
    ids.forEach((id) => {
      if (!ALLOWED_IDS.has(id)) {
        throw new Error(`不允许的标识符「${id}」。可用函数：${Object.keys(FN).join('、')}`);
      }
    });
    // 赋值不在白名单里；==、>=、<=、!= 这类比较放行
    if (/(^|[^<>=!])=([^=]|$)/.test(stripped) || /=>/.test(stripped)) {
      throw new Error('表达式不支持赋值，请写成 [列名] * 2 这样的纯表达式');
    }
    return src;
  }

  function compileExpr(expr, ds) {
    const names = ds.columns.map((c) => c.name);
    const safe = sanitizeExpr(expr);
    const replaced = safe.replace(/\[([^\]]+)\]/g, (m, nm) => {
      const t = nm.trim();
      if (!names.includes(t)) throw new Error(`找不到列「${t}」`);
      return `__g(${JSON.stringify(t)})`;
    });
    let fn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function('__g', '__f', `with(__f){ return (${replaced}); }`);
    } catch (e) {
      throw new Error('表达式语法错误：' + e.message);
    }
    return (getter) => fn(getter, FN);
  }

  /* ---------- 单步操作 ---------- */
  const OPS = {
    settype(p, ds) {
      const i = colIndex(ds, p.col);
      if (i < 0) return ds;
      ds.columns[i].type = p.type;
      const vals = ds.rows.map((r) => r[i]);
      const coerced = LD.parse.coerceColumn(vals, p.type);
      ds.rows.forEach((r, k) => { r[i] = coerced[k]; });
      return ds;
    },

    rename(p, ds) {
      const i = colIndex(ds, p.col);
      if (i >= 0) ds.columns[i].name = p.name || ds.columns[i].name;
      return ds;
    },

    dropcol(p, ds) {
      const drop = (p.cols || []);
      if (!drop.length) return ds;
      const keep = ds.columns.map((c, i) => (drop.includes(c.name) ? -1 : i)).filter((i) => i >= 0);
      ds.columns = keep.map((i) => ds.columns[i]);
      ds.rows = ds.rows.map((r) => keep.map((i) => r[i]));
      return ds;
    },

    filter(p, ds) {
      const i = colIndex(ds, p.col);
      if (i < 0) return ds;
      const isNum = ds.columns[i].type === 'number';
      const target = isNum ? U.parseNum(p.value) : String(p.value === undefined ? '' : p.value);
      ds.rows = ds.rows.filter((r) => {
        const v = r[i];
        switch (p.op) {
          case 'isnull': return v === null || v === '';
          case 'notnull': return !(v === null || v === '');
          case 'eq': return isNum ? v === target : String(v) === String(target);
          case 'ne': return isNum ? v !== target : String(v) !== String(target);
          case 'gt': return v !== null && v > target;
          case 'ge': return v !== null && v >= target;
          case 'lt': return v !== null && v < target;
          case 'le': return v !== null && v <= target;
          case 'contains': return v !== null && String(v).includes(String(p.value));
          case 'ncontains': return v !== null && !String(v).includes(String(p.value));
          default: return true;
        }
      });
      return ds;
    },

    missing(p, ds) {
      const cols = (p.cols && p.cols.length ? p.cols : ds.columns.map((c) => c.name));
      const idxs = cols.map((n) => colIndex(ds, n)).filter((i) => i >= 0);
      if (p.action === 'drop') {
        ds.rows = ds.rows.filter((r) => idxs.every((i) => !(r[i] === null || r[i] === '' || (typeof r[i] === 'number' && !isFinite(r[i])))));
        return ds;
      }
      idxs.forEach((i) => {
        const vals = ds.rows.map((r) => r[i]);
        const isNum = ds.columns[i].type === 'number';
        let fill = null;
        if (p.action === 'mean' || p.action === 'median') {
          const nums = vals.filter(S.num);
          if (nums.length) fill = p.action === 'mean' ? S.mean(nums) : S.quantile(nums.slice().sort((a, b) => a - b), 0.5);
        } else if (p.action === 'mode') {
          const m = new Map();
          vals.forEach((v) => { if (v !== null && v !== '') m.set(v, (m.get(v) || 0) + 1); });
          let best = null, bc = -1;
          m.forEach((c, v) => { if (c > bc) { bc = c; best = v; } });
          fill = best;
        } else if (p.action === 'zero') fill = isNum ? 0 : '';
        else if (p.action === 'value') fill = isNum ? U.parseNum(p.value) : p.value;

        if (p.action === 'interp') {
          const ys = vals.slice();
          let lastGood = -1;
          for (let k = 0; k < ys.length; k++) {
            if (S.num(ys[k])) { lastGood = k; continue; }
            let next = -1;
            for (let m2 = k + 1; m2 < ys.length; m2++) if (S.num(ys[m2])) { next = m2; break; }
            if (lastGood >= 0 && next >= 0) {
              const v0 = ys[lastGood], v1 = ys[next];
              const step = (v1 - v0) / (next - lastGood);
              ys[k] = v0 + step * (k - lastGood);
            } else if (lastGood >= 0) ys[k] = ys[lastGood];
            else if (next >= 0) ys[k] = ys[next];
            else ys[k] = 0;
          }
          ys.forEach((v, k) => { ds.rows[k][i] = v; });
          return;
        }
        if (p.action === 'ffill') {
          let prev = null;
          ds.rows.forEach((r) => {
            if (r[i] === null || r[i] === '') { if (prev !== null) r[i] = prev; }
            else prev = r[i];
          });
          return;
        }
        ds.rows.forEach((r) => {
          if (r[i] === null || r[i] === '' || (typeof r[i] === 'number' && !isFinite(r[i]))) r[i] = fill;
        });
      });
      return ds;
    },

    outlier(p, ds) {
      const cols = (p.cols && p.cols.length ? p.cols : numCols(ds));
      cols.forEach((nm) => {
        const i = colIndex(ds, nm);
        if (i < 0 || ds.columns[i].type !== 'number') return;
        const vals = ds.rows.map((r) => r[i]).filter(S.num);
        if (vals.length < 4) return;
        let lo, hi;
        if (p.method === 'z') {
          const m = S.mean(vals), s = S.sd(vals);
          const k = p.k || 3;
          lo = m - k * s; hi = m + k * s;
        } else if (p.method === 'mad') {
          const med = S.quantile(vals.slice().sort((a, b) => a - b), 0.5);
          const mad = S.quantile(vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b), 0.5);
          const k = p.k || 3.5;
          lo = med - k * 1.4826 * mad; hi = med + k * 1.4826 * mad;
        } else {
          const sx = vals.slice().sort((a, b) => a - b);
          const q1 = S.quantile(sx, 0.25), q3 = S.quantile(sx, 0.75);
          const iqr = q3 - q1, k = p.k || 1.5;
          lo = q1 - k * iqr; hi = q3 + k * iqr;
        }
        if (p.action === 'remove') {
          ds.rows = ds.rows.filter((r) => !(S.num(r[i]) && (r[i] < lo || r[i] > hi)));
        } else if (p.action === 'winsor') {
          ds.rows.forEach((r) => {
            if (S.num(r[i])) r[i] = Math.min(hi, Math.max(lo, r[i]));
          });
        } else {
          const flagName = '异常_' + nm;
          let fi = colIndex(ds, flagName);
          if (fi < 0) {
            ds.columns.push({ name: flagName, type: 'category' });
            ds.rows.forEach((r) => r.push('否'));
            fi = ds.columns.length - 1;
          }
          ds.rows.forEach((r) => {
            r[fi] = S.num(r[i]) && (r[i] < lo || r[i] > hi) ? '是' : '否';
          });
        }
      });
      return ds;
    },

    dedupe(p, ds) {
      const idxs = (p.cols && p.cols.length ? p.cols : ds.columns.map((c) => c.name)).map((n) => colIndex(ds, n)).filter((i) => i >= 0);
      const seen = new Set();
      ds.rows = ds.rows.filter((r) => {
        const key = idxs.map((i) => String(r[i])).join('\u0001');
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      return ds;
    },

    sort(p, ds) {
      const i = colIndex(ds, p.col);
      if (i < 0) return ds;
      const dir = p.desc ? -1 : 1;
      const isNum = ds.columns[i].type === 'number';
      ds.rows.sort((a, b) => {
        const va = a[i], vb = b[i];
        if (va === null || va === '') return 1;
        if (vb === null || vb === '') return -1;
        if (isNum) return (va - vb) * dir;
        return String(va).localeCompare(String(vb), 'zh') * dir;
      });
      return ds;
    },

    derive(p, ds) {
      const expr = compileExpr(p.expr, ds);
      const getter = (nm) => {
        const i = colIndex(ds, nm);
        return i;
      };
      const out = ds.rows.map((r) => {
        let v;
        try {
          v = expr((nm) => {
            const i = getter(nm);
            const raw = r[i];
            return typeof raw === 'number' ? raw : U.parseNum(raw);
          });
        } catch (e) { v = null; }
        if (typeof v === 'number') return isFinite(v) ? v : null;
        return v === undefined ? null : v;
      });
      const name = p.name || '新列';
      let i = colIndex(ds, name);
      if (i < 0) {
        ds.columns.push({ name, type: LD.parse.inferType(out) });
        ds.rows.forEach((r, k) => r.push(out[k]));
      } else {
        ds.columns[i].type = LD.parse.inferType(out);
        ds.rows.forEach((r, k) => { r[i] = out[k]; });
      }
      return ds;
    },

    transform(p, ds) {
      const cols = (p.cols && p.cols.length ? p.cols : []);
      const map = {
        log10: (v) => (v > 0 ? Math.log10(v) : null),
        ln: (v) => (v > 0 ? Math.log(v) : null),
        log1p: (v) => (v > -1 ? Math.log1p(v) : null),
        sqrt: (v) => (v >= 0 ? Math.sqrt(v) : null),
        abs: (v) => Math.abs(v),
        square: (v) => v * v,
        reciprocal: (v) => (v !== 0 ? 1 / v : null),
        center: null, zscore: null, minmax: null,
      };
      cols.forEach((nm) => {
        const i = colIndex(ds, nm);
        if (i < 0 || ds.columns[i].type !== 'number') return;
        const vals = ds.rows.map((r) => r[i]).filter(S.num);
        if (!vals.length) return;
        const m = S.mean(vals);
        let s = S.sd(vals);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const f = map[p.method];
        const outName = p.newCol ? nm + '_' + p.method : nm;
        const out = ds.rows.map((r) => {
          const v = r[i];
          if (!S.num(v)) return null;
          if (f) return f(v);
          if (p.method === 'center') return v - m;
          if (p.method === 'zscore') return s > 0 ? (v - m) / s : 0;
          if (p.method === 'minmax') return hi > lo ? (v - lo) / (hi - lo) : 0;
          return v;
        });
        if (p.newCol) {
          ds.columns.push({ name: outName, type: 'number' });
          ds.rows.forEach((r, k) => r.push(out[k]));
        } else {
          ds.rows.forEach((r, k) => { r[i] = out[k]; });
          ds.columns[i].name = outName;
        }
      });
      return ds;
    },

    round(p, ds) {
      const cols = (p.cols && p.cols.length ? p.cols : numCols(ds));
      const d = parseInt(p.digits, 10) || 0;
      const m = Math.pow(10, d);
      cols.forEach((nm) => {
        const i = colIndex(ds, nm);
        if (i < 0) return;
        ds.rows.forEach((r) => { if (S.num(r[i])) r[i] = Math.round(r[i] * m) / m; });
      });
      return ds;
    },

    bin(p, ds) {
      const i = colIndex(ds, p.col);
      if (i < 0) return ds;
      const vals = ds.rows.map((r) => r[i]).filter(S.num);
      if (!vals.length) return ds;
      const k = Math.max(2, parseInt(p.bins, 10) || 4);
      const name = p.name || (p.col + '_分组');
      let edges;
      if (p.method === 'quantile') {
        const sx = vals.slice().sort((a, b) => a - b);
        edges = [];
        for (let q = 0; q <= k; q++) edges.push(S.quantile(sx, q / k));
      } else {
        const lo = Math.min(...vals), hi = Math.max(...vals);
        edges = Array.from({ length: k + 1 }, (_, q) => lo + (hi - lo) * q / k);
      }
      const out = ds.rows.map((r) => {
        const v = r[i];
        if (!S.num(v)) return null;
        for (let b = 0; b < edges.length - 1; b++) {
          if (v <= edges[b + 1] || b === edges.length - 2) {
            return `[${U.fmt(edges[b], 2)}, ${U.fmt(edges[b + 1], 2)}]`;
          }
        }
        return null;
      });
      ds.columns.push({ name, type: 'category' });
      ds.rows.forEach((r, k2) => r.push(out[k2]));
      return ds;
    },

    aggregate(p, ds) {
      const gNames = p.groupBy && p.groupBy.length ? p.groupBy : [ds.columns[0].name];
      const gIdx = gNames.map((n) => colIndex(ds, n)).filter((i) => i >= 0);
      const aggs = (p.aggs && p.aggs.length) ? p.aggs : [{ col: numCols(ds)[0], fn: 'mean' }];
      const map = new Map();
      ds.rows.forEach((r) => {
        const key = gIdx.map((i) => String(r[i])).join('\u0001');
        if (!map.has(key)) map.set(key, { keys: gIdx.map((i) => r[i]), items: [] });
        map.get(key).items.push(r);
      });
      const fnMap = {
        mean: (v) => S.mean(v), sd: (v) => S.sd(v), se: (v) => S.sd(v) / Math.sqrt(v.length),
        count: (v) => v.length, sum: (v) => v.reduce((a, b) => a + b, 0),
        median: (v) => S.quantile(v.slice().sort((a, b) => a - b), 0.5),
        min: (v) => Math.min(...v), max: (v) => Math.max(...v),
        cv: (v) => (S.mean(v) ? S.sd(v) / Math.abs(S.mean(v)) : null),
      };
      const label = { mean: '均值', sd: '标准差', se: '标准误', count: 'n', sum: '合计', median: '中位数', min: '最小', max: '最大', cv: 'CV' };
      const newCols = gNames.map((n) => ({ name: n, type: ds.columns[colIndex(ds, n)].type }))
        .concat(aggs.map((a) => ({ name: `${a.col}_${label[a.fn] || a.fn}`, type: 'number' })));
      const rows = [];
      map.forEach((g) => {
        const base = g.keys.slice();
        aggs.forEach((a) => {
          const i = colIndex(ds, a.col);
          const vals = g.items.map((r) => r[i]).filter(S.num);
          base.push(vals.length ? fnMap[a.fn](vals) : null);
        });
        rows.push(base);
      });
      return { columns: newCols, rows };
    },

    melt(p, ds) {
      const ids = (p.idCols && p.idCols.length) ? p.idCols : [ds.columns[0].name];
      const vals = (p.valueCols && p.valueCols.length) ? p.valueCols : numCols(ds).filter((n) => !ids.includes(n));
      const idIdx = ids.map((n) => colIndex(ds, n)).filter((i) => i >= 0);
      const valIdx = vals.map((n) => colIndex(ds, n)).filter((i) => i >= 0);
      const varName = p.varName || '变量';
      const valName = p.valName || '数值';
      const cols = ids.map((n) => ({ name: n, type: ds.columns[colIndex(ds, n)].type }))
        .concat([{ name: varName, type: 'category' }, { name: valName, type: 'number' }]);
      const rows = [];
      ds.rows.forEach((r) => {
        valIdx.forEach((vi) => {
          rows.push(idIdx.map((i) => r[i]).concat([ds.columns[vi].name, S.num(r[vi]) ? r[vi] : U.parseNum(r[vi]) || null]));
        });
      });
      return { columns: cols, rows };
    },

    pivot(p, ds) {
      const idI = colIndex(ds, p.idCol), varI = colIndex(ds, p.varCol), valI = colIndex(ds, p.valCol);
      if (idI < 0 || varI < 0 || valI < 0) return ds;
      const cats = Array.from(new Set(ds.rows.map((r) => String(r[varI]))));
      const map = new Map();
      ds.rows.forEach((r) => {
        const key = String(r[idI]);
        if (!map.has(key)) map.set(key, {});
        map.get(key)[String(r[varI])] = r[valI];
      });
      const cols = [{ name: ds.columns[idI].name, type: ds.columns[idI].type }]
        .concat(cats.map((c) => ({ name: c, type: 'number' })));
      const rows = [];
      map.forEach((obj, key) => {
        rows.push([key].concat(cats.map((c) => (obj[c] === undefined ? null : obj[c]))));
      });
      return { columns: cols, rows };
    },

    sampleRows(p, ds) {
      const n = Math.max(1, parseInt(p.n, 10) || 100);
      if (p.method === 'random') {
        const arr = ds.rows.slice();
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        ds.rows = arr.slice(0, n);
      } else {
        ds.rows = ds.rows.slice(0, n);
      }
      return ds;
    },
  };

  /* ---------- 应用流水线 ---------- */
  function apply(dataset, pipeline) {
    let ds = clone(dataset);
    const errors = [];
    (pipeline || []).forEach((step, i) => {
      const fn = OPS[step.type];
      if (!fn) return;
      try {
        const next = fn(step.params || {}, ds);
        // 结构性操作（分组汇总 / 宽长表转换）会返回新的数据集对象，需保留元信息
        if (next && !next.name && ds) {
          ds = Object.assign({ id: ds.id, name: ds.name, source: ds.source, meta: ds.meta, createdAt: ds.createdAt }, next);
        } else {
          ds = next;
        }
      } catch (e) {
        errors.push({ index: i, type: step.type, message: e.message });
      }
    });
    return { dataset: ds, errors };
  }

  /* ---------- 操作定义（驱动界面） ---------- */
  const OP_DEFS = [
    {
      key: 'missing', title: '缺失值处理', desc: '删除含缺失的行，或用均值 / 中位数 / 线性插值补齐。',
      fields: [
        { k: 'cols', label: '作用列', type: 'multicol' },
        { k: 'action', label: '处理方式', type: 'select', options: [['drop', '删除该行'], ['mean', '均值填充'], ['median', '中位数填充'], ['mode', '众数填充'], ['zero', '填 0'], ['ffill', '沿用上一行'], ['interp', '线性插值'], ['value', '填指定值']] },
        { k: 'value', label: '指定值', type: 'text', when: (v) => v.action === 'value' },
      ],
      summarize: (p) => `缺失值处理：${({ drop: '删除行', mean: '均值', median: '中位数', mode: '众数', zero: '填 0', ffill: '前值', interp: '线性插值', value: '指定值' }[p.action] || p.action)}${p.cols && p.cols.length ? `（${p.cols.length} 列）` : '（全部列）'}`,
    },
    {
      key: 'outlier', title: '异常值处理', desc: '按 IQR、Z 分数或 MAD 识别离群点，可标记、删除或缩尾。',
      fields: [
        { k: 'cols', label: '作用列', type: 'multicol' },
        { k: 'method', label: '判别方法', type: 'select', options: [['iqr', 'IQR（1.5 倍四分位距）'], ['z', 'Z 分数'], ['mad', 'MAD 稳健 Z']] },
        { k: 'k', label: '阈值倍数', type: 'number', def: 1.5, step: 0.5 },
        { k: 'action', label: '处理方式', type: 'select', options: [['flag', '新增标记列'], ['remove', '删除该行'], ['winsor', '缩尾（Winsorize）']] },
      ],
      summarize: (p) => `异常值：${({ iqr: 'IQR', z: 'Z 分数', mad: 'MAD' }[p.method] || p.method)}，${({ flag: '标记', remove: '删除', winsor: '缩尾' }[p.action] || p.action)}`,
    },
    {
      key: 'transform', title: '变量变换', desc: '对数、开方、标准化、归一化——让偏态数据更接近正态，或消除量纲。',
      fields: [
        { k: 'cols', label: '作用列', type: 'multicol' },
        { k: 'method', label: '变换方式', type: 'select', options: [['log10', 'log10'], ['ln', '自然对数 ln'], ['log1p', 'log(1+x)'], ['sqrt', '平方根'], ['square', '平方'], ['abs', '绝对值'], ['reciprocal', '倒数 1/x'], ['zscore', 'Z 标准化'], ['minmax', 'Min-Max 归一化'], ['center', '中心化']] },
        { k: 'newCol', label: '生成新列', type: 'checkbox', def: true },
      ],
      summarize: (p) => `变量变换：${p.method}${p.newCol ? '（新建列）' : '（原地替换）'}`,
    },
    {
      key: 'derive', title: '计算列', desc: '用表达式派生新列，如 [质量_g]/[体积_mL]。支持 log10、sqrt、ifnull 等函数。',
      fields: [
        { k: 'name', label: '新列名', type: 'text', def: '新变量' },
        { k: 'expr', label: '表达式', type: 'text', placeholder: '如：[硬度_HV] * 9.807' },
      ],
      summarize: (p) => `计算列：${p.name} = ${p.expr}`,
    },
    {
      key: 'bin', title: '数值分箱', desc: '把连续变量切成若干区间，变成可用于分组的分类变量。',
      fields: [
        { k: 'col', label: '目标列', type: 'column', numOnly: true },
        { k: 'bins', label: '区间数', type: 'number', def: 4 },
        { k: 'method', label: '切分方式', type: 'select', options: [['equal', '等宽'], ['quantile', '等频（四分位）']] },
        { k: 'name', label: '新列名', type: 'text', def: '分组' },
      ],
      summarize: (p) => `数值分箱：${p.col} → ${p.bins} 组`,
    },
    {
      key: 'filter', title: '筛选行', desc: '按条件保留子集，例如只保留温度 ≥ 80 ℃ 的批次。',
      fields: [
        { k: 'col', label: '条件列', type: 'column' },
        { k: 'op', label: '条件', type: 'select', options: [['gt', '>'], ['ge', '≥'], ['lt', '<'], ['le', '≤'], ['eq', '='], ['ne', '≠'], ['contains', '包含'], ['ncontains', '不包含'], ['isnull', '为空'], ['notnull', '非空']] },
        {
          k: 'value', label: '比较值', type: 'text', when: (v) => !['isnull', 'notnull'].includes(v.op),
          // 分类列的取值就那么几个，直接当候选列出来，省得用户猜要填什么
          suggest: (v, ds) => {
            const i = ds.columns.findIndex((c) => c.name === v.col);
            if (i < 0 || ds.columns[i].type === 'number') return [];
            const set = new Set();
            ds.rows.forEach((r) => { if (r[i] !== null && r[i] !== undefined && r[i] !== '') set.add(String(r[i])); });
            return set.size <= 80 ? [...set].sort() : [];
          },
        },
      ],
      summarize: (p) => `筛选：${p.col} ${({ gt: '>', ge: '≥', lt: '<', le: '≤', eq: '=', ne: '≠', contains: '包含', ncontains: '不包含', isnull: '为空', notnull: '非空' }[p.op])} ${p.value === undefined ? '' : p.value}`,
    },
    {
      key: 'dedupe', title: '删除重复行', desc: '按全部列或指定列判重，仅保留首次出现。',
      fields: [{ k: 'cols', label: '判重列', type: 'multicol' }],
      summarize: (p) => `删除重复行${p.cols && p.cols.length ? `（按 ${p.cols.length} 列）` : '（全部列）'}`,
    },
    {
      key: 'sort', title: '排序', desc: '按某一列升序或降序排列，常用于让折线图按时间顺序连接。',
      fields: [
        { k: 'col', label: '排序列', type: 'column' },
        { k: 'desc', label: '降序', type: 'checkbox', def: false },
      ],
      summarize: (p) => `排序：${p.col} ${p.desc ? '降序' : '升序'}`,
    },
    {
      key: 'aggregate', title: '分组汇总', desc: '按分组变量算出均值、标准差、标准误等，直接得到作图用的汇总表。统计量可以多选，一次把误差棒要用的数据都算齐。',
      fields: [
        { k: 'groupBy', label: '分组列', type: 'multicol', catOnly: true },
        { k: 'aggCol', label: '统计列', type: 'column', numOnly: true },
        {
          k: 'aggFns', label: '统计量（可多选）', type: 'checks', def: ['mean', 'sd', 'count'],
          options: [['mean', '均值'], ['sd', '标准差'], ['se', '标准误'], ['count', '计数 n'], ['median', '中位数'], ['sum', '合计'], ['min', '最小值'], ['max', '最大值'], ['cv', '变异系数']],
        },
      ],
      summarize: (p) => {
        const aggs = (p.aggs && p.aggs.length) ? p.aggs : [{ col: p.aggCol, fn: p.aggFn || 'mean' }];
        const label = { mean: '均值', sd: '标准差', se: '标准误', count: '计数', sum: '合计', min: '最小值', max: '最大值', median: '中位数', cv: 'CV' };
        const names = aggs.map((a) => label[a.fn] || a.fn).join(' + ');
        const g = (p.groupBy && p.groupBy.length) ? p.groupBy.join('、') : '第一列';
        return `分组汇总：按 ${g} 计算 ${aggs[0].col} 的${names}`;
      },
      build: (v) => ({
        groupBy: v.groupBy || [],
        aggs: ((v.aggFns && v.aggFns.length) ? v.aggFns : ['mean']).map((fn) => ({ col: v.aggCol, fn })),
      }),
    },
    {
      key: 'melt', title: '宽表转长表', desc: '把多列测量值合并成「变量 / 数值」两列，这是多组折线图与分组的通用格式。',
      fields: [
        { k: 'idCols', label: '保留列', type: 'multicol' },
        { k: 'valueCols', label: '转为数值的列', type: 'multicol' },
        { k: 'varName', label: '变量名列名', type: 'text', def: '变量' },
        { k: 'valName', label: '数值列名', type: 'text', def: '数值' },
      ],
      summarize: (p) => `宽表转长表：${(p.valueCols || []).length} 列合并为「${p.varName || '变量'} / ${p.valName || '数值'}」`,
    },
    {
      key: 'pivot', title: '长表转宽表', desc: '把某一列的不同取值展开为多个列，便于做相关矩阵或并列比较。',
      fields: [
        { k: 'idCol', label: '标识列', type: 'column' },
        { k: 'varCol', label: '展开列', type: 'column' },
        { k: 'valCol', label: '数值列', type: 'column', numOnly: true },
      ],
      summarize: (p) => `长表转宽表：按 ${p.varCol} 展开 ${p.valCol}`,
    },
    {
      key: 'round', title: '有效数字', desc: '统一保留位数，避免导出后出现 0.30000000000000004 这类浮点噪声。',
      fields: [
        { k: 'cols', label: '作用列', type: 'multicol' },
        { k: 'digits', label: '保留小数位', type: 'number', def: 2 },
      ],
      summarize: (p) => `保留 ${p.digits} 位小数`,
    },
    {
      key: 'dropcol', title: '删除列', desc: '移除无关列，让后续的变量选择列表更干净。',
      fields: [{ k: 'cols', label: '删除列', type: 'multicol' }],
      summarize: (p) => `删除列：${(p.cols || []).join('、')}`,
    },
    {
      key: 'rename', title: '重命名列', desc: '把仪器导出的乱码列名改成可读名称，报告与图注会直接使用新名字。',
      fields: [
        { k: 'col', label: '原列名', type: 'column' },
        { k: 'name', label: '新列名', type: 'text' },
      ],
      summarize: (p) => `重命名：${p.col} → ${p.name}`,
    },
    {
      key: 'sampleRows', title: '抽样 / 截取', desc: '数据量很大时抽取前 N 行或随机 N 行，用于快速试算。',
      fields: [
        { k: 'n', label: '行数', type: 'number', def: 100 },
        { k: 'method', label: '方式', type: 'select', options: [['head', '前 N 行'], ['random', '随机抽样']] },
      ],
      summarize: (p) => `${p.method === 'random' ? '随机抽样' : '截取前'} ${p.n} 行`,
    },
  ];

  function summarize(step) {
    if (step.type === 'settype') {
      const label = { number: '数值', category: '分类', text: '文本', date: '日期' }[step.params.type] || step.params.type;
      return `列类型：${step.params.col} → ${label}`;
    }
    const def = OP_DEFS.find((d) => d.key === step.type);
    if (!def) return step.type;
    try { return def.summarize(step.params || {}) || def.title; } catch (e) { return def.title; }
  }

  function buildParams(def, values) {
    // 先把字段默认值补齐，再交给 def.build。
    // 直接 build(values) 会让没在界面上动过的字段（比如多选的统计量）拿不到默认值，
    // 于是「预估」算出来的结果和真正应用的结果不一致。
    const filled = {};
    values = values || {};
    def.fields.forEach((f) => {
      let v = values[f.k];
      if (f.type === 'number') v = v === '' || v === undefined ? f.def : Number(v);
      else if (f.type === 'checkbox') v = v === undefined ? !!f.def : !!v;
      if (v === undefined && f.def !== undefined) v = f.def;
      filled[f.k] = v;
    });
    if (def.build) return def.build(filled);
    return filled;
  }

  LD.ops = { apply, OP_DEFS, summarize, buildParams, compileExpr, sanitizeExpr, OPS };
})();
