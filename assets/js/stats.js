/* LabDesk · 统计计算引擎
   纯 JavaScript 实现，不依赖后端。分布函数使用 Numerical Recipes 系列算法，
   Shapiro-Wilk 使用 Royston (1995) AS R94 近似，D'Agostino-Pearson 使用标准 K² 公式。
*/
(function () {
  const LD = (window.LD = window.LD || {});

  /* ==================== 基础分布函数 ==================== */
  const LANCZOS = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];

  function lgamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
    const t = z + LANCZOS.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  function erfc(x) {
    const z = Math.abs(x), t = 2 / (2 + z), ty = 4 * t - 2;
    const cof = [
      -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
      -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
      4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
      1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
      6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
      9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13,
      3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
    ];
    let d = 0, dd = 0;
    for (let j = cof.length - 1; j > 0; j--) { const tmp = d; d = ty * d - dd + cof[j]; dd = tmp; }
    const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
    return x >= 0 ? ans : 2 - ans;
  }

  const normCDF = (z) => 0.5 * erfc(-z / Math.SQRT2);
  const normSF = (z) => 0.5 * erfc(z / Math.SQRT2);

  function qnorm(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
      1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
      6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
      -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
      3.754408661907416];
    const pl = 0.02425, ph = 1 - pl;
    let q, r;
    if (p < pl) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > ph) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  function betacf(a, b, x) {
    const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }

  function gser(a, x) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 1; n < 1000; n++) {
      ap++; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }

  function gcf(a, x) {
    const FPMIN = 1e-300, EPS = 1e-15;
    let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
    for (let i = 1; i < 1000; i++) {
      const an = -i * (i - a);
      b += 2; d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
  }

  function gammq(a, x) {
    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 1;
    return x < a + 1 ? 1 - gser(a, x) : gcf(a, x);
  }

  const tSF2 = (t, df) => betai(df / 2, 0.5, df / (df + t * t));           // 双尾
  const tSF1 = (t, df) => (t >= 0 ? 0.5 * tSF2(t, df) : 1 - 0.5 * tSF2(t, df));
  const fSF = (F, d1, d2) => betai(d2 / 2, d1 / 2, d2 / (d2 + d1 * F));
  const chi2SF = (x, k) => gammq(k / 2, x / 2);

  function tCDF(t, df) { return t >= 0 ? 1 - 0.5 * tSF2(t, df) : 0.5 * tSF2(t, df); }

  function bisect(fn, target, lo, hi, iter) {
    let a = lo, b = hi;
    for (let i = 0; i < (iter || 120); i++) {
      const m = (a + b) / 2;
      if (fn(m) < target) a = m; else b = m;
    }
    return (a + b) / 2;
  }
  const tCrit = (alpha2, df) => bisect((t) => tCDF(t, df), 1 - alpha2, 0, 200);
  const fCrit = (alpha, d1, d2) => bisect((x) => 1 - fSF(x, d1, d2), 1 - alpha, 0, 5000);
  const chi2Crit = (alpha, k) => bisect((x) => 1 - chi2SF(x, k), 1 - alpha, 0, 5000);

  /* ==================== 描述统计 ==================== */
  const num = (v) => typeof v === 'number' && isFinite(v);

  function mean(x) { return x.reduce((s, v) => s + v, 0) / x.length; }
  function variance(x, m) {
    if (x.length < 2) return NaN;
    const mu = m === undefined ? mean(x) : m;
    return x.reduce((s, v) => s + (v - mu) * (v - mu), 0) / (x.length - 1);
  }
  const sd = (x) => Math.sqrt(variance(x));

  function quantile(sorted, q) {
    const n = sorted.length;
    if (!n) return NaN;
    if (n === 1) return sorted[0];
    const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function describe(raw) {
    const x = raw.filter(num);
    const n = x.length, missing = raw.length - n;
    if (!n) return { n: 0, missing, empty: true };
    const m = mean(x), s = variance(x, m), sdd = Math.sqrt(s);
    const sx = x.slice().sort((a, b) => a - b);
    const med = quantile(sx, 0.5), q1 = quantile(sx, 0.25), q3 = quantile(sx, 0.75);
    let m2 = 0, m3 = 0, m4 = 0;
    x.forEach((v) => { const d = v - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; });
    m2 /= n; m3 /= n; m4 /= n;
    const skew = m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
    const kurt = m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
    const se = sdd / Math.sqrt(n);
    const tcrit = n > 1 ? tCrit(0.025, n - 1) : NaN;
    return {
      n, missing, mean: m, sd: sdd, se, cv: m !== 0 ? sdd / Math.abs(m) : NaN,
      min: sx[0], max: sx[n - 1], median: med, q1, q3, iqr: q3 - q1,
      ciLow: m - tcrit * se, ciHigh: m + tcrit * se,
      skew, kurt, sum: x.reduce((a, b) => a + b, 0),
      skewSE: n > 2 ? Math.sqrt(6 * n * (n - 1) / ((n - 2) * (n + 1) * (n + 3))) : NaN,
    };
  }

  /* ==================== 正态性检验 ==================== */
  function shapiroWilk(raw) {
    const x = raw.filter(num).slice().sort((a, b) => a - b);
    const n = x.length;
    if (n < 3) return null;
    if (n > 5000) return null;
    const m = new Array(n);
    for (let i = 1; i <= n; i++) m[i - 1] = qnorm((i - 0.375) / (n + 0.25));
    const ssumm2 = m.reduce((s, v) => s + v * v, 0);
    const rsn = 1 / Math.sqrt(n);
    const c = m.map((v) => v / Math.sqrt(ssumm2));
    const p5 = (r) => Math.pow(r, 5), p4 = (r) => Math.pow(r, 4), p3 = (r) => Math.pow(r, 3);
    const an = -2.706056 * p5(rsn) + 4.434685 * p4(rsn) - 2.07119 * p3(rsn)
      - 0.147981 * rsn * rsn + 0.221157 * rsn + c[n - 1];
    const a = new Array(n).fill(0);
    if (n > 5) {
      const an1 = -3.582633 * p5(rsn) + 5.682633 * p4(rsn) - 1.752461 * p3(rsn)
        - 0.293762 * rsn * rsn + 0.042981 * rsn + c[n - 2];
      const phi = (ssumm2 - 2 * m[n - 1] * m[n - 1] - 2 * m[n - 2] * m[n - 2])
        / (1 - 2 * an * an - 2 * an1 * an1);
      a[0] = -an; a[1] = -an1; a[n - 1] = an; a[n - 2] = an1;
      for (let i = 2; i < n - 2; i++) a[i] = m[i] / Math.sqrt(phi);
    } else {
      const phi = (ssumm2 - m[n - 1] * m[n - 1]) / (1 - an * an);
      a[0] = -an; a[n - 1] = an;
      for (let i = 1; i < n - 1; i++) a[i] = m[i] / Math.sqrt(phi);
    }
    const mu = mean(x);
    let num2 = 0, den = 0;
    for (let i = 0; i < n; i++) { num2 += a[i] * x[i]; den += (x[i] - mu) * (x[i] - mu); }
    const W = (num2 * num2) / den;
    let p;
    if (n <= 11) {
      const gamma = -2.273 + 0.459 * n;
      const w = -Math.log(gamma - Math.log(1 - W));
      p = normSF(w);
    } else {
      const ln = Math.log(n);
      const mu2 = 0.0038915 * Math.pow(ln, 3) - 0.083751 * ln * ln - 0.31082 * ln - 1.5861;
      const sig = Math.exp(0.0030302 * ln * ln - 0.082676 * ln - 0.4803);
      const z = (Math.log(1 - W) - mu2) / sig;
      p = normSF(z);
    }
    return { W, p, n, method: 'Shapiro–Wilk' };
  }

  function dagostino(raw) {
    const x = raw.filter(num);
    const n = x.length;
    if (n < 8) return null;
    const m = mean(x);
    let m2 = 0, m3 = 0, m4 = 0;
    x.forEach((v) => { const d = v - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; });
    m2 /= n; m3 /= n; m4 /= n;
    const b1 = m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
    const b2 = m2 > 0 ? m4 / (m2 * m2) : 3;
    const Y = Math.sqrt(Math.abs(b1)) * Math.sqrt((n + 1) * (n + 3) / (6 * (n - 2)));
    const beta2 = 3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3) /
      ((n - 2) * (n + 5) * (n + 7) * (n + 9));
    const W2 = -1 + Math.sqrt(2 * (beta2 - 1));
    const W = Math.sqrt(W2);
    const delta = 1 / Math.sqrt(Math.log(W));
    const alpha = Math.sqrt(2 / (W2 - 1));
    const Z1 = delta * Math.asinh(Y / alpha);
    const beta1 = 6 * (n * n - 5 * n + 2) / ((n + 7) * (n + 9)) *
      Math.sqrt(6 * (n + 3) * (n + 5) / (n * (n - 2) * (n - 3)));
    const A = 6 + 8 / beta1 * (2 / beta1 + Math.sqrt(1 + 4 / (beta1 * beta1)));
    const base = (1 - 2 / A) / (1 + b2 * Math.sqrt(2 / (A - 4)));
    const Z2 = ((1 - 2 / (9 * A)) - Math.cbrt(base)) / Math.sqrt(2 / (9 * A));
    const K2 = Z1 * Z1 + Z2 * Z2;
    return { K2, p: chi2SF(K2, 2), Z1, Z2, n, skew: b1, kurt: b2 - 3, method: "D'Agostino–Pearson" };
  }

  function normality(raw) {
    const sw = shapiroWilk(raw);
    const da = dagostino(raw);
    const best = sw || da;
    if (!best) return null;
    return { sw, da, p: best.p, method: best.method };
  }

  /* ==================== 方差齐性 ==================== */
  function levene(groups) {
    const k = groups.length;
    const N = groups.reduce((s, g) => s + g.length, 0);
    if (k < 2 || N - k < 1) return null;
    const z = groups.map((g) => {
      const med = quantile(g.slice().sort((a, b) => a - b), 0.5);
      return g.map((v) => Math.abs(v - med));
    });
    const all = z.flat();
    const grand = mean(all);
    let ssb = 0, ssw = 0;
    z.forEach((g) => {
      const gm = mean(g);
      ssb += g.length * (gm - grand) * (gm - grand);
      g.forEach((v) => { ssw += (v - gm) * (v - gm); });
    });
    const df1 = k - 1, df2 = N - k;
    const F = (ssb / df1) / (ssw / df2);
    return { F, df1, df2, p: fSF(F, df1, df2), method: 'Levene（Brown–Forsythe，以中位数为中心）' };
  }

  /* ==================== t 检验 ==================== */
  function tTestOne(raw, mu0) {
    const x = raw.filter(num);
    const n = x.length;
    if (n < 2) return null;
    const m = mean(x), s = sd(x), se = s / Math.sqrt(n);
    const t = (m - mu0) / se, df = n - 1;
    const tc = tCrit(0.025, df);
    return {
      t, df, p: tSF2(t, df), n, mean: m, sd: s, se, mu0,
      ciLow: m - tc * se, ciHigh: m + tc * se,
      d: (m - mu0) / s,
    };
  }

  function tTestTwo(a, b, welch) {
    const n1 = a.length, n2 = b.length;
    if (n1 < 2 || n2 < 2) return null;
    const m1 = mean(a), m2 = mean(b), v1 = variance(a), v2 = variance(b);
    const se1 = v1 / n1, se2 = v2 / n2;
    const diff = m1 - m2;
    let se, df;
    if (welch) {
      se = Math.sqrt(se1 + se2);
      df = Math.pow(se1 + se2, 2) / (se1 * se1 / (n1 - 1) + se2 * se2 / (n2 - 1));
    } else {
      const sp2 = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
      se = Math.sqrt(sp2 * (1 / n1 + 1 / n2));
      df = n1 + n2 - 2;
    }
    const t = diff / se;
    const tc = tCrit(0.025, df);
    const sp = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
    const d = diff / sp;
    const J = 1 - 3 / (4 * (n1 + n2) - 9);
    return {
      t, df, p: tSF2(t, df), n1, n2, m1, m2, sd1: Math.sqrt(v1), sd2: Math.sqrt(v2),
      diff, se, ciLow: diff - tc * se, ciHigh: diff + tc * se,
      d, g: d * J, welch: !!welch,
    };
  }

  function tTestPaired(a, b) {
    const pairs = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (num(a[i]) && num(b[i])) pairs.push(a[i] - b[i]);
    }
    if (pairs.length < 2) return null;
    const n = pairs.length, m = mean(pairs), s = sd(pairs), se = s / Math.sqrt(n);
    const t = m / se, df = n - 1, tc = tCrit(0.025, df);
    return {
      t, df, p: tSF2(t, df), n, meanDiff: m, sdDiff: s, se,
      ciLow: m - tc * se, ciHigh: m + tc * se, dz: m / s,
      m1: mean(a.filter(num)), m2: mean(b.filter(num)),
    };
  }

  /* ==================== 秩和检验 ==================== */
  function rankWithTies(vals) {
    const idx = vals.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
    const ranks = new Array(vals.length);
    const tieGroups = [];
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
      const r = (i + j + 2) / 2;
      for (let k = i; k <= j; k++) ranks[idx[k].i] = r;
      if (j > i) tieGroups.push(j - i + 1);
      i = j + 1;
    }
    return { ranks, tieGroups };
  }

  /**
   * 无并列秩时 Mann–Whitney U 的精确分布。
   * 动态规划枚举「从 1..N 的秩里选 n1 个」的所有组合数，按秩和累计。
   * N > 30 时组合数已经很大，且正态近似足够好，直接返回 null 走近似。
   */
  function mannWhitneyExact(n1, n2, U) {
    const N = n1 + n2;
    if (N > 30 || n1 < 2 || n2 < 2) return null;
    const maxSum = N * (N + 1) / 2;
    const dp = new Array(n1 + 1);
    for (let j = 0; j <= n1; j++) dp[j] = new Float64Array(maxSum + 1);
    dp[0][0] = 1;
    for (let r = 1; r <= N; r++) {
      for (let j = Math.min(r, n1); j >= 1; j--) {
        for (let s = maxSum; s >= r; s--) {
          if (dp[j - 1][s - r]) dp[j][s] += dp[j - 1][s - r];
        }
      }
    }
    const offset = n1 * (n1 + 1) / 2;
    const idx = U + offset;
    if (idx < 0 || idx > maxSum) return null;
    let total = 0, cum = 0;
    for (let s = 0; s <= maxSum; s++) {
      const c = dp[n1][s];
      if (!c) continue;
      total += c;
      if (s <= idx) cum += c;
    }
    if (!total) return null;
    const pLower = cum / total;
    const pUpper = 1 - pLower + dp[n1][idx] / total;
    return Math.min(1, 2 * Math.min(pLower, pUpper));
  }

  /**
   * Wilcoxon 符号秩的精确分布（无并列时）。n ≤ 25 才枚举，
   * 更大的样本用正态近似；2^25 已经接近百万级组合，再大就没必要了。
   */
  function wilcoxonExact(n, W) {
    if (n > 25 || n < 5) return null;
    const maxSum = n * (n + 1) / 2;
    const dp = new Float64Array(maxSum + 1);
    dp[0] = 1;
    for (let r = 1; r <= n; r++) {
      for (let s = maxSum; s >= r; s--) dp[s] += dp[s - r];
    }
    if (W < 0 || W > maxSum) return null;
    let total = 0, cum = 0;
    for (let s = 0; s <= maxSum; s++) {
      total += dp[s];
      if (s <= W) cum += dp[s];
    }
    if (!total) return null;
    const pLower = cum / total;
    const pUpper = 1 - pLower + dp[W] / total;
    return Math.min(1, 2 * Math.min(pLower, pUpper));
  }

  function mannWhitney(a, b) {
    const n1 = a.length, n2 = b.length, N = n1 + n2;
    if (n1 < 2 || n2 < 2) return null;
    const all = a.concat(b);
    const { ranks, tieGroups } = rankWithTies(all);
    const R1 = ranks.slice(0, n1).reduce((s, v) => s + v, 0);
    const U1 = R1 - n1 * (n1 + 1) / 2;
    const U2 = n1 * n2 - U1;
    const U = Math.min(U1, U2);
    const muU = n1 * n2 / 2;
    let tieTerm = 0;
    tieGroups.forEach((t) => { tieTerm += t * t * t - t; });
    const varU = (n1 * n2 / 12) * ((N + 1) - tieTerm / (N * (N - 1)));
    const sdU = Math.sqrt(varU);
    const z = (U - muU + 0.5 * Math.sign(muU - U)) / sdU;
    const exactP = tieGroups.length === 0 ? mannWhitneyExact(n1, n2, U) : null;
    const p = exactP !== null ? exactP : 2 * normSF(Math.abs((Math.abs(U - muU) - 0.5) / sdU));
    return {
      U, U1, U2, n1, n2, z, p, muU, sdU, exact: exactP !== null,
      r: Math.abs((Math.abs(U - muU) - 0.5) / sdU) / Math.sqrt(N),
      median1: quantile(a.slice().sort((x, y) => x - y), 0.5),
      median2: quantile(b.slice().sort((x, y) => x - y), 0.5),
    };
  }

  function wilcoxon(a, b) {
    const diffs = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (num(a[i]) && num(b[i])) { const d = a[i] - b[i]; if (d !== 0) diffs.push(d); }
    }
    const n = diffs.length;
    if (n < 5) return null;
    const { ranks, tieGroups } = rankWithTies(diffs.map(Math.abs));
    let Wp = 0, Wm = 0;
    diffs.forEach((d, i) => { if (d > 0) Wp += ranks[i]; else Wm += ranks[i]; });
    const W = Math.min(Wp, Wm);
    const muW = n * (n + 1) / 4;
    let tieTerm = 0;
    tieGroups.forEach((t) => { tieTerm += t * t * t - t; });
    const varW = n * (n + 1) * (2 * n + 1) / 24 - tieTerm / 48;
    const sdW = Math.sqrt(varW);
    const z = (Math.abs(W - muW) - 0.5) / sdW;
    const exactP = tieGroups.length === 0 ? wilcoxonExact(n, W) : null;
    const p = exactP !== null ? exactP : 2 * normSF(Math.max(0, z));
    return { W, Wp, Wm, n, z, p, exact: exactP !== null, r: z / Math.sqrt(n) };
  }

  /* ==================== 方差分析 ==================== */
  function oneWayAnova(groups, labels) {
    const k = groups.length;
    const all = groups.flat();
    const N = all.length;
    if (k < 2 || N - k < 1) return null;
    const grand = mean(all);
    let ssb = 0, ssw = 0;
    groups.forEach((g) => {
      const gm = mean(g);
      ssb += g.length * (gm - grand) * (gm - grand);
      g.forEach((v) => { ssw += (v - gm) * (v - gm); });
    });
    const sst = ssb + ssw;
    const df1 = k - 1, df2 = N - k;
    const msb = ssb / df1, msw = ssw / df2;
    const F = msb / msw;
    return {
      F, df1, df2, p: fSF(F, df1, df2), ssb, ssw, sst, msb, msw,
      eta2: ssb / sst,
      omega2: (ssb - df1 * msw) / (sst + msw),
      k, N, grand, labels,
      groupStats: groups.map((g, i) => ({
        label: labels[i], n: g.length, mean: mean(g), sd: sd(g),
        se: sd(g) / Math.sqrt(g.length),
      })),
    };
  }

  function kruskalWallis(groups, labels) {
    const k = groups.length;
    const all = groups.flat();
    const N = all.length;
    if (k < 2 || N < 3) return null;
    const { ranks, tieGroups } = rankWithTies(all);
    let off = 0;
    const rankSums = [];
    groups.forEach((g) => {
      let s = 0;
      for (let i = 0; i < g.length; i++) s += ranks[off + i];
      rankSums.push(s);
      off += g.length;
    });
    let H = 0;
    groups.forEach((g, i) => { H += rankSums[i] * rankSums[i] / g.length; });
    H = (12 / (N * (N + 1))) * H - 3 * (N + 1);
    let tieTerm = 0;
    tieGroups.forEach((t) => { tieTerm += t * t * t - t; });
    const corr = 1 - tieTerm / (N * N * N - N);
    if (corr > 0) H = H / corr;
    const df = k - 1;
    const eps2 = (H - k + 1) / (N - k);
    return {
      H, df, p: chi2SF(H, df), k, N, labels,
      eps2: Math.max(0, eps2),
      medianStats: groups.map((g, i) => ({
        label: labels[i], n: g.length,
        median: quantile(g.slice().sort((a, b) => a - b), 0.5),
        meanRank: rankSums[i] / g.length,
      })),
      rankSums, tieTerm, corr,
    };
  }

  /* ==================== 多重比较校正 ==================== */
  function adjustP(pvals, method) {
    const n = pvals.length;
    const idx = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
    const out = new Array(n);
    if (method === 'bonf') {
      pvals.forEach((p, i) => { out[i] = Math.min(1, p * n); });
      return out;
    }
    if (method === 'none') return pvals.slice();
    // Holm
    let running = 0;
    idx.forEach((o, rank) => {
      const adj = Math.min(1, o.p * (n - rank));
      running = Math.max(running, adj);
      out[o.i] = running;
    });
    return out;
  }

  /** 两两比较：方差齐则合并方差 t，不齐则 Welch；可选 Holm / Bonferroni */
  function pairwise(groups, labels, opts) {
    const o = opts || {};
    const method = o.method || 'welch';
    const rows = [];
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        let r = null;
        if (method === 'mw') r = mannWhitney(groups[i], groups[j]);
        else r = tTestTwo(groups[i], groups[j], method === 'welch');
        if (!r) continue;
        rows.push({
          a: labels[i], b: labels[j],
          diff: r.diff !== undefined ? r.diff : r.median1 - r.median2,
          stat: r.t !== undefined ? r.t : r.U,
          statName: r.t !== undefined ? 't' : 'U',
          df: r.df, p: r.p,
        });
      }
    }
    const adj = adjustP(rows.map((r) => r.p), o.adjust || 'holm');
    rows.forEach((r, i) => { r.pAdj = adj[i]; });
    return rows;
  }

  /**
   * 用「插入-吸收」法把两两比较结果转成 a/b/c 字母标记（compact letter display）。
   * 共享字母 = 差异不显著，字母完全不同 = 差异显著。
   * 比在一张图上堆十几条括号干净得多，是农学、生态、药理论文的常见写法。
   */
  function compactLetters(labels, rows, alpha) {
    const n = labels.length;
    if (!n) return {};
    const a = Number(alpha) || 0.05;
    const sig = labels.map(() => new Array(n).fill(false));
    (rows || []).forEach((r) => {
      if (!(r.pAdj < a)) return;
      const i = labels.indexOf(r.a), j = labels.indexOf(r.b);
      if (i >= 0 && j >= 0 && i !== j) { sig[i][j] = true; sig[j][i] = true; }
    });

    let cols = [labels.map((_, i) => i)];
    for (let guard = 0; guard < 500; guard++) {
      let changed = false;
      for (let c = 0; c < cols.length && !changed; c++) {
        const col = cols[c];
        for (let x = 0; x < col.length && !changed; x++) {
          for (let y = x + 1; y < col.length && !changed; y++) {
            if (!sig[col[x]][col[y]]) continue;
            // 一对显著差异无法共享字母：拆成「去掉一个」的两列继续处理
            cols.splice(c, 1, col.filter((k) => k !== col[x]), col.filter((k) => k !== col[y]));
            changed = true;
          }
        }
      }
      if (!changed) break;
    }

    const keyOf = (col) => col.slice().sort((x, y) => x - y).join(',');
    const uniq = [];
    const seen = new Set();
    cols.forEach((col) => {
      if (!col.length) return;
      const k = keyOf(col);
      if (seen.has(k)) return;
      seen.add(k);
      uniq.push(col.slice().sort((x, y) => x - y));
    });
    // 被其他列完全包含的列没有提供新信息，去掉
    const kept = uniq.filter((col, idx) =>
      !uniq.some((other, jdx) => jdx !== idx && other.length > col.length && col.every((k) => other.indexOf(k) >= 0)));

    kept.sort((x, y) => x[0] - y[0] || y.length - x.length);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const out = {};
    labels.forEach((l) => { out[l] = ''; });
    kept.forEach((col, ci) => {
      const ch = alphabet[ci] || '#';
      col.forEach((k) => { out[labels[k]] += ch; });
    });
    Object.keys(out).forEach((k) => { out[k] = out[k].split('').sort().join(''); });
    return out;
  }

  /* ==================== 相关 ==================== */
  function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (!num(a[i]) || !num(b[i])) continue;
      sx += a[i]; sy += b[i]; sxx += a[i] * a[i]; syy += b[i] * b[i]; sxy += a[i] * b[i]; cnt++;
    }
    if (cnt < 3) return null;
    const cov = sxy - sx * sy / cnt;
    const vx = sxx - sx * sx / cnt, vy = syy - sy * sy / cnt;
    if (vx <= 0 || vy <= 0) return null;
    const r = cov / Math.sqrt(vx * vy);
    const t = r * Math.sqrt((cnt - 2) / (1 - r * r));
    return { r, n: cnt, t, df: cnt - 2, p: tSF2(t, cnt - 2) };
  }

  function spearman(a, b) {
    const pairs = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (num(a[i]) && num(b[i])) pairs.push([a[i], b[i]]);
    }
    if (pairs.length < 3) return null;
    const ra = rankWithTies(pairs.map((p) => p[0])).ranks;
    const rb = rankWithTies(pairs.map((p) => p[1])).ranks;
    const res = pearson(ra, rb);
    if (!res) return null;
    return { rho: res.r, r: res.r, n: res.n, t: res.t, df: res.df, p: res.p };
  }

  function corrMatrix(cols, method) {
    const k = cols.length;
    const mat = [];
    for (let i = 0; i < k; i++) {
      mat.push(new Array(k).fill(1));
      for (let j = 0; j < i; j++) {
        const r = method === 'spearman'
          ? spearman(cols[i].values, cols[j].values)
          : pearson(cols[i].values, cols[j].values);
        const v = r ? (r.r !== undefined ? r.r : r.rho) : NaN;
        mat[i][j] = v; mat[j][i] = v;
      }
    }
    return mat;
  }

  /* ==================== 线性回归 ==================== */
  function matInverse(A) {
    const n = A.length;
    const M = A.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      const p = M[c][c];
      for (let j = 0; j < 2 * n; j++) M[c][j] /= p;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f === 0) continue;
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map((row) => row.slice(n));
  }

  function ols(y, predictors, names) {
    const rows = [];
    for (let i = 0; i < y.length; i++) {
      if (!num(y[i])) continue;
      if (predictors.some((p) => !num(p[i]))) continue;
      rows.push(i);
    }
    const n = rows.length, k = predictors.length;
    if (n <= k + 1) return null;
    const X = rows.map((i) => [1].concat(predictors.map((p) => p[i])));
    const Y = rows.map((i) => y[i]);
    const XtX = [];
    for (let a = 0; a <= k; a++) {
      XtX.push(new Array(k + 1).fill(0));
      for (let b = 0; b <= k; b++) {
        let s = 0;
        for (let r = 0; r < n; r++) s += X[r][a] * X[r][b];
        XtX[a][b] = s;
      }
    }
    const inv = matInverse(XtX);
    if (!inv) return null;
    const Xty = new Array(k + 1).fill(0);
    for (let a = 0; a <= k; a++) {
      let s = 0;
      for (let r = 0; r < n; r++) s += X[r][a] * Y[r];
      Xty[a] = s;
    }
    const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
    const fitted = X.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
    const residuals = Y.map((v, i) => v - fitted[i]);
    const meanY = mean(Y);
    const sst = Y.reduce((s, v) => s + (v - meanY) * (v - meanY), 0);
    const sse = residuals.reduce((s, v) => s + v * v, 0);
    const dfErr = n - k - 1;
    const mse = sse / dfErr;
    const se = beta.map((_, j) => Math.sqrt(mse * inv[j][j]));
    const dfModel = k;
    const F = dfModel > 0 ? ((sst - sse) / dfModel) / mse : NaN;
    const tc = tCrit(0.025, dfErr);
    const coef = beta.map((b, j) => {
      const t = b / se[j];
      return {
        name: j === 0 ? '（截距）' : names[j - 1],
        b, se: se[j], t, p: tSF2(t, dfErr),
        ciLow: b - tc * se[j], ciHigh: b + tc * se[j],
        std: j === 0 ? null : b * sd(predictors[j - 1].filter(num)) / sd(Y),
      };
    });
    // VIF
    const vif = names.map((nm, j) => {
      if (k < 2) return 1;
      const others = predictors.filter((_, i2) => i2 !== j);
      const otherNames = names.filter((_, i2) => i2 !== j);
      const sub = ols(predictors[j], others, otherNames);
      if (!sub) return NaN;
      return 1 / Math.max(1e-9, 1 - sub.r2);
    });
    // Durbin-Watson
    let dwNum = 0, dwDen = 0;
    for (let i = 0; i < residuals.length; i++) {
      dwDen += residuals[i] * residuals[i];
      if (i > 0) dwNum += Math.pow(residuals[i] - residuals[i - 1], 2);
    }
    return {
      n, k, coef, r2: 1 - sse / sst,
      adjR2: 1 - (sse / dfErr) / (sst / (n - 1)),
      F, pF: dfModel > 0 ? fSF(F, dfModel, dfErr) : NaN,
      dfModel, dfErr, sse, sst, mse, rmse: Math.sqrt(mse),
      residuals, fitted, y: Y,
      durbinWatson: dwNum / dwDen, vif, names,
    };
  }

  /* ==================== 卡方 ==================== */
  function chiSquare(table, rowLabels, colLabels) {
    const r = table.length, c = table[0].length;
    const rowSum = table.map((row) => row.reduce((s, v) => s + v, 0));
    const colSum = new Array(c).fill(0);
    table.forEach((row) => row.forEach((v, j) => { colSum[j] += v; }));
    const N = rowSum.reduce((s, v) => s + v, 0);
    if (!N) return null;
    const expected = table.map((row, i) => row.map((_, j) => rowSum[i] * colSum[j] / N));
    let chi2 = 0, minExp = Infinity, lowCount = 0;
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < c; j++) {
        const e = expected[i][j];
        if (e > 0) chi2 += Math.pow(table[i][j] - e, 2) / e;
        minExp = Math.min(minExp, e);
        if (e < 5) lowCount++;
      }
    }
    const df = (r - 1) * (c - 1);
    return {
      chi2, df, p: chi2SF(chi2, df), N, expected, minExp, lowCount,
      cramersV: Math.sqrt(chi2 / (N * Math.min(r - 1, c - 1))),
      rowLabels, colLabels, table,
    };
  }

  /* ==================== 效应量 ==================== */
  function cohensD(a, b) {
    const n1 = a.length, n2 = b.length;
    const v1 = variance(a), v2 = variance(b);
    const sp = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
    return (mean(a) - mean(b)) / sp;
  }
  function hedgesG(a, b) {
    const d = cohensD(a, b);
    const J = 1 - 3 / (4 * (a.length + b.length) - 9);
    return d * J;
  }
  function effectLabel(d) {
    const x = Math.abs(d);
    if (x < 0.2) return '可忽略';
    if (x < 0.5) return '小';
    if (x < 0.8) return '中等';
    return '大';
  }

  /* ==================== 工具：分组 ==================== */
  function groupBy(values, nums) {
    const map = new Map();
    for (let i = 0; i < values.length; i++) {
      if (!num(nums[i])) continue;
      const k = values[i] === null || values[i] === undefined || values[i] === '' ? '（空）' : String(values[i]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(nums[i]);
    }
    return map;
  }

  function contingency(xVals, yVals) {
    const rows = new Map(), cols = new Map();
    const pairs = [];
    for (let i = 0; i < xVals.length; i++) {
      const x = xVals[i], y = yVals[i];
      if (x === null || x === undefined || x === '' || y === null || y === undefined || y === '') continue;
      const xs = String(x), ys = String(y);
      rows.set(xs, (rows.get(xs) || 0) + 1);
      cols.set(ys, (cols.get(ys) || 0) + 1);
      pairs.push([xs, ys]);
    }
    const rl = Array.from(rows.keys()), cl = Array.from(cols.keys());
    const table = rl.map((r) => cl.map((c) => {
      let cnt = 0;
      pairs.forEach((p) => { if (p[0] === r && p[1] === c) cnt++; });
      return cnt;
    }));
    return { table, rowLabels: rl, colLabels: cl };
  }

  LD.stats = {
    // 分布
    normCDF, normSF, qnorm, tCDF, tSF1, tSF2, fSF, chi2SF, tCrit, fCrit, chi2Crit, betai, lgamma,
    // 描述
    mean, variance, sd, quantile, describe, num,
    // 检验
    shapiroWilk, dagostino, normality, levene,
    tTestOne, tTestTwo, tTestPaired, mannWhitney, wilcoxon,
    mannWhitneyExact, wilcoxonExact,
    oneWayAnova, kruskalWallis, adjustP, pairwise, compactLetters,
    pearson, spearman, corrMatrix, ols, chiSquare,
    cohensD, hedgesG, effectLabel,
    groupBy, contingency, rankWithTies,
  };
})();
