/* LabDesk · 曲线处理与非线性拟合
   --------------------------------------------------------------------------
   面向谱图与仪器曲线：裁剪、平滑、基线校正、求导、归一化、寻峰积分、非线性拟合。
   全部是纯函数，不碰 DOM；浏览器里挂在 window.LD.curve，Node 里可直接 require。

   几条刻意的取舍：
   1. 平滑与求导统一用「局部多项式回归」，而不是先算 Savitzky–Golay 卷积系数。
      两者在等间距数据上等价，但局部回归天然支持不等间距的 x（色谱时间轴、
      仪器导出的非均匀采样），代价是 O(n·w·p²)，十万点仍在毫秒级。
   2. 基线用 Eilers 的非对称最小二乘（ALS），不是「取最小值」或「多项式硬拟合」。
      ALS 能跟着峰之间的谷底走，不会把宽峰本身削掉；用五对角 LDLᵀ 直接解，
      不做迭代式矩阵求逆，几千点也是线性的。
   3. 拟合用 Levenberg–Marquardt + 数值雅可比，参数带上下界。
      模型只收录工科实验里真正会用的那些；每个模型都自带初始值猜测，
      避免用户对着「a、b、c」发呆。
   ========================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LD = root.LD || {};
  root.LD.curve = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const st = () => root.LD && root.LD.stats;

  /* ==================== 基础工具 ==================== */
  function mean(a) {
    if (!a.length) return NaN;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function sd(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - m; s += d * d; }
    return Math.sqrt(s / (a.length - 1));
  }

  function minOf(a) {
    let m = Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i];
    return m;
  }

  function maxOf(a) {
    let m = -Infinity;
    for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
    return m;
  }

  function medianOf(a) {
    if (!a.length) return NaN;
    const s = a.slice().sort((p, q) => p - q);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  /** 镜像边界取值：比补零温和，不会在谱图两端造出假的斜率 */
  function reflectAt(y, i) {
    const n = y.length;
    if (n === 1) return y[0];
    let k = i;
    for (let guard = 0; guard < 8 && (k < 0 || k >= n); guard++) {
      if (k < 0) k = -k;
      if (k >= n) k = 2 * n - 2 - k;
    }
    return y[Math.max(0, Math.min(n - 1, k))];
  }

  /** 只保留 x 与 y 都有限的点 */
  function cleanPairs(x, y) {
    const xs = [], ys = [];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const xv = x[i], yv = y[i];
      if (typeof xv === 'number' && isFinite(xv) && typeof yv === 'number' && isFinite(yv)) {
        xs.push(xv); ys.push(yv);
      }
    }
    return { x: xs, y: ys };
  }

  /** 按 x 升序整理；x 递减时整体反转，非单调时稳定排序 */
  function sortByX(x, y) {
    const n = x.length;
    if (n < 2) return { x: x.slice(), y: y.slice() };
    let inc = true, dec = true;
    for (let i = 1; i < n; i++) {
      if (x[i] < x[i - 1]) inc = false;
      if (x[i] > x[i - 1]) dec = false;
    }
    if (inc) return { x: x.slice(), y: y.slice() };
    if (dec) return { x: x.slice().reverse(), y: y.slice().reverse() };
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
    return { x: idx.map((i) => x[i]), y: idx.map((i) => y[i]) };
  }

  function linInterp(x0, y0, x1, y1, xv) {
    if (x1 === x0) return y0;
    return y0 + (y1 - y0) * (xv - x0) / (x1 - x0);
  }

  /* ==================== 线性代数 ==================== */
  /** 高斯消元（部分选主元），失败返回 null */
  function solve(A, b) {
    const n = A.length;
    if (!n || b.length !== n) return null;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-14) return null;
      if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
      const p = M[c][c];
      for (let j = c; j <= n; j++) M[c][j] /= p;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (!f) continue;
        for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map((row) => row[n]);
  }

  function invert(A) {
    const n = A.length;
    const M = A.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-14) return null;
      if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
      const p = M[c][c];
      for (let j = 0; j < 2 * n; j++) M[c][j] /= p;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (!f) continue;
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map((row) => row.slice(n));
  }

  /* ==================== 平滑与求导 ==================== */
  /**
   * 局部多项式回归。deriv=0 返回平滑值，deriv=1/2 返回一阶/二阶导数。
   * 窗口在两端自动收缩，不会因为缺邻居而输出 NaN。
   */
  function localPoly(x, y, window, order, deriv) {
    const n = x.length;
    const out = new Array(n).fill(NaN);
    if (n === 0) return out;
    const half = Math.max(1, Math.floor((window || 11) / 2));
    const deg = Math.max(0, Math.min(order === undefined ? 2 : order, 5));
    const d0 = Math.max(0, Math.min(deriv || 0, 3));
    for (let i = 0; i < n; i++) {
      let lo = Math.max(0, i - half);
      let hi = Math.min(n - 1, i + half);
      while (hi - lo + 1 < deg + 1 && (lo > 0 || hi < n - 1)) {
        if (lo > 0) lo--; else if (hi < n - 1) hi++;
      }
      const m = hi - lo + 1;
      const d = Math.min(deg, m - 1);
      if (d < d0) { out[i] = d0 === 0 ? y[i] : NaN; continue; }
      let scale = 0;
      for (let j = lo; j <= hi; j++) scale = Math.max(scale, Math.abs(x[j] - x[i]));
      if (!(scale > 0)) { out[i] = d0 === 0 ? y[i] : NaN; continue; }
      const A = [], b = [];
      for (let a = 0; a <= d; a++) { A.push(new Array(d + 1).fill(0)); b.push(0); }
      for (let j = lo; j <= hi; j++) {
        const t = (x[j] - x[i]) / scale;
        let tp = 1;
        for (let a = 0; a <= d; a++) {
          b[a] += tp * y[j];
          for (let c = 0; c <= d; c++) A[a][c] += tp * Math.pow(t, c);
          tp *= t;
        }
      }
      const coef = solve(A, b);
      if (!coef) { out[i] = d0 === 0 ? y[i] : NaN; continue; }
      let fact = 1;
      for (let k = 2; k <= d0; k++) fact *= k;
      out[i] = coef[d0] * fact / Math.pow(scale, d0);
    }
    return out;
  }

  function movingAverage(y, window) {
    const n = y.length;
    const half = Math.max(0, Math.floor((window || 5) / 2));
    if (half < 1) return y.slice();
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = -half; j <= half; j++) { s += reflectAt(y, i + j); c++; }
      out[i] = s / c;
    }
    return out;
  }

  function medianFilter(y, window) {
    const n = y.length;
    const half = Math.max(0, Math.floor((window || 5) / 2));
    if (half < 1) return y.slice();
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const buf = [];
      for (let j = -half; j <= half; j++) buf.push(reflectAt(y, i + j));
      out[i] = medianOf(buf);
    }
    return out;
  }

  function gaussianSmooth(y, sigma) {
    const n = y.length;
    const s = Math.max(1e-6, sigma || 1);
    const radius = Math.max(1, Math.ceil(3 * s));
    const kernel = [];
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const v = Math.exp(-0.5 * (k / s) * (k / s));
      kernel.push(v); sum += v;
    }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += reflectAt(y, i + k) * kernel[k + radius];
      out[i] = acc;
    }
    return out;
  }

  /**
   * 平滑入口。method: none | sg | moving | median | gaussian
   * sg 的 window 必须是奇数；偶数会自动 +1。
   */
  function smooth(x, y, opt) {
    const o = opt || {};
    const method = o.method || 'none';
    if (method === 'none') return y.slice();
    let win = Math.max(3, Math.round(o.window || 11));
    if (win % 2 === 0) win += 1;
    if (method === 'moving') return movingAverage(y, win);
    if (method === 'median') return medianFilter(y, win);
    if (method === 'gaussian') return gaussianSmooth(y, Math.max(0.5, win / 6));
    const order = Math.max(0, Math.min(o.order === undefined ? 2 : o.order, 5));
    return localPoly(x, y, win, Math.min(order, win - 1), 0);
  }

  /* ==================== 基线校正 ==================== */
  /** 多项式基线；x 先缩放到 [-1,1]，避免高次项把正规方程搞成病态 */
  function polyFit(x, y, degree) {
    const n = x.length;
    if (!n) return null;
    const d = Math.max(0, Math.min(degree === undefined ? 4 : degree, n - 1, 8));
    let lo = x[0], hi = x[n - 1];
    for (let i = 0; i < n; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; }
    const mid = (lo + hi) / 2;
    const half = (hi - lo) / 2 || 1;
    const t = x.map((v) => (v - mid) / half);
    const A = [], b = [];
    for (let a = 0; a <= d; a++) { A.push(new Array(d + 1).fill(0)); b.push(0); }
    for (let i = 0; i < n; i++) {
      let tp = 1;
      for (let a = 0; a <= d; a++) {
        b[a] += tp * y[i];
        for (let c = 0; c <= d; c++) A[a][c] += tp * Math.pow(t[i], c);
        tp *= t[i];
      }
    }
    const coef = solve(A, b);
    if (!coef) return null;
    const yhat = t.map((tv) => {
      let v = 0, tp = 1;
      for (let a = 0; a <= d; a++) { v += coef[a] * tp; tp *= tv; }
      return v;
    });
    return { coef, yhat, mid, half };
  }

  /** 五对角对称矩阵的 LDLᵀ 分解求解（ALS 基线专用） */
  function solveBanded5(diag, off1, off2, b) {
    const n = diag.length;
    if (n === 0) return [];
    if (n === 1) return [b[0] / diag[0]];
    const d = diag.slice();
    const l1 = new Array(n).fill(0);
    const l2 = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = d[i];
      if (i >= 1 && l1[i]) s -= l1[i] * l1[i] * d[i - 1];
      if (i >= 2 && l2[i]) s -= l2[i] * l2[i] * d[i - 2];
      if (Math.abs(s) < 1e-14) return null;
      d[i] = s;
      if (i + 1 < n) {
        let v = off1[i];
        if (i >= 1 && l2[i + 1]) v -= l2[i + 1] * l1[i] * d[i - 1];
        l1[i + 1] = v / d[i];
      }
      if (i + 2 < n) l2[i + 2] = off2[i] / d[i];
    }
    const z = new Array(n);
    for (let i = 0; i < n; i++) {
      let v = b[i];
      if (i >= 1) v -= l1[i] * z[i - 1];
      if (i >= 2) v -= l2[i] * z[i - 2];
      z[i] = v;
    }
    for (let i = 0; i < n; i++) z[i] /= d[i];
    const out = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let v = z[i];
      if (i + 1 < n) v -= l1[i + 1] * out[i + 1];
      if (i + 2 < n) v -= l2[i + 2] * out[i + 2];
      out[i] = v;
    }
    return out;
  }

  /**
   * Eilers 非对称最小二乘基线。
   * w_i 在「点高于基线」时取 p（很小），低于基线时取 1-p，
   * 迭代后基线会贴着谷底走。lambda 越大越平滑。
   */
  function alsBaseline(y, lambda, p, iter) {
    const n = y.length;
    if (n < 5) return new Array(n).fill(minOf(y));
    const lam = Math.max(1, lambda || 1e5);
    const pp = Math.max(1e-6, Math.min(0.5, p === undefined ? 0.01 : p));
    const rounds = Math.max(1, Math.min(100, iter || 10));
    let z = y.slice();
    for (let it = 0; it < rounds; it++) {
      const diag = new Array(n);
      const off1 = new Array(n - 1);
      const off2 = new Array(n - 2);
      const rhs = new Array(n);
      for (let i = 0; i < n; i++) {
        const w = y[i] > z[i] ? pp : 1 - pp;
        let c0;
        if (i === 0 || i === n - 1) c0 = 1;
        else if (i === 1 || i === n - 2) c0 = 5;
        else c0 = 6;
        diag[i] = w + lam * c0;
        rhs[i] = w * y[i];
      }
      for (let i = 0; i < n - 1; i++) off1[i] = lam * ((i === 0 || i === n - 2) ? -2 : -4);
      for (let i = 0; i < n - 2; i++) off2[i] = lam;
      const sol = solveBanded5(diag, off1, off2, rhs);
      if (!sol) break;
      z = sol;
    }
    return z;
  }

  /** 端点连线基线：取两端各 2% 点的均值，避免单个噪声点带偏 */
  function linearBaseline(x, y) {
    const n = y.length;
    if (!n) return [];
    const k = Math.max(1, Math.round(n * 0.02));
    let l = 0, r = 0;
    for (let i = 0; i < k; i++) { l += y[i]; r += y[n - 1 - i]; }
    l /= k; r /= k;
    const x0 = x[0], x1 = x[n - 1];
    return x.map((xv) => linInterp(x0, l, x1, r, xv));
  }

  function baseline(x, y, opt) {
    const o = opt || {};
    const method = o.method || 'none';
    const n = y.length;
    if (!n || method === 'none') return new Array(n).fill(0);
    if (method === 'als') return alsBaseline(y, o.lambda, o.p, o.iter);
    if (method === 'linear') return linearBaseline(x, y);
    if (method === 'min') return new Array(n).fill(minOf(y));
    const fit = polyFit(x, y, o.degree === undefined ? 4 : o.degree);
    return fit ? fit.yhat : new Array(n).fill(0);
  }

  /* ==================== 归一化与重采样 ==================== */
  function normalize(y, method) {
    const n = y.length;
    if (!n || !method || method === 'none') return y.slice();
    if (method === 'max') {
      const m = maxOf(y);
      return y.map((v) => (m ? v / m : v));
    }
    if (method === 'minmax') {
      const lo = minOf(y), hi = maxOf(y);
      return y.map((v) => (hi > lo ? (v - lo) / (hi - lo) : 0));
    }
    if (method === 'snv') {
      const m = mean(y), s = sd(y);
      return y.map((v) => (s > 0 ? (v - m) / s : 0));
    }
    if (method === 'vector') {
      let s = 0;
      for (let i = 0; i < n; i++) s += y[i] * y[i];
      const norm = Math.sqrt(s) || 1;
      return y.map((v) => v / norm);
    }
    if (method === 'area') {
      // 没有 x 就没法算真实面积；由 process 调 areaNormalize，这里只做均值归一化兜底
      return y.map((v) => (mean(y) ? v / mean(y) : v));
    }
    return y.slice();
  }

  /** 按曲线下面积归一化（需要 x） */
  function areaNormalize(x, y) {
    let area = 0;
    for (let i = 1; i < x.length; i++) area += (y[i] + y[i - 1]) / 2 * (x[i] - x[i - 1]);
    if (!isFinite(area) || Math.abs(area) < 1e-15) return y.slice();
    return y.map((v) => v / area);
  }

  function resample(x, y, n) {
    const N = Math.max(2, Math.round(n || 500));
    if (x.length < 2) return { x: x.slice(), y: y.slice() };
    const lo = x[0], hi = x[x.length - 1];
    const xs = new Array(N), ys = new Array(N);
    let j = 0;
    for (let k = 0; k < N; k++) {
      const xv = lo + (hi - lo) * k / (N - 1);
      while (j < x.length - 2 && x[j + 1] < xv) j++;
      ys[k] = linInterp(x[j], y[j], x[j + 1], y[j + 1], xv);
      xs[k] = xv;
    }
    return { x: xs, y: ys };
  }

  /* ==================== 预处理流水线 ==================== */
  const PRE_DEFAULTS = {
    crop: { on: false, lo: null, hi: null },
    baseline: { method: 'none', degree: 4, lambda: 1e5, p: 0.01, iter: 10 },
    smooth: { method: 'sg', window: 11, order: 2 },
    deriv: 0,
    norm: 'none',
  };

  /**
   * 固定顺序：裁剪 → 基线 → 平滑 → 求导 → 归一化。
   * 这个顺序不是随便定的：先裁掉两端再拟合基线，基线不会被裁掉的部分带偏；
   * 先平滑再求导，否则噪声会被导数放大成锯齿。
   */
  function process(x0, y0, pre) {
    const o = Object.assign({}, PRE_DEFAULTS, pre || {});
    o.baseline = Object.assign({}, PRE_DEFAULTS.baseline, (pre && pre.baseline) || {});
    o.smooth = Object.assign({}, PRE_DEFAULTS.smooth, (pre && pre.smooth) || {});
    const cp = cleanPairs(x0 || [], y0 || []);
    let x = cp.x, y = cp.y;
    if (!x.length) return { x: [], y: [], raw: [], baseline: null, pre: o };
    const sorted = sortByX(x, y);
    x = sorted.x; y = sorted.y;

    if (o.crop && o.crop.on) {
      const lo = o.crop.lo === null || o.crop.lo === undefined ? -Infinity : Number(o.crop.lo);
      const hi = o.crop.hi === null || o.crop.hi === undefined ? Infinity : Number(o.crop.hi);
      const a = Math.min(lo, hi), b = Math.max(lo, hi);
      const kx = [], ky = [];
      for (let i = 0; i < x.length; i++) if (x[i] >= a && x[i] <= b) { kx.push(x[i]); ky.push(y[i]); }
      x = kx; y = ky;
      if (!x.length) return { x: [], y: [], raw: [], baseline: null, pre: o };
    }

    const raw = y.slice();
    let base = null;
    if (o.baseline.method && o.baseline.method !== 'none') {
      base = baseline(x, y, o.baseline);
      y = y.map((v, i) => v - base[i]);
    }
    if (o.smooth.method && o.smooth.method !== 'none') y = smooth(x, y, o.smooth);
    if (o.deriv === 1 || o.deriv === 2) {
      const win = Math.max(5, o.smooth.window || 11);
      const order = Math.max(o.deriv + 1, o.smooth.order || 2);
      y = localPoly(x, y, win, order, o.deriv);
    }
    if (o.norm === 'area') y = areaNormalize(x, y);
    else if (o.norm && o.norm !== 'none') y = normalize(y, o.norm);

    return { x, y, raw, baseline: base, pre: o };
  }

  /* ==================== 积分 ==================== */
  /** 梯形积分，支持任意 [a,b] 区间（边界线性插值） */
  function integrate(x, y, a, b) {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    let lo = Math.min(a, b), hi = Math.max(a, b);
    let sum = 0;
    for (let i = 0; i < n - 1; i++) {
      const x0 = x[i], x1 = x[i + 1];
      if (x1 <= lo || x0 >= hi) continue;
      const xa = Math.max(x0, lo), xb = Math.min(x1, hi);
      if (xb <= xa) continue;
      const ya = linInterp(x0, y[i], x1, y[i + 1], xa);
      const yb = linInterp(x0, y[i], x1, y[i + 1], xb);
      sum += (ya + yb) / 2 * (xb - xa);
    }
    return sum;
  }

  /* ==================== 寻峰 ==================== */
  const PEAK_DEFAULTS = {
    on: true,
    relHeight: 5,      // 相对峰高（% of y range）
    minHeight: null,   // 绝对高度下限
    relProminence: 5,  // 相对显著度（%）
    prominence: 0,     // 绝对显著度
    distance: 5,       // 峰间最小间隔（点数）
    maxPeaks: 50,
  };

  function peakBaseAt(y, i) {
    const n = y.length;
    const h = y[i];
    let l = i, leftBase = h;
    while (l > 0) {
      l--;
      if (y[l] > h) break;
      if (y[l] < leftBase) leftBase = y[l];
    }
    let r = i, rightBase = h;
    while (r < n - 1) {
      r++;
      if (y[r] > h) break;
      if (y[r] < rightBase) rightBase = y[r];
    }
    return { base: Math.max(leftBase, rightBase), leftBase, rightBase };
  }

  function fwhmAt(x, y, i, base) {
    const n = y.length;
    const h = y[i];
    const half = base + (h - base) / 2;
    if (!(h > base)) return null;
    let xl = null, xr = null;
    let l = i;
    while (l > 0 && y[l] > half) l--;
    if (l < i) {
      if (y[l] <= half && y[l + 1] > half) xl = linInterp(y[l], x[l], y[l + 1], x[l + 1], half);
      else if (l === 0 && y[0] <= half) xl = x[0];
    }
    let r = i;
    while (r < n - 1 && y[r] > half) r++;
    if (r > i) {
      if (y[r] <= half && y[r - 1] > half) xr = linInterp(y[r], x[r], y[r - 1], x[r - 1], half);
      else if (r === n - 1 && y[n - 1] <= half) xr = x[n - 1];
    }
    if (xl === null || xr === null || xr <= xl) return null;
    return { width: xr - xl, left: xl, right: xr, half };
  }

  /**
   * 寻找局部极大值。筛选条件与 scipy.signal.find_peaks 的思路一致：
   * 高度、显著度（prominence）、最小间距，另外给出 FWHM 与积分面积。
   */
  function findPeaks(x, y, opt) {
    const o = Object.assign({}, PEAK_DEFAULTS, opt || {});
    const n = Math.min(x.length, y.length);
    if (n < 3) return [];
    const lo = minOf(y), hi = maxOf(y);
    const range = hi - lo;
    const heightLevel = o.minHeight === null || o.minHeight === undefined || o.minHeight === ''
      ? lo + Math.max(0, o.relHeight || 0) / 100 * range
      : Math.max(Number(o.minHeight), lo);
    const promLevel = Math.max(0, Number(o.prominence) || 0, (Number(o.relProminence) || 0) / 100 * range);

    const cand = [];
    let i = 1;
    while (i < n - 1) {
      if (y[i] > y[i - 1]) {
        let j = i;
        while (j + 1 < n && y[j + 1] === y[i]) j++;
        if (j + 1 < n && y[j + 1] < y[i]) {
          const k = Math.floor((i + j) / 2);
          if (y[k] >= heightLevel) {
            const pb = peakBaseAt(y, k);
            const prom = y[k] - pb.base;
            if (prom >= promLevel) {
              const fw = fwhmAt(x, y, k, pb.base);
              cand.push({
                i: k, x: x[k], y: y[k],
                base: pb.base, prominence: prom,
                fwhm: fw ? fw.width : null,
                left: fw ? fw.left : null,
                right: fw ? fw.right : null,
              });
            }
          }
          i = j + 1;
          continue;
        }
        i = j + 1;
      } else i++;
    }

    // 最小间距：从高到低贪心保留，避免一个宽峰裂成两个
    let kept = cand;
    const dist = Math.max(1, Math.round(o.distance || 1));
    if (dist > 1 && cand.length > 1) {
      const order = cand.slice().sort((a, b) => b.y - a.y);
      const taken = [];
      order.forEach((c) => {
        if (taken.every((t) => Math.abs(t.i - c.i) >= dist)) taken.push(c);
      });
      kept = taken;
    }
    kept.sort((a, b) => a.i - b.i);
    const lim = Math.max(1, Math.round(o.maxPeaks || 50));
    if (kept.length > lim) kept = kept.slice(0, lim);

    kept.forEach((p) => {
      p.area = p.left !== null ? integrate(x, y, p.left, p.right) : null;
      if (p.area === null) {
        const a = p.i > 0 ? (x[p.i - 1] + x[p.i]) / 2 : x[p.i];
        const b = p.i < n - 1 ? (x[p.i] + x[p.i + 1]) / 2 : x[p.i];
        p.area = integrate(x, y, a, b);
      }
    });
    return kept;
  }

  /* ==================== 非线性拟合 ==================== */
  const R_GAS = 8.314; // J/mol/K

  function safeExp(v) {
    if (v > 700) return Infinity;
    if (v < -700) return 0;
    return Math.exp(v);
  }

  function linearGuess(x, y) {
    const n = x.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
    const den = n * sxx - sx * sx;
    const b = den ? (n * sxy - sx * sy) / den : 0;
    return { a: (sy - b * sx) / n, b };
  }

  function rawPolyCoef(coef, mid, half) {
    const out = new Array(coef.length).fill(0);
    for (let j = 0; j < coef.length; j++) {
      const scale = Math.pow(half, j);
      for (let k = 0; k <= j; k++) {
        let binom = 1;
        for (let q = 0; q < k; q++) binom = binom * (j - q) / (q + 1);
        out[k] += coef[j] / scale * binom * Math.pow(-mid, j - k);
      }
    }
    return out;
  }

  function polyGuess(x, y, degree) {
    const fit = polyFit(x, y, degree);
    if (!fit) return { a: mean(y), b: 0, c: 0, d: 0 };
    const raw = rawPolyCoef(fit.coef, fit.mid, fit.half);
    return { a: raw[0] || 0, b: raw[1] || 0, c: raw[2] || 0, d: raw[3] || 0 };
  }

  function xSpan(x) {
    let lo = minOf(x), hi = maxOf(x);
    return (hi - lo) || 1;
  }

  function xAtY(x, y, target) {
    let best = x[0], bestD = Infinity;
    for (let i = 0; i < y.length; i++) {
      const d = Math.abs(y[i] - target);
      if (d < bestD) { bestD = d; best = x[i]; }
    }
    return best;
  }

  function logLogGuess(x, y) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i] > 0 && y[i] > 0) {
        const lx = Math.log(x[i]), ly = Math.log(y[i]);
        n++; sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
      }
    }
    if (n < 3) return null;
    const den = n * sxx - sx * sx;
    if (!den) return null;
    const b = (n * sxy - sx * sy) / den;
    const a = Math.exp((sy - b * sx) / n);
    return { a, b };
  }

  const MODELS = [
    {
      key: 'linear', name: '线性 y = a + b·x', formula: 'y = a + b·x',
      params: [
        { k: 'a', label: '截距 a', def: 0 },
        { k: 'b', label: '斜率 b', def: 1 },
      ],
      fn: (p, x) => p.a + p.b * x,
      guess: (x, y) => linearGuess(x, y),
    },
    {
      key: 'poly2', name: '二次多项式 y = a + b·x + c·x²', formula: 'y = a + b·x + c·x²',
      params: [
        { k: 'a', label: '常数 a', def: 0 },
        { k: 'b', label: '一次项 b', def: 0 },
        { k: 'c', label: '二次项 c', def: 0 },
      ],
      fn: (p, x) => p.a + p.b * x + p.c * x * x,
      guess: (x, y) => polyGuess(x, y, 2),
    },
    {
      key: 'poly3', name: '三次多项式', formula: 'y = a + b·x + c·x² + d·x³',
      params: [
        { k: 'a', label: '常数 a', def: 0 },
        { k: 'b', label: '一次项 b', def: 0 },
        { k: 'c', label: '二次项 c', def: 0 },
        { k: 'd', label: '三次项 d', def: 0 },
      ],
      fn: (p, x) => p.a + p.b * x + p.c * x * x + p.d * x * x * x,
      guess: (x, y) => polyGuess(x, y, 3),
    },
    {
      key: 'expdecay', name: '指数衰减 a·e^(−k·x) + c', formula: 'y = a·exp(−k·x) + c',
      params: [
        { k: 'a', label: '幅度 a', def: 1 },
        { k: 'k', label: '速率 k', def: 0.1, min: 1e-12 },
        { k: 'c', label: '平台值 c', def: 0 },
      ],
      fn: (p, x) => p.a * safeExp(-p.k * x) + p.c,
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        let a = y[0] - lo;
        if (!isFinite(a) || Math.abs(a) < 1e-9) a = hi - lo;
        return { a, k: 2 / xSpan(x), c: lo };
      },
    },
    {
      key: 'expgrowth', name: '指数增长 a·e^(k·x) + c', formula: 'y = a·exp(k·x) + c',
      params: [
        { k: 'a', label: '幅度 a', def: 1 },
        { k: 'k', label: '速率 k', def: 0.1, min: 1e-12 },
        { k: 'c', label: '平台值 c', def: 0 },
      ],
      fn: (p, x) => p.a * safeExp(p.k * x) + p.c,
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        let a = y[0] - lo;
        if (!isFinite(a) || Math.abs(a) < 1e-9) a = hi - lo;
        return { a, k: 2 / xSpan(x), c: lo };
      },
    },
    {
      key: 'biexp', name: '双指数 a·e^(−k₁x) + b·e^(−k₂x) + c', formula: 'y = a·exp(−k₁x) + b·exp(−k₂x) + c',
      params: [
        { k: 'a', label: '快相幅度 a', def: 0.6 },
        { k: 'k1', label: '快相速率 k₁', def: 0.5, min: 1e-12 },
        { k: 'b', label: '慢相幅度 b', def: 0.4 },
        { k: 'k2', label: '慢相速率 k₂', def: 0.05, min: 1e-12 },
        { k: 'c', label: '平台值 c', def: 0 },
      ],
      fn: (p, x) => p.a * safeExp(-p.k1 * x) + p.b * safeExp(-p.k2 * x) + p.c,
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        const a0 = (y[0] - lo) || (hi - lo);
        return { a: 0.6 * a0, k1: 4 / xSpan(x), b: 0.4 * a0, k2: 1 / xSpan(x), c: lo };
      },
    },
    {
      key: 'logistic', name: '四参数 Logistic（S 形曲线）', formula: 'y = c + (d−c)/(1+exp(−k(x−x₀)))',
      params: [
        { k: 'c', label: '下平台 c', def: 0 },
        { k: 'd', label: '上平台 d', def: 1 },
        { k: 'k', label: '陡度 k', def: 1 },
        { k: 'x0', label: '中点 x₀', def: 0 },
      ],
      fn: (p, x) => {
        const z = -p.k * (x - p.x0);
        if (z > 700) return p.c;
        if (z < -700) return p.d;
        return p.c + (p.d - p.c) / (1 + Math.exp(z));
      },
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        const rising = y[y.length - 1] >= y[0];
        return {
          c: rising ? lo : hi, d: rising ? hi : lo,
          k: (rising ? 4 : -4) / xSpan(x),
          x0: xAtY(x, y, (lo + hi) / 2),
        };
      },
    },
    {
      key: 'dose4pl', name: '四参数剂量–响应（4PL）', formula: 'y = bottom + (top−bottom)/(1+(x/EC50)^hill)',
      params: [
        { k: 'bottom', label: '下平台 bottom', def: 0 },
        { k: 'top', label: '上平台 top', def: 1 },
        { k: 'ec50', label: 'EC50 / IC50', def: 1, min: 1e-12 },
        { k: 'hill', label: 'Hill 斜率', def: 1 },
      ],
      positiveX: true,
      fn: (p, x) => {
        if (!(x > 0) || !(p.ec50 > 0)) return NaN;
        const t = Math.pow(x / p.ec50, p.hill);
        if (!isFinite(t)) return p.hill > 0 ? p.bottom : p.top;
        return p.bottom + (p.top - p.bottom) / (1 + t);
      },
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        return { bottom: lo, top: hi, ec50: medianOf(x.filter((v) => v > 0)), hill: 1 };
      },
    },
    {
      key: 'dose5pl', name: '五参数剂量–响应（5PL）', formula: 'y = bottom + (top−bottom)/(1+(x/EC50)^hill)^g',
      params: [
        { k: 'bottom', label: '下平台 bottom', def: 0 },
        { k: 'top', label: '上平台 top', def: 1 },
        { k: 'ec50', label: 'EC50 / IC50', def: 1, min: 1e-12 },
        { k: 'hill', label: 'Hill 斜率', def: 1 },
        { k: 'g', label: '不对称因子 g', def: 1, min: 1e-6 },
      ],
      positiveX: true,
      fn: (p, x) => {
        if (!(x > 0) || !(p.ec50 > 0)) return NaN;
        const t = Math.pow(x / p.ec50, p.hill);
        const den = Math.pow(1 + t, p.g);
        if (!isFinite(den)) return p.hill > 0 ? p.bottom : p.top;
        return p.bottom + (p.top - p.bottom) / den;
      },
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        return { bottom: lo, top: hi, ec50: medianOf(x.filter((v) => v > 0)), hill: 1, g: 1 };
      },
    },
    {
      key: 'gompertz', name: 'Gompertz 生长曲线', formula: 'y = a·exp(−exp(−k(x−x₀)))',
      params: [
        { k: 'a', label: '上限 a', def: 1 },
        { k: 'k', label: '速率 k', def: 0.5, min: 1e-12 },
        { k: 'x0', label: '拐点 x₀', def: 0 },
      ],
      fn: (p, x) => p.a * safeExp(-safeExp(-p.k * (x - p.x0))),
      guess: (x, y) => {
        const hi = maxOf(y);
        return { a: hi, k: 4 / xSpan(x), x0: xAtY(x, y, hi * 0.37) };
      },
    },
    {
      key: 'gaussian', name: '高斯峰', formula: 'y = base + A·exp(−(x−μ)²/(2σ²))',
      params: [
        { k: 'base', label: '基线 base', def: 0 },
        { k: 'A', label: '峰高 A', def: 1 },
        { k: 'mu', label: '峰位 μ', def: 0 },
        { k: 'sigma', label: '标准差 σ', def: 1, min: 1e-12 },
      ],
      fn: (p, x) => {
        const z = (x - p.mu) / p.sigma;
        return p.base + p.A * safeExp(-0.5 * z * z);
      },
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        let mi = 0;
        for (let i = 1; i < y.length; i++) if (y[i] > y[mi]) mi = i;
        return { base: lo, A: hi - lo, mu: x[mi], sigma: xSpan(x) / 6 };
      },
    },
    {
      key: 'lorentzian', name: 'Lorentz 峰', formula: 'y = base + A·γ²/((x−x₀)²+γ²)',
      params: [
        { k: 'base', label: '基线 base', def: 0 },
        { k: 'A', label: '峰高 A', def: 1 },
        { k: 'x0', label: '峰位 x₀', def: 0 },
        { k: 'gamma', label: '半宽 γ', def: 1, min: 1e-12 },
      ],
      fn: (p, x) => {
        const d = x - p.x0;
        return p.base + p.A * (p.gamma * p.gamma) / (d * d + p.gamma * p.gamma);
      },
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        let mi = 0;
        for (let i = 1; i < y.length; i++) if (y[i] > y[mi]) mi = i;
        return { base: lo, A: hi - lo, x0: x[mi], gamma: xSpan(x) / 6 };
      },
    },
    {
      key: 'pseudovoigt', name: 'Pseudo-Voigt 峰', formula: 'y = base + A·[ηL + (1−η)G]',
      params: [
        { k: 'base', label: '基线 base', def: 0 },
        { k: 'A', label: '峰高 A', def: 1 },
        { k: 'x0', label: '峰位 x₀', def: 0 },
        { k: 'w', label: '半宽 w', def: 1, min: 1e-12 },
        { k: 'eta', label: 'Lorentz 比例 η', def: 0.5, min: 0, max: 1 },
      ],
      fn: (p, x) => {
        const d = (x - p.x0) / p.w;
        const g = safeExp(-0.5 * d * d);
        const l = 1 / (1 + d * d);
        return p.base + p.A * (p.eta * l + (1 - p.eta) * g);
      },
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        let mi = 0;
        for (let i = 1; i < y.length; i++) if (y[i] > y[mi]) mi = i;
        return { base: lo, A: hi - lo, x0: x[mi], w: xSpan(x) / 6, eta: 0.5 };
      },
    },
    {
      key: 'power', name: '幂律 y = a·x^b', formula: 'y = a·x^b',
      params: [
        { k: 'a', label: '系数 a', def: 1 },
        { k: 'b', label: '指数 b', def: 1 },
      ],
      positiveX: true,
      fn: (p, x) => (x > 0 ? p.a * Math.pow(x, p.b) : NaN),
      guess: (x, y) => {
        const lg = logLogGuess(x, y);
        return lg ? { a: lg.a, b: lg.b } : { a: mean(y), b: 1 };
      },
    },
    {
      key: 'langmuir', name: 'Langmuir 吸附', formula: 'y = qmax·K·x/(1+K·x)',
      params: [
        { k: 'qmax', label: '饱和量 qmax', def: 1 },
        { k: 'K', label: '亲和常数 K', def: 1, min: 1e-12 },
      ],
      fn: (p, x) => p.qmax * p.K * x / (1 + p.K * x),
      guess: (x, y) => {
        const hi = maxOf(y);
        const pos = x.filter((v) => v > 0);
        return { qmax: hi, K: 1 / (medianOf(pos) || xSpan(x)) };
      },
    },
    {
      key: 'freundlich', name: 'Freundlich 吸附', formula: 'y = K·x^(1/n)',
      params: [
        { k: 'K', label: '系数 K', def: 1, min: 1e-12 },
        { k: 'n', label: '指数 n', def: 1 },
      ],
      positiveX: true,
      fn: (p, x) => (x > 0 ? p.K * Math.pow(x, 1 / p.n) : NaN),
      guess: (x, y) => {
        const lg = logLogGuess(x, y);
        return lg ? { K: lg.a, n: lg.b ? 1 / lg.b : 1 } : { K: 1, n: 1 };
      },
    },
    {
      key: 'michaelis', name: 'Michaelis–Menten', formula: 'y = Vmax·x/(Km+x)',
      params: [
        { k: 'vmax', label: 'Vmax', def: 1 },
        { k: 'km', label: 'Km', def: 1, min: 1e-12 },
      ],
      fn: (p, x) => p.vmax * x / (p.km + x),
      guess: (x, y) => {
        const hi = maxOf(y);
        const pos = x.filter((v) => v > 0);
        return { vmax: hi, km: medianOf(pos) || xSpan(x) };
      },
    },
    {
      key: 'hill', name: 'Hill 方程', formula: 'y = Vmax·x^n/(k^n+x^n)',
      params: [
        { k: 'vmax', label: 'Vmax', def: 1 },
        { k: 'k', label: '半饱和 k', def: 1, min: 1e-12 },
        { k: 'n', label: 'Hill 系数 n', def: 1 },
      ],
      fn: (p, x) => {
        const xn = Math.pow(x, p.n);
        return p.vmax * xn / (Math.pow(p.k, p.n) + xn);
      },
      guess: (x, y) => {
        const hi = maxOf(y);
        const pos = x.filter((v) => v > 0);
        return { vmax: hi, k: medianOf(pos) || xSpan(x), n: 1 };
      },
    },
    {
      key: 'arrhenius', name: 'Arrhenius（x 为温度 K）', formula: 'y = A·exp(−Ea/(R·T))',
      params: [
        { k: 'A', label: '指前因子 A', def: 1, min: 1e-300 },
        { k: 'Ea', label: '活化能 Ea (kJ/mol)', def: 50 },
      ],
      positiveX: true,
      fn: (p, x) => p.A * safeExp(-p.Ea * 1000 / (R_GAS * x)),
      guess: (x, y) => {
        let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = 0; i < x.length; i++) {
          if (x[i] > 0 && y[i] > 0) {
            const lx = 1 / x[i], ly = Math.log(y[i]);
            n++; sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
          }
        }
        if (n < 3) return { A: 1, Ea: 50 };
        const den = n * sxx - sx * sx;
        const slope = den ? (n * sxy - sx * sy) / den : 0;
        const intercept = (sy - slope * sx) / n;
        return { A: Math.exp(intercept), Ea: -slope * R_GAS / 1000 };
      },
    },
    {
      key: 'sine', name: '正弦 a·sin(2πf·x+φ)+c', formula: 'y = a·sin(2πf·x+φ)+c',
      params: [
        { k: 'a', label: '振幅 a', def: 1 },
        { k: 'f', label: '频率 f', def: 1, min: 1e-12 },
        { k: 'phi', label: '相位 φ', def: 0 },
        { k: 'c', label: '偏置 c', def: 0 },
      ],
      fn: (p, x) => p.a * Math.sin(2 * Math.PI * p.f * x + p.phi) + p.c,
      guess: (x, y) => {
        const lo = minOf(y), hi = maxOf(y);
        return { a: (hi - lo) / 2, f: 1 / xSpan(x), phi: 0, c: (hi + lo) / 2 };
      },
    },
  ];

  function modelByKey(key) {
    return MODELS.find((m) => m.key === key) || null;
  }

  function paramBounds(model) {
    return model.params.map((p) => ({
      min: p.min === undefined ? -Infinity : p.min,
      max: p.max === undefined ? Infinity : p.max,
    }));
  }

  function fitOnce(model, x, y, p0) {
    const k = model.params.length;
    const n = x.length;
    const keys = model.params.map((prm) => prm.k);
    const bounds = paramBounds(model);
    const clamp = (p) => p.map((v, j) => Math.min(bounds[j].max, Math.max(bounds[j].min, v)));
    // LM 内部用数组迭代，模型函数按参数名取值，这里做一次映射
    const asObj = (p) => {
      const o = {};
      for (let j = 0; j < k; j++) o[keys[j]] = p[j];
      return o;
    };
    const val = (p, i) => {
      const v = model.fn(asObj(p), x[i]);
      return typeof v === 'number' && isFinite(v) ? v : Infinity;
    };
    const sseOf = (p) => {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const r = val(p, i) - y[i];
        if (!isFinite(r)) return Infinity;
        s += r * r;
      }
      return s;
    };
    const jacobian = (p) => {
      const J = [];
      for (let i = 0; i < n; i++) J.push(new Array(k).fill(0));
      for (let j = 0; j < k; j++) {
        const h = 1e-6 * Math.max(1, Math.abs(p[j]));
        let p1 = p.slice(), p2 = p.slice();
        p1[j] += h; p2[j] -= h;
        let denom = 2 * h;
        if (p1[j] > bounds[j].max) { p1[j] = p[j]; p2[j] = p[j] - h; denom = h; }
        else if (p2[j] < bounds[j].min) { p2[j] = p[j]; p1[j] = p[j] + h; denom = h; }
        for (let i = 0; i < n; i++) {
          const f1 = val(p1, i), f2 = val(p2, i);
          J[i][j] = isFinite(f1) && isFinite(f2) ? (f1 - f2) / denom : 0;
        }
      }
      return J;
    };

    let p = clamp(p0.slice());
    let cur = sseOf(p);
    if (!isFinite(cur)) {
      // 初值落在模型定义域外（如幂律遇到 x<=0）时，用常数均值兜底
      p = clamp(model.params.map(() => 0));
      cur = sseOf(p);
      if (!isFinite(cur)) return null;
    }
    let lambda = 1e-3;
    let converged = false;
    let iterations = 0;
    for (let it = 0; it < 300; it++) {
      iterations = it + 1;
      const J = jacobian(p);
      const g = new Array(k).fill(0);
      const H = [];
      for (let a = 0; a < k; a++) H.push(new Array(k).fill(0));
      for (let i = 0; i < n; i++) {
        const r = val(p, i) - y[i];
        for (let a = 0; a < k; a++) {
          g[a] += J[i][a] * r;
          for (let b = 0; b < k; b++) H[a][b] += J[i][a] * J[i][b];
        }
      }
      let accepted = false;
      for (let tries = 0; tries < 14; tries++) {
        const A = H.map((row, a) => row.map((v, b) => (
          a === b ? v + lambda * Math.max(H[a][a], 1e-8) : v
        )));
        const delta = solve(A, g.map((v) => -v));
        if (!delta) { lambda *= 10; continue; }
        const pNew = clamp(p.map((v, j) => v + delta[j]));
        const nv = sseOf(pNew);
        if (nv < cur) {
          let maxRel = 0;
          for (let j = 0; j < k; j++) {
            maxRel = Math.max(maxRel, Math.abs(delta[j]) / Math.max(1e-12, Math.abs(p[j])));
          }
          p = pNew; cur = nv;
          lambda = Math.max(1e-12, lambda / 10);
          accepted = true;
          if (maxRel < 1e-9) converged = true;
          break;
        }
        lambda *= 10;
      }
      if (!accepted) { converged = true; break; }
      if (converged) break;
    }

    const fitted = new Array(n), residuals = new Array(n);
    let sse = 0, sst = 0;
    const my = mean(y);
    for (let i = 0; i < n; i++) {
      const f = val(p, i);
      fitted[i] = isFinite(f) ? f : NaN;
      residuals[i] = fitted[i] - y[i];
      if (isFinite(residuals[i])) sse += residuals[i] * residuals[i];
      sst += (y[i] - my) * (y[i] - my);
    }
    const dof = n - k;
    const r2 = sst > 0 ? 1 - sse / sst : NaN;
    const adjR2 = dof > 0 && sst > 0 ? 1 - (sse / dof) / (sst / (n - 1)) : NaN;
    const rmse = Math.sqrt(sse / n);
    const aic = sse > 0 ? n * Math.log(sse / n) + 2 * k : -Infinity;

    // 参数标准误：cov = MSE · (JᵀJ)⁻¹
    const Jf = jacobian(p);
    const Hf = [];
    for (let a = 0; a < k; a++) Hf.push(new Array(k).fill(0));
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) Hf[a][b] += Jf[i][a] * Jf[i][b];
    }
    const inv = invert(Hf);
    const mse = dof > 0 ? sse / dof : NaN;
    const tq = (st() && st().tCrit) ? st().tCrit(0.025, Math.max(1, dof)) : 1.96;
    const paramList = model.params.map((prm, j) => {
      const se = inv ? Math.sqrt(Math.max(0, mse * inv[j][j])) : NaN;
      const atBound = (p[j] <= bounds[j].min + 1e-9) || (p[j] >= bounds[j].max - 1e-9);
      return {
        k: prm.k, label: prm.label, value: p[j], se,
        ciLow: isFinite(se) ? p[j] - tq * se : NaN,
        ciHigh: isFinite(se) ? p[j] + tq * se : NaN,
        atBound: atBound && (isFinite(bounds[j].min) || isFinite(bounds[j].max)),
      };
    });
    const params = {};
    model.params.forEach((prm, j) => { params[prm.k] = p[j]; });

    return {
      ok: true, model: model.key, params, paramList,
      fitted, residuals, n, k, dof, sse, r2, adjR2, rmse, aic,
      converged, iterations,
    };
  }

  /**
   * 非线性最小二乘。opts.init 可传用户编辑过的初值；否则用模型自带猜测，
   * 再做两次缩放扰动多起点，降低落入局部极小的概率。
   */
  function fit(x, y, key, opts) {
    const o = opts || {};
    const model = modelByKey(key);
    if (!model) return { ok: false, message: '未知的拟合模型' };
    const cp = cleanPairs(x || [], y || []);
    let xs = cp.x, ys = cp.y;
    if (model.positiveX) {
      const kx = [], ky = [];
      for (let i = 0; i < xs.length; i++) if (xs[i] > 0) { kx.push(xs[i]); ky.push(ys[i]); }
      xs = kx; ys = ky;
    }
    const n = xs.length;
    const k = model.params.length;
    if (n <= k + 1) {
      return { ok: false, message: `有效数据点只有 ${n} 个，至少需要 ${k + 2} 个才能估计 ${k} 个参数。` };
    }
    const sorted = sortByX(xs, ys);
    xs = sorted.x; ys = sorted.y;

    let starts = [];
    let g = {};
    try { g = model.guess(xs, ys) || {}; } catch (e) { g = {}; }
    if (o.init && Object.keys(o.init).length) {
      // 用户只改了一两个参数时，其余参数回退到模型猜测值，而不是硬编码默认值
      const p0 = model.params.map((prm) => {
        const raw = o.init[prm.k];
        const v = Number(raw);
        if (raw !== undefined && raw !== null && raw !== '' && isFinite(v)) return v;
        const gv = Number(g[prm.k]);
        return isFinite(gv) ? gv : prm.def;
      });
      starts.push(p0);
    } else {
      const base = model.params.map((prm) => {
        const v = Number(g[prm.k]);
        return isFinite(v) ? v : prm.def;
      });
      starts.push(base);
      starts.push(base.map((v) => (v === 0 ? 0.1 : v * 0.5)));
      starts.push(base.map((v) => (v === 0 ? -0.1 : v * 2)));
    }

    let best = null;
    starts.forEach((p0) => {
      const r = fitOnce(model, xs, ys, p0);
      if (r && (!best || r.sse < best.sse)) best = r;
    });
    if (!best) return { ok: false, message: '拟合未能收敛，请检查数据范围或手动调整初值。' };
    best.modelName = model.name;
    best.modelFormula = model.formula;
    best.x = xs;
    best.y = ys;
    best.inputs = o.init || null;
    // 拟合质量提示
    const warn = [];
    if (!best.converged) warn.push('迭代未达到收敛判据，结果可能不稳定。');
    if (!(best.r2 >= 0.9)) warn.push(`R² = ${best.r2.toFixed(3)}，模型只解释了部分变异，建议换模型或检查数据。`);
    if (best.paramList.some((p) => p.atBound)) warn.push('有参数停在边界上，说明该参数可能无法由数据确定。');
    if (best.dof < 3) warn.push(`残差自由度只有 ${best.dof}，参数标准误仅供参考。`);
    best.warnings = warn;
    return best;
  }

  function predict(key, params, x) {
    const model = modelByKey(key);
    if (!model) return NaN;
    return model.fn(params, x);
  }

  return {
    // 基础
    mean, sd, minOf, maxOf, medianOf, cleanPairs, sortByX, integrate,
    // 预处理
    PRE_DEFAULTS, PEAK_DEFAULTS,
    localPoly, movingAverage, medianFilter, gaussianSmooth, smooth,
    polyFit, alsBaseline, baseline, normalize, areaNormalize, resample, process,
    // 寻峰
    findPeaks, peakBaseAt, fwhmAt,
    // 拟合
    MODELS, modelByKey, fit, predict, fitOnce,
    // 线性代数（自测与扩展用）
    solve, invert, solveBanded5,
  };
});
