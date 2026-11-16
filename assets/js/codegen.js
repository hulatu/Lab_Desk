/* LabDesk · 复现代码生成（Python / R） */
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;

  const pyStr = (s) => JSON.stringify(String(s));
  const rStr = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
  const pyList = (arr) => '[' + arr.map(pyStr).join(', ') + ']';
  const rList = (arr) => 'c(' + arr.map(rStr).join(', ') + ')';

  const AGG_PY = { mean: 'mean', sd: 'std', se: 'sem', median: 'median', count: 'count', sum: 'sum', min: 'min', max: 'max', cv: 'cv' };

  /* ---------------- 流水线 → pandas / dplyr ---------------- */
  function pyPipeline(pipeline) {
    const out = [];
    (pipeline || []).forEach((st) => {
      const p = st.params || {};
      switch (st.type) {
        case 'missing':
          if (p.action === 'drop') out.push(`df = df.dropna(subset=${pyList(p.cols || [])})`);
          else if (p.action === 'mean' || p.action === 'median')
            out.push(`df[${pyList(p.cols || [])}] = df[${pyList(p.cols || [])}].fillna(df[${pyList(p.cols || [])}].${p.action}())`);
          else if (p.action === 'mode')
            out.push(`df[${pyList(p.cols || [])}] = df[${pyList(p.cols || [])}].fillna(df[${pyList(p.cols || [])}].mode().iloc[0])`);
          else if (p.action === 'zero')
            out.push(`df[${pyList(p.cols || [])}] = df[${pyList(p.cols || [])}].fillna(0)`);
          else if (p.action === 'ffill')
            out.push(`df[${pyList(p.cols || [])}] = df[${pyList(p.cols || [])}].ffill()`);
          else if (p.action === 'interp')
            out.push(`df[${pyList(p.cols || [])}] = df[${pyList(p.cols || [])}].interpolate(method="linear")`);
          else if (p.action === 'value')
            out.push(`df[${pyList(p.cols || [])}] = df[${pyList(p.cols || [])}].fillna(${pyStr(p.value)})`);
          break;
        case 'outlier': {
          const cols = p.cols && p.cols.length ? p.cols : [];
          const k = p.k || 1.5;
          if (p.method === 'z') {
            out.push(`# 异常值：|Z| > ${k}`);
            cols.forEach((c) => {
              out.push(`_z = (df[${pyStr(c)}] - df[${pyStr(c)}].mean()) / df[${pyStr(c)}].std()`);
              if (p.action === 'remove') out.push(`df = df[_z.abs() <= ${k}]`);
              else if (p.action === 'winsor') out.push(`df.loc[_z.abs() > ${k}, ${pyStr(c)}] = df[${pyStr(c)}].mean() + np.sign(_z[_z.abs() > ${k}]) * ${k} * df[${pyStr(c)}].std()`);
              else out.push(`df[${pyStr('异常_' + c)}] = np.where(_z.abs() > ${k}, "是", "否")`);
            });
          } else if (p.method === 'mad') {
            cols.forEach((c) => {
              out.push(`_med = df[${pyStr(c)}].median(); _mad = (df[${pyStr(c)}] - _med).abs().median() * 1.4826`);
              if (p.action === 'remove') out.push(`df = df[(df[${pyStr(c)}] - _med).abs() <= ${k} * _mad]`);
              else out.push(`df[${pyStr('异常_' + c)}] = np.where((df[${pyStr(c)}] - _med).abs() > ${k} * _mad, "是", "否")`);
            });
          } else {
            cols.forEach((c) => {
              out.push(`_q1, _q3 = df[${pyStr(c)}].quantile([.25, .75]); _iqr = _q3 - _q1`);
              if (p.action === 'remove') out.push(`df = df[df[${pyStr(c)}].between(_q1 - ${k} * _iqr, _q3 + ${k} * _iqr)]`);
              else if (p.action === 'winsor') out.push(`df[${pyStr(c)}] = df[${pyStr(c)}].clip(_q1 - ${k} * _iqr, _q3 + ${k} * _iqr)`);
              else out.push(`df[${pyStr('异常_' + c)}] = np.where(~df[${pyStr(c)}].between(_q1 - ${k} * _iqr, _q3 + ${k} * _iqr), "是", "否")`);
            });
          }
          break;
        }
        case 'transform': {
          const fnMap = { log10: 'np.log10', ln: 'np.log', log1p: 'np.log1p', sqrt: 'np.sqrt', square: 'np.square', abs: 'np.abs', reciprocal: null };
          (p.cols || []).forEach((c) => {
            const target = p.newCol ? `${c}_${p.method}` : c;
            if (fnMap[p.method]) out.push(`df[${pyStr(target)}] = ${fnMap[p.method]}(df[${pyStr(c)}])`);
            else if (p.method === 'zscore') out.push(`df[${pyStr(target)}] = (df[${pyStr(c)}] - df[${pyStr(c)}].mean()) / df[${pyStr(c)}].std()`);
            else if (p.method === 'minmax') out.push(`df[${pyStr(target)}] = (df[${pyStr(c)}] - df[${pyStr(c)}].min()) / (df[${pyStr(c)}].max() - df[${pyStr(c)}].min())`);
            else if (p.method === 'center') out.push(`df[${pyStr(target)}] = df[${pyStr(c)}] - df[${pyStr(c)}].mean()`);
            else if (p.method === 'reciprocal') out.push(`df[${pyStr(target)}] = 1 / df[${pyStr(c)}]`);
          });
          break;
        }
        case 'derive': {
          const expr = String(p.expr || '')
            .replace(/\[([^\]]+)\]/g, (m, c) => `df[${pyStr(c.trim())}]`)
            .replace(/\bln\(/g, 'np.log(').replace(/\blog10\(/g, 'np.log10(')
            .replace(/\bsqrt\(/g, 'np.sqrt(').replace(/\babs\(/g, 'np.abs(')
            .replace(/\bifnull\(/g, 'np.where(');
          out.push(`df[${pyStr(p.name)}] = ${expr}`);
          break;
        }
        case 'filter': {
          const ops = { gt: '>', ge: '>=', lt: '<', le: '<=', eq: '==', ne: '!=' };
          if (ops[p.op]) out.push(`df = df[df[${pyStr(p.col)}] ${ops[p.op]} ${isNaN(Number(p.value)) ? pyStr(p.value) : p.value}]`);
          else if (p.op === 'contains') out.push(`df = df[df[${pyStr(p.col)}].astype(str).str.contains(${pyStr(p.value)})]`);
          else if (p.op === 'ncontains') out.push(`df = df[~df[${pyStr(p.col)}].astype(str).str.contains(${pyStr(p.value)})]`);
          else if (p.op === 'isnull') out.push(`df = df[df[${pyStr(p.col)}].isna()]`);
          else if (p.op === 'notnull') out.push(`df = df[df[${pyStr(p.col)}].notna()]`);
          break;
        }
        case 'dedupe':
          out.push(`df = df.drop_duplicates(${p.cols && p.cols.length ? `subset=${pyList(p.cols)}` : ''})`);
          break;
        case 'sort':
          out.push(`df = df.sort_values(${pyStr(p.col)}, ascending=${p.desc ? 'False' : 'True'}).reset_index(drop=True)`);
          break;
        case 'round':
          out.push(`df[${pyList(p.cols || [])}] = df[${pyList(p.cols || [])}].round(${p.digits || 0})`);
          break;
        case 'bin':
          out.push(`df[${pyStr(p.name || p.col + '_分组')}] = pd.${p.method === 'quantile' ? 'qcut' : 'cut'}(df[${pyStr(p.col)}], ${p.bins || 4})`);
          break;
        case 'aggregate': {
          const aggs = (p.aggs && p.aggs.length) ? p.aggs : [{ col: p.aggCol, fn: p.aggFn || 'mean' }];
          const g = p.groupBy && p.groupBy.length ? p.groupBy : [p.col || 'group'];
          const fn = aggs[0].fn === 'se' ? 'sem' : (AGG_PY[aggs[0].fn] || 'mean');
          out.push(`df = df.groupby(${pyList(g)}, as_index=False).agg(${pyStr(aggs[0].col + '_' + (aggs[0].fn || 'mean'))}=(${pyStr(aggs[0].col)}, ${pyStr(fn)}))`);
          break;
        }
        case 'melt':
          out.push(`df = df.melt(id_vars=${pyList(p.idCols || [])}, value_vars=${pyList(p.valueCols || [])}, var_name=${pyStr(p.varName || '变量')}, value_name=${pyStr(p.valName || '数值')})`);
          break;
        case 'pivot':
          out.push(`df = df.pivot_table(index=${pyStr(p.idCol)}, columns=${pyStr(p.varCol)}, values=${pyStr(p.valCol)}).reset_index()`);
          break;
        case 'dropcol':
          out.push(`df = df.drop(columns=${pyList(p.cols || [])})`);
          break;
        case 'rename':
          out.push(`df = df.rename(columns={${pyStr(p.col)}: ${pyStr(p.name)}})`);
          break;
        case 'sampleRows':
          out.push(p.method === 'random' ? `df = df.sample(n=${p.n})` : `df = df.head(${p.n})`);
          break;
        default: break;
      }
    });
    return out;
  }

  function rPipeline(pipeline) {
    const out = [];
    (pipeline || []).forEach((st) => {
      const p = st.params || {};
      switch (st.type) {
        case 'missing':
          if (p.action === 'drop') out.push(`df <- df %>% drop_na(all_of(${rList(p.cols || [])}))`);
          else if (p.action === 'mean') out.push(`df <- df %>% mutate(across(all_of(${rList(p.cols || [])}), ~ ifelse(is.na(.x), mean(.x, na.rm = TRUE), .x)))`);
          else if (p.action === 'median') out.push(`df <- df %>% mutate(across(all_of(${rList(p.cols || [])}), ~ ifelse(is.na(.x), median(.x, na.rm = TRUE), .x)))`);
          else if (p.action === 'interp') out.push(`df <- df %>% mutate(across(all_of(${rList(p.cols || [])}), ~ zoo::na.approx(.x, na.rm = FALSE)))`);
          else if (p.action === 'ffill') out.push(`df <- df %>% fill(all_of(${rList(p.cols || [])}), .direction = "down")`);
          else if (p.action === 'zero') out.push(`df <- df %>% mutate(across(all_of(${rList(p.cols || [])}), ~ replace_na(.x, 0)))`);
          break;
        case 'outlier': {
          const k = p.k || 1.5;
          (p.cols || []).forEach((c) => {
            if (p.method === 'iqr') {
              if (p.action === 'remove') out.push(`df <- df %>% filter(.data[[${rStr(c)}]] %>% between(quantile(., .25, na.rm = TRUE) - ${k} * IQR(., na.rm = TRUE), quantile(., .75, na.rm = TRUE) + ${k} * IQR(., na.rm = TRUE)))`);
              else out.push(`df <- df %>% mutate(${rStr('异常_' + c)} := ifelse(.data[[${rStr(c)}]] %>% between(quantile(., .25, na.rm = TRUE) - ${k} * IQR(., na.rm = TRUE), quantile(., .75, na.rm = TRUE) + ${k} * IQR(., na.rm = TRUE)), "否", "是"))`);
            } else {
              out.push(`# 对 ${c} 使用 ${p.method} 判别（阈值 ${k}）`);
            }
          });
          break;
        }
        case 'transform': {
          const fnMap = { log10: 'log10', ln: 'log', log1p: 'log1p', sqrt: 'sqrt', square: null, abs: 'abs' };
          (p.cols || []).forEach((c) => {
            const target = p.newCol ? `${c}_${p.method}` : c;
            if (fnMap[p.method]) out.push(`df <- df %>% mutate(${rStr(target)} := ${fnMap[p.method]}(.data[[${rStr(c)}]]))`);
            else if (p.method === 'zscore') out.push(`df <- df %>% mutate(${rStr(target)} := as.numeric(scale(.data[[${rStr(c)}]])))`);
            else if (p.method === 'minmax') out.push(`df <- df %>% mutate(${rStr(target)} := (.data[[${rStr(c)}]] - min(.data[[${rStr(c)}]], na.rm = TRUE)) / diff(range(.data[[${rStr(c)}]], na.rm = TRUE)))`);
          });
          break;
        }
        case 'derive': {
          const expr = String(p.expr || '').replace(/\[([^\]]+)\]/g, (m, c) => `.data[[${rStr(c.trim())}]]`)
            .replace(/\bln\(/g, 'log(').replace(/\babs\(/g, 'abs(').replace(/\bsqrt\(/g, 'sqrt(');
          out.push(`df <- df %>% mutate(${rStr(p.name)} := ${expr})`);
          break;
        }
        case 'filter': {
          const ops = { gt: '>', ge: '>=', lt: '<', le: '<=', eq: '==', ne: '!=' };
          if (ops[p.op]) out.push(`df <- df %>% filter(.data[[${rStr(p.col)}]] ${ops[p.op]} ${isNaN(Number(p.value)) ? rStr(p.value) : p.value})`);
          else if (p.op === 'contains') out.push(`df <- df %>% filter(str_detect(as.character(.data[[${rStr(p.col)}]]), ${rStr(p.value)}))`);
          break;
        }
        case 'dedupe':
          out.push(`df <- df %>% distinct(${p.cols && p.cols.length ? `across(all_of(${rList(p.cols)})), .keep_all = TRUE` : ''})`);
          break;
        case 'sort':
          out.push(`df <- df %>% arrange(${p.desc ? 'desc' : ''}(.data[[${rStr(p.col)}]]))`);
          break;
        case 'round':
          out.push(`df <- df %>% mutate(across(all_of(${rList(p.cols || [])}), ~ round(.x, ${p.digits || 0})))`);
          break;
        case 'bin':
          out.push(`df <- df %>% mutate(${rStr(p.name || p.col + '_分组')} := cut(.data[[${rStr(p.col)}]], breaks = ${p.bins || 4}))`);
          break;
        case 'aggregate': {
          const aggs = (p.aggs && p.aggs.length) ? p.aggs : [{ col: p.aggCol, fn: p.aggFn || 'mean' }];
          const g = p.groupBy && p.groupBy.length ? p.groupBy : ['group'];
          const fnMap = { mean: 'mean', sd: 'sd', se: 'se', median: 'median', count: 'n', sum: 'sum', min: 'min', max: 'max' };
          out.push(`df <- df %>% group_by(across(all_of(${rList(g)}))) %>% summarise(${rStr(aggs[0].col + '_' + aggs[0].fn)} := ${fnMap[aggs[0].fn] || 'mean'}(.data[[${rStr(aggs[0].col)}]], na.rm = TRUE), .groups = "drop")`);
          break;
        }
        case 'melt':
          out.push(`df <- df %>% pivot_longer(cols = all_of(${rList(p.valueCols || [])}), names_to = ${rStr(p.varName || '变量')}, values_to = ${rStr(p.valName || '数值')})`);
          break;
        case 'pivot':
          out.push(`df <- df %>% pivot_wider(names_from = ${rStr(p.varCol)}, values_from = ${rStr(p.valCol)})`);
          break;
        case 'dropcol':
          out.push(`df <- df %>% select(-all_of(${rList(p.cols || [])}))`);
          break;
        case 'rename':
          out.push(`df <- df %>% rename(${rStr(p.name)} := ${rStr(p.col)})`);
          break;
        default: break;
      }
    });
    return out;
  }

  /* ---------------- 统计部分 ---------------- */
  function pyAnalysis(analysis, ds) {
    if (!analysis) return ['# 尚未运行统计检验；可在此处补充，例如：', '# from scipy import stats', '# print(stats.ttest_ind(df["A"], df["B"]))'];
    const p = analysis.params || {};
    const L = [];
    L.push('# ---------- 统计分析 ----------');
    L.push('from scipy import stats');
    L.push('import statsmodels.api as sm');
    L.push('import statsmodels.formula.api as smf');
    L.push('');
    const y = p.y, g = p.g, x = p.x;
    switch (analysis.family) {
      case 'normality':
        L.push(`x = df[${pyStr(y)}].dropna()`);
        L.push('print("Shapiro-Wilk:", stats.shapiro(x))');
        L.push('print("D\'Agostino K^2:", stats.normaltest(x))');
        break;
      case 'ttest1':
        L.push(`print(stats.ttest_1samp(df[${pyStr(y)}].dropna(), popmean=${p.mu0 || 0}))`);
        break;
      case 'ttest2':
        L.push(`a = df.loc[df[${pyStr(g)}] == ${pyStr(p.groupA)}, ${pyStr(y)}].dropna()`);
        L.push(`b = df.loc[df[${pyStr(g)}] == ${pyStr(p.groupB)}, ${pyStr(y)}].dropna()`);
        L.push('print("Levene:", stats.levene(a, b))');
        L.push('print("Welch t:", stats.ttest_ind(a, b, equal_var=False))');
        break;
      case 'ttestp':
        L.push(`print(stats.ttest_rel(df[${pyStr(y)}], df[${pyStr(x)}]))`);
        break;
      case 'mw':
        L.push(`a = df.loc[df[${pyStr(g)}] == ${pyStr(p.groupA)}, ${pyStr(y)}].dropna()`);
        L.push(`b = df.loc[df[${pyStr(g)}] == ${pyStr(p.groupB)}, ${pyStr(y)}].dropna()`);
        L.push('print(stats.mannwhitneyu(a, b, alternative="two-sided"))');
        break;
      case 'wilcox':
        L.push(`print(stats.wilcoxon(df[${pyStr(y)}], df[${pyStr(x)}]))`);
        break;
      case 'anova':
        L.push(`model = smf.ols(${pyStr(y + ' ~ C(' + g + ')')}, data=df).fit()`);
        L.push('print(sm.stats.anova_lm(model, typ=2))');
        L.push('# 事后两两比较（Holm 校正）');
        L.push('from statsmodels.stats.multicomp import pairwise_tukeyhsd');
        L.push(`print(pairwise_tukeyhsd(df[${pyStr(y)}], df[${pyStr(g)}]))`);
        L.push('# 注意：界面上的事后比较是 Welch / 合并方差 t + Holm，而这里是 Tukey HSD（假设方差齐）。');
        L.push('# 若要与界面完全一致，请用 scipy.stats.ttest_ind 逐对检验，再用 statsmodels.stats.multitest.multipletests(method="holm") 校正。');
        break;
      case 'kruskal':
        L.push(`groups = [v.dropna().values for _, v in df.groupby(${pyStr(g)})[${pyStr(y)}]]`);
        L.push('print(stats.kruskal(*groups))');
        L.push('# 事后：Dunn 检验（需 scikit-posthocs）');
        L.push('# import scikit_posthocs as sp');
        L.push(`# print(sp.posthoc_dunn(df, val_col=${pyStr(y)}, group_col=${pyStr(g)}, p_adjust="holm"))`);
        break;
      case 'corr':
        L.push(`print("Pearson:", stats.pearsonr(df[${pyStr(y)}], df[${pyStr(x)}]))`);
        L.push(`print("Spearman:", stats.spearmanr(df[${pyStr(y)}], df[${pyStr(x)}]))`);
        break;
      case 'reg': {
        const xs = p.xs || [x];
        L.push(`model = smf.ols(${pyStr(y + ' ~ ' + xs.join(' + '))}, data=df).fit()`);
        L.push('print(model.summary())');
        break;
      }
      case 'chisq':
        L.push(`tab = pd.crosstab(df[${pyStr(y)}], df[${pyStr(x)}])`);
        L.push('print(tab)');
        L.push('chi2, p, dof, exp = stats.chi2_contingency(tab)');
        L.push('print(f"chi2={chi2:.3f}, df={dof}, p={p:.4g}")');
        break;
      default: break;
    }
    return L;
  }

  function rAnalysis(analysis) {
    if (!analysis) return ['# 尚未运行统计检验'];
    const p = analysis.params || {};
    const L = ['# ---------- 统计分析 ----------'];
    const y = p.y, g = p.g, x = p.x;
    switch (analysis.family) {
      case 'normality':
        L.push(`shapiro.test(df$${y})`);
        L.push('# install.packages("moments"); moments::agostino.test(df$' + y + ')');
        break;
      case 'ttest1': L.push(`t.test(df$${y}, mu = ${p.mu0 || 0})`); break;
      case 'ttest2':
        L.push(`t.test(${y} ~ ${g}, data = df, var.equal = FALSE)`);
        L.push('car::leveneTest(' + `${y} ~ ${g}, data = df)`);
        break;
      case 'ttestp': L.push(`t.test(df$${y}, df$${x}, paired = TRUE)`); break;
      case 'mw': L.push(`wilcox.test(${y} ~ ${g}, data = df, exact = FALSE)`); break;
      case 'wilcox': L.push(`wilcox.test(df$${y}, df$${x}, paired = TRUE, exact = FALSE)`); break;
      case 'anova':
        L.push(`fit <- aov(${y} ~ ${g}, data = df)`);
        L.push('summary(fit)');
        L.push('TukeyHSD(fit)');
        L.push('# 注意：界面上的事后比较是 Welch / 合并方差 t + Holm，而 TukeyHSD 假设方差齐。');
        break;
      case 'kruskal':
        L.push(`kruskal.test(${y} ~ ${g}, data = df)`);
        L.push('# install.packages("dunn.test"); dunn.test::dunn.test(df$' + y + ', df$' + g + ', method = "holm")');
        break;
      case 'corr':
        L.push(`cor.test(df$${y}, df$${x}, method = "pearson")`);
        L.push(`cor.test(df$${y}, df$${x}, method = "spearman")`);
        break;
      case 'reg': {
        const xs = (p.xs || [x]).join(' + ');
        L.push(`fit <- lm(${y} ~ ${xs}, data = df)`);
        L.push('summary(fit)');
        break;
      }
      case 'chisq':
        L.push(`tab <- table(df$${y}, df$${x})`);
        L.push('chisq.test(tab)');
        break;
      default: break;
    }
    return L;
  }

  /* ---------------- 绘图部分 ---------------- */
  function pyChart(chart) {
    if (!chart) return ['# 尚未配置图表'];
    const { type, enc, style } = chart;
    const L = [];
    const w = (style.widthMM / 25.4).toFixed(3);
    const h = (style.heightMM / 25.4).toFixed(3);
    L.push('# ---------- 出版级作图 ----------');
    L.push('import matplotlib as mpl');
    L.push('import matplotlib.pyplot as plt');
    L.push('import seaborn as sns');
    L.push('');
    L.push('mpl.rcParams.update({');
    L.push(`    "font.family": ${pyStr(style.fontFamily.replace(/"/g, ''))},`);
    L.push(`    "font.size": ${style.fontSize},`);
    L.push(`    "axes.linewidth": ${style.lineWidth},`);
    L.push(`    "xtick.direction": ${pyStr(style.tickIn ? 'in' : 'out')},`);
    L.push(`    "ytick.direction": ${pyStr(style.tickIn ? 'in' : 'out')},`);
    L.push('    "xtick.major.width": ' + style.lineWidth + ',');
    L.push('    "ytick.major.width": ' + style.lineWidth + ',');
    L.push(`    "legend.frameon": False,`);
    L.push('    "savefig.dpi": 600,');
    L.push('    "savefig.bbox": "tight",');
    L.push('    "pdf.fonttype": 42,');
    L.push('});');
    L.push('');
    L.push(`PALETTE = ${pyList(U.palette(style.palette))}`);
    L.push(`fig, ax = plt.subplots(figsize=(${w}, ${h}))`);
    L.push('');
    const y = enc.y, x = enc.x, s = enc.series;
    const errMap = { sd: 'std', se: 'sem', ci: 'ci' };
    const errKw = style.errType === 'none' ? '' : `, errorbar=${pyStr(errMap[style.errType] || 'std')}, capsize=2.2, errwidth=${(style.lineWidth * 0.8).toFixed(1)}, errcolor="black"`;

    switch (type) {
      case 'bar':
      case 'barH':
        L.push(`sns.barplot(data=df, x=${pyStr(x)}, y=${pyStr(y)}${s ? `, hue=${pyStr(s)}` : ''},`);
        L.push(`            order=sorted(df[${pyStr(x)}].dropna().unique()), palette=PALETTE${errKw}, ax=ax)`);
        if (type === 'barH') L.push('ax.invert_yaxis()  # 如需横向，改为 sns.barplot(x=..., y=...)');
        break;
      case 'barStack':
      case 'barPct': {
        L.push(`piv = df.pivot_table(index=${pyStr(x)}, columns=${pyStr(s)}, values=${pyStr(y)}, aggfunc="mean")`);
        L.push(type === 'barPct' ? 'piv = piv.div(piv.sum(axis=1), axis=0) * 100' : '# 堆叠');
        L.push('piv.plot(kind="bar", stacked=True, color=PALETTE, ax=ax, width=0.62, edgecolor="white", linewidth=0.6)');
        break;
      }
      case 'line':
      case 'area':
        L.push(`sns.lineplot(data=df, x=${pyStr(x)}, y=${pyStr(y)}${s ? `, hue=${pyStr(s)}` : ''},`);
        L.push(`             marker="o", markersize=${style.symbolSize * 0.55}, linewidth=${(style.lineWidth * 1.4).toFixed(1)}, palette=PALETTE, ax=ax)`);
        if (type === 'area') L.push('ax.fill_between([], [], alpha=0.2)  # 面积填充请按分组分别调用 fill_between');
        break;
      case 'scatter':
      case 'bubble':
        if (type === 'bubble') {
          L.push(`sc = ax.scatter(df[${pyStr(x)}], df[${pyStr(y)}], s=df[${pyStr(enc.size)}] / df[${pyStr(enc.size)}].max() * 180,`);
          L.push('               alpha=0.85, edgecolors="black", linewidths=0.5)');
        } else {
          L.push(`sns.scatterplot(data=df, x=${pyStr(x)}, y=${pyStr(y)}${s ? `, hue=${pyStr(s)}` : ''}, s=${Math.round(style.symbolSize * 4)}, palette=PALETTE, ax=ax)`);
        }
        if (style.fitLine && type !== 'bubble') {
          L.push('import numpy as np');
          L.push(`k, b = np.polyfit(df[${pyStr(x)}], df[${pyStr(y)}], 1)`);
          L.push(`xx = np.linspace(df[${pyStr(x)}].min(), df[${pyStr(x)}].max(), 100)`);
          L.push('ax.plot(xx, k * xx + b, ls="--", lw=1, color="black")');
        }
        break;
      case 'box':
        L.push(`sns.boxplot(data=df, x=${pyStr(x)}, y=${pyStr(y)}, palette=PALETTE, width=0.55, linewidth=${style.lineWidth}, ax=ax)`);
        break;
      case 'violin':
        L.push(`sns.violinplot(data=df, x=${pyStr(x)}, y=${pyStr(y)}, palette=PALETTE, inner="quartile", cut=0, linewidth=${style.lineWidth}, ax=ax)`);
        break;
      case 'hist':
        L.push(`ax.hist(df[${pyStr(x)}].dropna(), bins=${style.binCount > 0 ? style.binCount : 'int(len(df) ** 0.5)'}, color=PALETTE[0], edgecolor="white", linewidth=0.6)`);
        L.push(`ax.set_ylabel("Count")`);
        break;
      case 'heat':
        L.push(`cols = ${pyList(enc.multi && enc.multi.length ? enc.multi : [])}`);
        L.push('corr = df[cols].corr(method=' + pyStr(enc.method === 'spearman' ? 'spearman' : 'pearson') + ')');
        L.push('sns.heatmap(corr, annot=True, fmt=".2f", cmap="RdBu_r", vmin=-1, vmax=1, square=True,');
        L.push(`            linewidths=0.5, linecolor="white", annot_kws={"size": ${style.fontSize - 1}}, cbar_kws={"shrink": .6}, ax=ax)`);
        break;
      case 'pie':
      case 'donut':
        L.push(`agg = df.groupby(${pyStr(x)})[${pyStr(y)}].sum()`);
        L.push('wedges, texts, autotexts = ax.pie(agg, labels=agg.index, autopct="%1.1f%%",');
        L.push(`        colors=PALETTE, startangle=90, wedgeprops=dict(width=${type === 'donut' ? 0.42 : 1}, edgecolor="white", linewidth=1))`);
        break;
      default: break;
    }
    L.push('');
    if (style.titleShow && style.titleText) L.push(`ax.set_title(${pyStr(style.titleText)})`);
    L.push(`ax.set_xlabel(${pyStr(style.xLabel || x)})`);
    L.push(`ax.set_ylabel(${pyStr(style.yLabel || (y || 'Count'))})`);
    L.push('sns.despine(ax=ax, trim=False)');
    if (style.gridShow) L.push('ax.grid(axis="y", ls="--", lw=0.5, color="#dddddd")');
    L.push(`ax.legend_.remove() if ax.get_legend() is not None and not ${style.legendShow} else None`);
    L.push('fig.tight_layout()');
    L.push(`fig.savefig("figure.pdf")   # 矢量，投稿首选`);
    L.push(`fig.savefig("figure.svg")`);
    L.push(`fig.savefig("figure.png", dpi=600)`);
    L.push('plt.show()');
    return L;
  }

  function rChart(chart) {
    if (!chart) return ['# 尚未配置图表'];
    const { type, enc, style } = chart;
    const L = ['# ---------- 出版级作图 ----------'];
    L.push('library(ggplot2)');
    L.push('library(dplyr)');
    L.push('library(readr)');
    L.push('');
    L.push(`pal <- ${rList(U.palette(style.palette))}`);
    L.push(`theme_pub <- theme_classic(base_size = ${style.fontSize}, base_family = ${rStr(style.fontFamily.replace(/"/g, ''))}) +`);
    L.push(`  theme(axis.line = element_line(linewidth = ${(style.lineWidth * 0.75).toFixed(2)}),`);
    L.push(`        axis.ticks = element_line(linewidth = ${(style.lineWidth * 0.75).toFixed(2)}),`);
    L.push(`        axis.ticks.length = unit(${style.tickIn ? '-2' : '2'}, "pt"),`);
    L.push(`        legend.position = ${rStr(style.legendPos)},`);
    L.push(`        legend.title = element_blank(),`);
    L.push(`        plot.title = element_text(hjust = 0.5, face = "bold"))`);
    L.push('');
    const y = enc.y, x = enc.x, s = enc.series;
    switch (type) {
      case 'bar':
      case 'barH': {
        L.push(`p <- ggplot(df, aes(x = ${x}, y = ${y}${s ? `, fill = ${s}` : ''})) +`);
        L.push(`  stat_summary(fun = mean, geom = "col", width = 0.62, colour = "black", linewidth = 0.3${s ? ', position = position_dodge(0.7)' : ''}) +`);
        if (style.errType !== 'none') {
          const fn = style.errType === 'se' ? 'mean_se' : style.errType === 'ci' ? 'mean_cl_normal' : 'mean_sdl';
          L.push(`  stat_summary(fun.data = ${fn}, geom = "errorbar", width = 0.22, linewidth = 0.4${s ? ', position = position_dodge(0.7)' : ''}) +`);
        }
        if (s) L.push('  scale_fill_manual(values = pal) +');
        L.push('  theme_pub');
        if (type === 'barH') L.push('p <- p + coord_flip()');
        break;
      }
      case 'barStack':
      case 'barPct': {
        L.push(`df_sum <- df %>% group_by(${x}, ${s}) %>% summarise(value = mean(${y}, na.rm = TRUE), .groups = "drop")`);
        if (type === 'barPct') L.push('df_sum <- df_sum %>% group_by(' + x + ') %>% mutate(value = value / sum(value) * 100)');
        L.push(`p <- ggplot(df_sum, aes(x = ${x}, y = value, fill = ${s})) +`);
        L.push('  geom_col(width = 0.68, colour = "black", linewidth = 0.25) +');
        L.push('  scale_fill_manual(values = pal) + theme_pub');
        break;
      }
      case 'line':
      case 'area': {
        L.push(`p <- ggplot(df, aes(x = ${x}, y = ${y}${s ? `, colour = ${s}` : ''}${s && type === 'area' ? `, fill = ${s}` : ''})) +`);
        if (type === 'area') L.push('  geom_area(alpha = 0.25, position = "identity") +');
        L.push('  stat_summary(fun = mean, geom = "line", linewidth = ' + (style.lineWidth * 1.1).toFixed(2) + ') +');
        L.push(`  stat_summary(fun = mean, geom = "point", size = ${(style.symbolSize * 0.28).toFixed(2)}) +`);
        if (style.errType !== 'none') {
          const fn = style.errType === 'se' ? 'mean_se' : style.errType === 'ci' ? 'mean_cl_normal' : 'mean_sdl';
          L.push(`  stat_summary(fun.data = ${fn}, geom = "errorbar", width = 0.15, linewidth = 0.4) +`);
        }
        L.push('  scale_colour_manual(values = pal) + theme_pub');
        break;
      }
      case 'scatter':
        L.push(`p <- ggplot(df, aes(x = ${x}, y = ${y}${s ? `, colour = ${s}` : ''})) +`);
        L.push(`  geom_point(size = ${(style.symbolSize * 0.6).toFixed(1)}, alpha = ${style.alpha}) +`);
        if (style.fitLine) L.push('  geom_smooth(method = "lm", se = FALSE, linetype = "dashed", linewidth = 0.5, colour = "black") +');
        L.push('  scale_colour_manual(values = pal) + theme_pub');
        break;
      case 'bubble':
        L.push(`p <- ggplot(df, aes(x = ${x}, y = ${y}, size = ${enc.size})) +`);
        L.push('  geom_point(alpha = 0.85, shape = 21, fill = pal[1], colour = "black") + theme_pub');
        break;
      case 'box':
        L.push(`p <- ggplot(df, aes(x = ${x}, y = ${y}, fill = ${x})) +`);
        L.push('  geom_boxplot(width = 0.55, linewidth = 0.3, outlier.size = 0.8) +');
        L.push('  scale_fill_manual(values = pal) + theme_pub + theme(legend.position = "none")');
        break;
      case 'violin':
        L.push(`p <- ggplot(df, aes(x = ${x}, y = ${y}, fill = ${x})) +`);
        L.push('  geom_violin(trim = FALSE, linewidth = 0.3) +');
        L.push('  geom_boxplot(width = 0.08, fill = "white", linewidth = 0.3, outlier.shape = NA) +');
        L.push('  scale_fill_manual(values = pal) + theme_pub + theme(legend.position = "none")');
        break;
      case 'hist':
        L.push(`p <- ggplot(df, aes(x = ${x})) +`);
        L.push(`  geom_histogram(bins = ${style.binCount > 0 ? style.binCount : 12}, fill = pal[1], colour = "white", linewidth = 0.3) +`);
        L.push('  labs(y = "Count") + theme_pub');
        break;
      case 'heat': {
        const cols = enc.multi && enc.multi.length ? enc.multi : [];
        L.push(`cols <- ${rList(cols)}`);
        L.push('corr <- cor(df[, cols], use = "pairwise.complete.obs", method = ' + rStr(enc.method === 'spearman' ? 'spearman' : 'pearson') + ')');
        L.push('library(reshape2)');
        L.push('m <- melt(corr)');
        L.push('p <- ggplot(m, aes(Var1, Var2, fill = value)) +');
        L.push('  geom_tile(colour = "white") + geom_text(aes(label = sprintf("%.2f", value)), size = 2.6) +');
        L.push('  scale_fill_gradient2(low = "#2166AC", mid = "white", high = "#B2182B", midpoint = 0, limits = c(-1, 1)) +');
        L.push('  coord_fixed() + theme_minimal(base_size = ' + style.fontSize + ') +');
        L.push('  theme(axis.title = element_blank(), axis.text.x = element_text(angle = 45, hjust = 1))');
        break;
      }
      case 'pie':
      case 'donut':
        L.push(`df_sum <- df %>% group_by(${x}) %>% summarise(value = sum(${y}, na.rm = TRUE)) %>%`);
        L.push('  mutate(frac = value / sum(value), ymax = cumsum(frac), ymin = c(0, head(ymax, n = -1)),');
        L.push('         lab = paste0(' + x + ', "\\n", sprintf("%.1f%%", frac * 100)))');
        L.push('p <- ggplot(df_sum, aes(ymax = ymax, ymin = ymin, xmax = 4, xmin = 3, fill = ' + x + ')) +');
        L.push('  geom_rect(colour = "white") + coord_polar(theta = "y") +');
        L.push('  xlim(c(0, 4)) + scale_fill_manual(values = pal) + theme_void(base_size = ' + style.fontSize + ')');
        break;
      default: break;
    }
    L.push('');
    if (style.titleShow && style.titleText) L.push(`p <- p + ggtitle(${rStr(style.titleText)})`);
    L.push(`p <- p + labs(x = ${rStr(style.xLabel || x || '')}, y = ${rStr(style.yLabel || y || 'Count')})`);
    L.push(`ggsave("figure.pdf", p, width = ${(style.widthMM / 25.4).toFixed(2)}, height = ${(style.heightMM / 25.4).toFixed(2)}, units = "in")`);
    L.push(`ggsave("figure.png", p, width = ${(style.widthMM / 25.4).toFixed(2)}, height = ${(style.heightMM / 25.4).toFixed(2)}, dpi = 600)`);
    return L;
  }

  /* ---------------- 汇总 ---------------- */
  function pythonCode(state) {
    const ds = state.dataset;
    const L = [];
    L.push('# ============================================================');
    L.push('# LabDesk 复现脚本（Python 3.9+）');
    L.push('# 依赖：pandas numpy scipy statsmodels matplotlib seaborn');
    L.push(`# 数据集：${ds ? ds.name : '—'}　生成时间：${new Date().toLocaleString('zh-CN')}`);
    L.push('# 使用方式：把「处理后数据」导出为 data.csv 放在同目录，然后运行本脚本。');
    L.push('# ============================================================');
    L.push('');
    L.push('import pandas as pd');
    L.push('import numpy as np');
    L.push('');
    L.push('df = pd.read_csv("data.csv")');
    L.push(`print(df.shape)   # ${ds ? ds.rows.length : 0} 行 × ${ds ? ds.columns.length : 0} 列`);
    L.push('');
    const pipe = pyPipeline(state.pipeline);
    if (pipe.length) {
      L.push('# ---------- 数据整理（与 LabDesk 中的操作一一对应） ----------');
      L.push(...pipe);
      L.push('');
    }
    L.push(...pyAnalysis(state.lastTest, ds));
    L.push('');
    L.push(...pyChart(state.chart));
    if (state.curveAnalysis && state.curve) {
      L.push('');
      L.push(...pyCurve({ analysis: state.curveAnalysis, curve: state.curve, fit: state.curveFit }));
    }
    return L.join('\n');
  }

  function rCode(state) {
    const ds = state.dataset;
    const L = [];
    L.push('# ============================================================');
    L.push('# LabDesk 复现脚本（R 4.x）');
    L.push('# 依赖：tidyverse readr');
    L.push(`# 数据集：${ds ? ds.name : '—'}　生成时间：${new Date().toLocaleString('zh-CN')}`);
    L.push('# 使用方式：把「处理后数据」导出为 data.csv 放在同目录，然后运行本脚本。');
    L.push('# ============================================================');
    L.push('');
    L.push('library(tidyverse)');
    L.push('library(readr)');
    L.push('');
    L.push('df <- read_csv("data.csv")');
    L.push(`# ${ds ? ds.rows.length : 0} 行 × ${ds ? ds.columns.length : 0} 列`);
    L.push('');
    const pipe = rPipeline(state.pipeline);
    if (pipe.length) {
      L.push('# ---------- 数据整理 ----------');
      L.push(...pipe);
      L.push('');
    }
    L.push(...rAnalysis(state.lastTest));
    L.push('');
    L.push(...rChart(state.chart));
    if (state.curveAnalysis && state.curve) {
      L.push('');
      L.push(...rCurve({ analysis: state.curveAnalysis, curve: state.curve, fit: state.curveFit }));
    }
    return L.join('\n');
  }

  /* ---------------- 曲线处理与拟合 ---------------- */
  const pyNum = (v) => {
    if (v === null || v === undefined || !isFinite(v)) return 'np.nan';
    return String(+Number(v).toPrecision(10));
  };
  const rNum = (v) => {
    if (v === null || v === undefined || !isFinite(v)) return 'NA';
    return String(+Number(v).toPrecision(10));
  };

  function pyModelBody(model) {
    const b = {
      linear: 'a + b * x',
      poly2: 'a + b * x + c * x ** 2',
      poly3: 'a + b * x + c * x ** 2 + d * x ** 3',
      expdecay: 'a * np.exp(-k * x) + c',
      expgrowth: 'a * np.exp(k * x) + c',
      biexp: 'a * np.exp(-k1 * x) + b * np.exp(-k2 * x) + c',
      logistic: 'c + (d - c) * expit(k * (x - x0))',
      dose4pl: 'bottom + (top - bottom) / (1 + (x / ec50) ** hill)',
      dose5pl: 'bottom + (top - bottom) / (1 + (x / ec50) ** hill) ** g',
      gompertz: 'a * np.exp(-np.exp(-k * (x - x0)))',
      gaussian: 'base + A * np.exp(-(x - mu) ** 2 / (2 * sigma ** 2))',
      lorentzian: 'base + A * gamma ** 2 / ((x - x0) ** 2 + gamma ** 2)',
      pseudovoigt: 'base + A * (eta / (1 + ((x - x0) / w) ** 2) + (1 - eta) * np.exp(-0.5 * ((x - x0) / w) ** 2))',
      power: 'a * x ** b',
      langmuir: 'qmax * K * x / (1 + K * x)',
      freundlich: 'K * x ** (1 / n)',
      michaelis: 'vmax * x / (km + x)',
      hill: 'vmax * x ** n / (k ** n + x ** n)',
      arrhenius: 'A * np.exp(-Ea * 1000 / (8.314 * x))',
      sine: 'a * np.sin(2 * np.pi * f * x + phi) + c',
    };
    return b[model.key] || 'a + b * x';
  }

  function rModelBody(model) {
    const b = {
      linear: 'a + b * x',
      poly2: 'a + b * x + c * x^2',
      poly3: 'a + b * x + c * x^2 + d * x^3',
      expdecay: 'a * exp(-k * x) + c',
      expgrowth: 'a * exp(k * x) + c',
      biexp: 'a * exp(-k1 * x) + b * exp(-k2 * x) + c',
      logistic: 'c + (d - c) / (1 + exp(-k * (x - x0)))',
      dose4pl: 'bottom + (top - bottom) / (1 + (x / ec50)^hill)',
      dose5pl: 'bottom + (top - bottom) / (1 + (x / ec50)^hill)^g',
      gompertz: 'a * exp(-exp(-k * (x - x0)))',
      gaussian: 'base + A * exp(-(x - mu)^2 / (2 * sigma^2))',
      lorentzian: 'base + A * gamma^2 / ((x - x0)^2 + gamma^2)',
      pseudovoigt: 'base + A * (eta / (1 + ((x - x0) / w)^2) + (1 - eta) * exp(-0.5 * ((x - x0) / w)^2))',
      power: 'a * x^b',
      langmuir: 'qmax * K * x / (1 + K * x)',
      freundlich: 'K * x^(1 / n)',
      michaelis: 'vmax * x / (km + x)',
      hill: 'vmax * x^n / (k^n + x^n)',
      arrhenius: 'A * exp(-Ea * 1000 / (8.314 * x))',
      sine: 'a * sin(2 * pi * f * x + phi) + c',
    };
    return b[model.key] || 'a + b * x';
  }

  function curveHeader(curve, analysis) {
    const pre = curve.pre || {};
    const bits = [];
    const baseMethod = (pre.baseline || {}).method || 'none';
    const smoothMethod = (pre.smooth || {}).method || 'none';
    bits.push(`X 列：${analysis.x}`);
    bits.push(`Y 列：${(curve.ys || []).join('、')}`);
    bits.push(`基线：${({ none: '无', als: 'ALS', poly: '多项式', linear: '端点连线', min: '减最小值' }[baseMethod] || baseMethod)}`);
    bits.push(`平滑：${({ none: '无', sg: 'Savitzky–Golay', moving: '移动平均', median: '中值', gaussian: '高斯' }[smoothMethod] || smoothMethod)}`);
    if (pre.deriv) bits.push(`求导：${pre.deriv} 阶`);
    if (pre.norm && pre.norm !== 'none') bits.push(`归一化：${pre.norm}`);
    return bits.join('；');
  }

  function pyCurve(state) {
    const analysis = state.analysis;
    const curve = state.curve || {};
    const pre = curve.pre || {};
    const fit = state.fit;
    const L = [];
    const xCol = analysis.x;
    const ys = curve.ys || analysis.series.map((s) => s.name);
    const target = fit && fit.target ? fit.target : (curve.fit && curve.fit.target) || ys[0];
    const sm = pre.smooth || {};
    const bl = pre.baseline || {};
    let win = Math.max(3, Math.round(sm.window || 11));
    if (win % 2 === 0) win += 1;
    const order = Math.max(1, Math.min(sm.order || 2, 5, win - 1));
    const needAls = bl.method === 'als';

    L.push('# ---------- 曲线处理、寻峰与非线性拟合 ----------');
    L.push('# 依赖：numpy pandas scipy');
    L.push(`# ${curveHeader(curve, analysis)}`);
    L.push('import numpy as np');
    L.push('import pandas as pd');
    L.push('from scipy.signal import find_peaks, peak_widths, savgol_filter, medfilt');
    L.push('from scipy.ndimage import gaussian_filter1d');
    L.push('from scipy.integrate import trapezoid');
    L.push('');
    L.push('df = pd.read_csv("data.csv")');
    L.push(`X_COL = ${pyStr(xCol)}`);
    L.push(`Y_COLS = ${pyList(ys)}`);
    if (analysis.xType === 'date') {
      L.push('');
      L.push('def get_x():');
      L.push('    """日期列转成 Unix 秒，与 LabDesk 的时间轴一致"""');
      L.push('    return pd.to_datetime(df[X_COL]).astype("int64").to_numpy(dtype=float) / 1e9');
    }
    L.push('');

    if (needAls) {
      L.push('def als_baseline(y, lam=1e5, p=0.01, niter=10):');
      L.push('    """Eilers 非对称最小二乘基线（与 LabDesk 的实现一致）"""');
      L.push('    from scipy import sparse');
      L.push('    from scipy.sparse.linalg import spsolve');
      L.push('    n = len(y)');
      L.push('    D = sparse.diags([1, -2, 1], [0, -1, -2], shape=(n, n - 2))');
      L.push('    w = np.ones(n)');
      L.push('    z = y.copy()');
      L.push('    for _ in range(niter):');
      L.push('        W = sparse.spdiags(w, 0, n, n)');
      L.push('        z = spsolve(W + lam * D.dot(D.T), w * y)');
      L.push('        w = p * (y > z) + (1 - p) * (y < z)');
      L.push('    return z');
      L.push('');
    }

    L.push('def preprocess(x, y):');
    L.push('    """裁剪 → 基线 → 平滑 → 求导 → 归一化"""');
    L.push('    x = np.asarray(x, dtype=float)');
    L.push('    y = np.asarray(y, dtype=float)');
    L.push('    m = np.isfinite(x) & np.isfinite(y)');
    L.push('    x, y = x[m], y[m]');
    L.push('    o = np.argsort(x)');
    L.push('    x, y = x[o], y[o]');
    if (pre.crop && pre.crop.on && pre.crop.lo !== null && pre.crop.hi !== null) {
      L.push(`    keep = (x >= ${pyNum(pre.crop.lo)}) & (x <= ${pyNum(pre.crop.hi)})`);
      L.push('    x, y = x[keep], y[keep]');
    }
    if (bl.method === 'als') {
      L.push(`    y = y - als_baseline(y, lam=${pyNum(bl.lambda || 1e5)}, p=${pyNum(bl.p === undefined ? 0.01 : bl.p)}, niter=${Math.round(bl.iter || 10)})`);
    } else if (bl.method === 'poly') {
      L.push(`    y = y - np.polyval(np.polyfit(x, y, ${Math.round(bl.degree || 4)}), x)`);
    } else if (bl.method === 'linear') {
      L.push('    k0 = max(1, int(len(y) * 0.02))');
      L.push('    y = y - np.linspace(y[:k0].mean(), y[-k0:].mean(), len(y))');
    } else if (bl.method === 'min') {
      L.push('    y = y - y.min()');
    }
    if (sm.method === 'sg') {
      L.push(`    y = savgol_filter(y, ${win}, ${order})`);
    } else if (sm.method === 'moving') {
      L.push(`    y = pd.Series(y).rolling(${win}, center=True, min_periods=1).mean().to_numpy()`);
    } else if (sm.method === 'median') {
      L.push(`    y = medfilt(y, ${win})`);
    } else if (sm.method === 'gaussian') {
      L.push(`    y = gaussian_filter1d(y, sigma=${pyNum(Math.max(0.5, win / 6))})`);
    }
    if (pre.deriv === 1 || pre.deriv === 2) {
      L.push(`    y = savgol_filter(y, ${Math.max(5, win)}, ${Math.min(Math.max(5, win) - 1, Math.max(order, pre.deriv + 1))}, deriv=${pre.deriv})`);
    }
    if (pre.norm === 'max') L.push('    y = y / y.max()');
    else if (pre.norm === 'minmax') L.push('    y = (y - y.min()) / (y.max() - y.min())');
    else if (pre.norm === 'area') L.push('    y = y / trapezoid(y, x)');
    else if (pre.norm === 'snv') L.push('    y = (y - y.mean()) / y.std(ddof=1)');
    else if (pre.norm === 'vector') L.push('    y = y / np.linalg.norm(y)');
    L.push('    return x, y');
    L.push('');

    const pk = curve.peaks || {};
    if (pk.on) {
      L.push('# ---------- 寻峰与积分 ----------');
      L.push('all_peaks = []');
      L.push('for col in Y_COLS:');
      L.push(analysis.xType === 'date' ? '    x = get_x()' : '    x = df[X_COL].to_numpy(dtype=float)');
      L.push('    y = df[col].to_numpy(dtype=float)');
      L.push('    x, y = preprocess(x, y)');
      L.push('    rng = y.max() - y.min()');
      L.push(`    h = y.min() + ${pyNum(pk.relHeight || 0)} / 100 * rng`);
      L.push(`    prom = ${pyNum(pk.relProminence || 0)} / 100 * rng`);
      L.push(`    idx, props = find_peaks(y, height=h, prominence=prom, distance=${Math.max(1, Math.round(pk.distance || 1))})`);
      L.push('    w = peak_widths(y, idx, rel_height=0.5)');
      L.push('    xl = np.interp(w[2], np.arange(len(x)), x)');
      L.push('    xr = np.interp(w[3], np.arange(len(x)), x)');
      L.push('    area = np.array([trapezoid(y[(x >= a) & (x <= b)], x[(x >= a) & (x <= b)]) for a, b in zip(xl, xr)])');
      L.push('    all_peaks.append(pd.DataFrame({"curve": col, "peak_x": x[idx], "peak_y": y[idx],');
      L.push('                                   "prominence": props["prominences"], "fwhm": xr - xl, "area": area}))');
      L.push('peaks = pd.concat(all_peaks, ignore_index=True)');
      L.push('print(peaks)');
      L.push('');
    }

    const model = LD.curve.modelByKey(fit && fit.model ? fit.model : (curve.fit && curve.fit.model));
    if (model) {
      const params = fit && fit.params ? fit.params : (curve.fit && curve.fit.init) || {};
      const guess = (curve.fit && curve.fit.init) || {};
      const p0 = model.params.map((p) => {
        const v = params[p.k] !== undefined ? params[p.k] : (guess[p.k] !== undefined ? guess[p.k] : p.def);
        return pyNum(v);
      });
      const boundsLo = model.params.map((p) => (p.min === undefined ? '-np.inf' : pyNum(p.min)));
      const boundsHi = model.params.map((p) => (p.max === undefined ? 'np.inf' : pyNum(p.max)));
      const hasBounds = model.params.some((p) => p.min !== undefined || p.max !== undefined);
      L.push('# ---------- 非线性拟合 ----------');
      L.push('from scipy.optimize import curve_fit');
      L.push('from scipy.special import expit');
      L.push('from scipy.stats import t');
      L.push('');
      L.push(analysis.xType === 'date' ? 'x = get_x()' : `x = df[X_COL].to_numpy(dtype=float)`);
      L.push(`y = df[${pyStr(target)}].to_numpy(dtype=float)`);      L.push('x, y = preprocess(x, y)');
      if (model.positiveX) L.push('m = x > 0; x, y = x[m], y[m]');
      L.push('');
      L.push(`def model(x, ${model.params.map((p) => p.k).join(', ')}):`);
      L.push(`    return ${pyModelBody(model)}`);
      L.push('');
      L.push(`p0 = [${p0.join(', ')}]`);
      if (hasBounds) {
        L.push(`bounds = ([${boundsLo.join(', ')}], [${boundsHi.join(', ')}])`);
        L.push('popt, pcov = curve_fit(model, x, y, p0=p0, bounds=bounds, maxfev=20000)');
      } else {
        L.push('popt, pcov = curve_fit(model, x, y, p0=p0, maxfev=20000)');
      }
      L.push('perr = np.sqrt(np.diag(pcov))');
      L.push('n, k = len(x), len(popt)');
      L.push('dof = n - k');
      L.push('resid = y - model(x, *popt)');
      L.push('ss_res = np.sum(resid ** 2)');
      L.push('ss_tot = np.sum((y - y.mean()) ** 2)');
      L.push('r2 = 1 - ss_res / ss_tot');
      L.push('adj_r2 = 1 - (ss_res / dof) / (ss_tot / (n - 1)) if dof > 0 else np.nan');
      L.push('rmse = np.sqrt(ss_res / n)');
      L.push('tq = t.ppf(0.975, dof) if dof > 0 else np.nan');
      L.push('params = pd.DataFrame({"param": ' + pyList(model.params.map((p) => p.label)) + ',');
      L.push('                        "estimate": popt, "se": perr,');
      L.push('                        "ci_low": popt - tq * perr, "ci_high": popt + tq * perr})');
      L.push('print(params)');
      L.push('print(f"R² = {r2:.4f}, 调整 R² = {adj_r2:.4f}, RMSE = {rmse:.4g}, n = {n}")');
      L.push('');
    }

    return L;
  }

  function rCurve(state) {
    const analysis = state.analysis;
    const curve = state.curve || {};
    const pre = curve.pre || {};
    const fit = state.fit;
    const L = [];
    const xCol = analysis.x;
    const ys = curve.ys || analysis.series.map((s) => s.name);
    const target = fit && fit.target ? fit.target : (curve.fit && curve.fit.target) || ys[0];
    const sm = pre.smooth || {};
    const bl = pre.baseline || {};
    let win = Math.max(3, Math.round(sm.window || 11));
    if (win % 2 === 0) win += 1;
    const order = Math.max(1, Math.min(sm.order || 2, 5, win - 1));

    L.push('# ---------- 曲线处理、寻峰与非线性拟合 ----------');
    L.push('# 依赖：signal、pracma、（可选）zoo、baseline');
    L.push(`# ${curveHeader(curve, analysis)}`);
    L.push('library(signal)');
    L.push('library(pracma)');
    if (sm.method === 'moving') L.push('library(zoo)');
    if (bl.method === 'als') L.push('library(baseline)');
    L.push('');
    L.push('df <- read.csv("data.csv")');
    L.push(`X_COL <- ${rStr(xCol)}`);
    L.push(`Y_COLS <- ${rList(ys)}`);
    L.push('');
    L.push('get_x <- function() {');
    L.push('  # 日期列转成 Unix 秒，与 LabDesk 的时间轴一致');
    L.push('  if (inherits(df[[X_COL]], "Date")) return(as.numeric(df[[X_COL]]))');
    L.push('  if (is.character(df[[X_COL]])) return(as.numeric(as.POSIXct(df[[X_COL]])))');
    L.push('  return(as.numeric(df[[X_COL]]))');
    L.push('}');
    L.push('');
    L.push('preprocess <- function(x, y) {');
    L.push('  keep <- is.finite(x) & is.finite(y)');
    L.push('  x <- x[keep]; y <- y[keep]');
    L.push('  o <- order(x); x <- x[o]; y <- y[o]');
    if (pre.crop && pre.crop.on && pre.crop.lo !== null && pre.crop.hi !== null) {
      L.push(`  keep <- x >= ${rNum(pre.crop.lo)} & x <= ${rNum(pre.crop.hi)}`);
      L.push('  x <- x[keep]; y <- y[keep]');
    }
    if (bl.method === 'als') {
      L.push(`  bl <- baseline(matrix(y, ncol = 1), method = "als", lambda = ${rNum(bl.lambda || 1e5)}, it = ${Math.round(bl.iter || 10)})`);
      L.push('  y <- y - as.numeric(getBaseline(bl))');
    } else if (bl.method === 'poly') {
      L.push(`  y <- y - predict(lm(y ~ poly(x, ${Math.round(bl.degree || 4)}, raw = TRUE)))`);
    } else if (bl.method === 'linear') {
      L.push('  k0 <- max(1, round(length(y) * 0.02))');
      L.push('  y <- y - seq(mean(y[1:k0]), mean(y[(length(y) - k0 + 1):length(y)]), length.out = length(y))');
    } else if (bl.method === 'min') {
      L.push('  y <- y - min(y)');
    }
    if (sm.method === 'sg') {
      L.push(`  y <- sgolayfilt(y, p = ${order}, n = ${win})`);
    } else if (sm.method === 'moving') {
      L.push(`  y <- as.numeric(zoo::rollmean(y, k = ${win}, fill = NA, align = "center"))`);
      L.push('  y[is.na(y)] <- approx(seq_along(y), y, seq_along(y), rule = 2)$y');
    } else if (sm.method === 'median') {
      L.push(`  y <- runmed(y, k = ${win})`);
    } else if (sm.method === 'gaussian') {
      L.push(`  y <- as.numeric(stats::filter(y, dnorm(-3:3, 0, ${rNum(Math.max(0.5, win / 6))}), sides = 2))`);
      L.push('  y[is.na(y)] <- approx(seq_along(y), y, seq_along(y), rule = 2)$y');
    }
    if (pre.deriv === 1 || pre.deriv === 2) {
      L.push(`  y <- sgolayfilt(y, p = ${Math.min(Math.max(5, win) - 1, Math.max(order, pre.deriv + 1))}, n = ${Math.max(5, win)}, m = ${pre.deriv})`);
    }
    if (pre.norm === 'max') L.push('  y <- y / max(y)');
    else if (pre.norm === 'minmax') L.push('  y <- (y - min(y)) / (max(y) - min(y))');
    else if (pre.norm === 'area') L.push('  y <- y / pracma::trapz(x, y)');
    else if (pre.norm === 'snv') L.push('  y <- (y - mean(y)) / sd(y)');
    else if (pre.norm === 'vector') L.push('  y <- y / sqrt(sum(y^2))');
    L.push('  list(x = x, y = y)');
    L.push('}');
    L.push('');

    const pk = curve.peaks || {};
    if (pk.on) {
      L.push('# ---------- 寻峰 ----------');
      L.push('peak_list <- lapply(Y_COLS, function(col) {');
      L.push('  d <- preprocess(get_x(), df[[col]])');
      L.push('  rng <- max(d$y) - min(d$y)');
      L.push(`  h <- min(d$y) + ${rNum(pk.relHeight || 0)} / 100 * rng`);
      L.push(`  p <- findpeaks(d$y, minpeakheight = h, minpeakdistance = ${Math.max(1, Math.round(pk.distance || 1))})`);
      L.push('  if (is.null(p)) return(NULL)');
      L.push('  data.frame(curve = col, peak_x = d$x[p[, 2]], peak_y = p[, 1])');
      L.push('})');
      L.push('print(do.call(rbind, peak_list))');
      L.push('');
    }

    const model = LD.curve.modelByKey(fit && fit.model ? fit.model : (curve.fit && curve.fit.model));
    if (model) {
      const params = fit && fit.params ? fit.params : (curve.fit && curve.fit.init) || {};
      const starts = model.params.map((p) => {
        const v = params[p.k] !== undefined ? params[p.k] : p.def;
        return `${p.k} = ${rNum(v)}`;
      });
      L.push('# ---------- 非线性拟合 ----------');
      L.push(`d <- preprocess(get_x(), df[[${rStr(target)}]])`);
      L.push(`model <- function(x, ${model.params.map((p) => p.k).join(', ')}) ${rModelBody(model)}`);
      L.push(`fit <- nls(d$y ~ model(d$x, ${model.params.map((p) => p.k).join(', ')}),`);
      L.push(`           start = list(${starts.join(', ')}))`);
      L.push('print(summary(fit))');
      L.push('# 若 nls 不收敛，可改用 drc 包（剂量响应）或 minpack.lm::nlsLM');
      L.push('');
    }

    return L;
  }

  function curveCode(state) {
    return { python: pyCurve(state).join('\n'), r: rCurve(state).join('\n') };
  }

  LD.codegen = { pythonCode, rCode, curveCode };
})();
