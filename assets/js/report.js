/* LabDesk · 报告生成 */
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;

  function esc(s) { return U.escapeHtml(s); }

  function descTable(descRows) {
    if (!descRows || !descRows.length) return '<p class="muted">尚未计算描述统计。</p>';
    const head = ['变量', 'n', '均值 ± 标准差', '中位数 [Q1, Q3]', '最小值 ~ 最大值'];
    const rows = descRows.map((d) => `<tr>
      <td>${esc(d.name)}</td>
      <td class="num">${d.n}</td>
      <td class="num">${U.fmt(d.mean, 3)} ± ${U.fmt(d.sd, 3)}</td>
      <td class="num">${U.fmt(d.median, 3)} [${U.fmt(d.q1, 3)}, ${U.fmt(d.q3, 3)}]</td>
      <td class="num">${U.fmt(d.min, 3)} ~ ${U.fmt(d.max, 3)}</td></tr>`).join('');
    return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  const REPORT_CSS = `
    .ld-report{font:13.5px/1.85 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#15191f}
    .ld-report h1{font-size:18px;border-bottom:2px solid #0f766e;padding-bottom:8px;margin:0 0 10px}
    .ld-report h2{font-size:14px;margin:22px 0 8px;color:#0b5d56}
    .ld-report h3{font-size:12.5px;margin:14px 0 6px;color:#414b57}
    .ld-report p{margin:6px 0}
    .ld-report table{width:100%;border-collapse:collapse;font-size:11.5px;margin:8px 0}
    .ld-report th,.ld-report td{border:1px solid #e3e6eb;padding:5px 8px;text-align:left}
    .ld-report th{background:#fafbfc;font-weight:600}
    .ld-report td.num{text-align:right;font-family:ui-monospace,Menlo,monospace;font-size:11px}
    .ld-report .muted{color:#78828f;font-size:12px}
    .ld-report .fig{text-align:center;margin:14px 0;padding:10px;border:1px solid #eef0f3;border-radius:8px}
    .ld-report .fig svg{max-width:100%;height:auto}
    .ld-report ul,.ld-report ol{padding-left:22px;margin:6px 0}
    .ld-report li{margin-bottom:4px}
  `;

  function curveBlocks(state) {
    const a = state.curveAnalysis;
    const c = state.curve || {};
    const pre = c.pre || {};
    if (!a) return [];
    const out = [];
    const baseLabel = { none: '不校正', als: 'ALS 非对称最小二乘', poly: '多项式', linear: '端点连线', min: '减去最小值' };
    const smoothLabel = { none: '不平滑', sg: 'Savitzky–Golay', moving: '移动平均', median: '中值滤波', gaussian: '高斯' };
    const baseMethod = (pre.baseline || {}).method || 'none';
    const smoothMethod = (pre.smooth || {}).method || 'none';
    const bits = [
      `横轴 ${esc(a.x)}`,
      `曲线 ${a.series.map((s) => esc(s.name)).join('、')}`,
      `基线 ${baseLabel[baseMethod] || baseMethod}`,
      `平滑 ${smoothLabel[smoothMethod] || smoothMethod}`,
    ];
    if (pre.deriv) bits.push(`${pre.deriv} 阶导数`);
    if (pre.norm && pre.norm !== 'none') bits.push(`归一化：${pre.norm}`);
    out.push(`<p>${bits.join('；')}。</p>`);
    if (state.curveSvg) out.push(`<div class="fig">${state.curveSvg}</div>`);

    const rows = [];
    a.series.forEach((s) => s.peaks.forEach((p, i) => {
      rows.push([s.name, i + 1, p.x, p.y, p.prominence, p.fwhm, p.area]);
    }));
    if (c.peaks && c.peaks.on) {
      if (rows.length) {
        out.push('<h3>峰列表</h3>');
        out.push('<table><thead><tr><th>曲线</th><th>序号</th><th>峰位</th><th>峰高</th><th>显著度</th><th>FWHM</th><th>面积</th></tr></thead><tbody>'
          + rows.map((r) => `<tr><td>${esc(r[0])}</td><td class="num">${r[1]}</td><td class="num">${U.fmt(r[2], 4)}</td><td class="num">${U.fmt(r[3], 4)}</td><td class="num">${U.fmt(r[4], 3)}</td><td class="num">${r[5] === null ? '—' : U.fmt(r[5], 4)}</td><td class="num">${r[6] === null ? '—' : U.fmt(r[6], 4)}</td></tr>`).join('')
          + '</tbody></table>');
      } else {
        out.push('<p class="muted">当前阈值下未检出峰。</p>');
      }
    }

    const f = state.curveFit;
    if (f && f.ok) {
      out.push(`<h3>非线性拟合：${esc(f.modelName || f.model)}</h3>`);
      out.push(`<p>目标曲线：${esc(f.target)}；R² = ${U.fmt(f.r2, 4)}，调整 R² = ${U.fmt(f.adjR2, 4)}，RMSE = ${U.fmt(f.rmse, 4)}，有效点 n = ${f.n}。</p>`);
      out.push('<table><thead><tr><th>参数</th><th>估计值</th><th>标准误</th><th>95% CI</th><th>状态</th></tr></thead><tbody>'
        + f.paramList.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${U.fmt(p.value, 5)}</td><td class="num">${isFinite(p.se) ? U.fmt(p.se, 4) : '—'}</td><td class="num">${isFinite(p.ciLow) ? U.fmt(p.ciLow, 4) + ' ~ ' + U.fmt(p.ciHigh, 4) : '—'}</td><td>${p.atBound ? '停在边界' : '正常'}</td></tr>`).join('')
        + '</tbody></table>');
      if (f.warnings && f.warnings.length) {
        out.push('<ul>' + f.warnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>');
      }
    } else if (c.fit && c.fit.model && c.fit.model !== 'none') {
      out.push('<p class="muted">已选择拟合模型，但尚未运行或结果已失效。</p>');
    }
    return out;
  }

  function buildHTML(state, opts) {
    const o = opts || {};
    const ds = state.dataset;
    const now = new Date().toLocaleString('zh-CN');
    const parts = [];
    let sec = 1;
    const hasPipe = state.pipeline && state.pipeline.length;
    const hasCurve = state.curveAnalysis && state.curveAnalysis.series && state.curveAnalysis.series.length;
    const hasTest = state.lastTest && state.lastTest.render;

    parts.push(`<h1>${esc(ds ? ds.name : '未命名数据集')} · 数据分析报告</h1>`);
    parts.push(`<p class="muted">生成时间：${esc(now)}　|　工具：LabDesk 科研数据台</p>`);

    parts.push('<h2>1 数据概况</h2>');
    if (ds) {
      const nNum = ds.columns.filter((c) => c.type === 'number').length;
      const nCat = ds.columns.filter((c) => c.type === 'category' || c.type === 'text').length;
      parts.push(`<p>数据来源：${esc(ds.meta && ds.meta.source === 'sample' ? '内置示例数据' : (ds.meta && ds.meta.fileName) || ds.source || '文件导入')}；`
        + `共 <strong>${ds.rows.length}</strong> 行、<strong>${ds.columns.length}</strong> 列，`
        + `其中数值列 ${nNum} 个、分类列 ${nCat} 个。</p>`);
      const rows = ds.columns.map((c) => {
        const vals = ds.rows.map((r) => r[ds.columns.indexOf(c)]);
        const miss = vals.filter((v) => v === null || v === '').length;
        return `<tr><td>${esc(c.name)}</td><td>${({ number: '数值', category: '分类', text: '文本', date: '日期', empty: '空' }[c.type] || c.type)}</td>
          <td class="num">${ds.rows.length - miss}</td><td class="num">${miss}</td></tr>`;
      }).join('');
      parts.push(`<table><thead><tr><th>列名</th><th>类型</th><th>有效值</th><th>缺失</th></tr></thead><tbody>${rows}</tbody></table>`);
    } else {
      parts.push('<p class="muted">无数据。</p>');
    }

    if (hasPipe) {
      sec++;
      parts.push(`<h2>${sec} 数据整理步骤</h2><ol>`);
      state.pipeline.forEach((st) => parts.push(`<li>${esc(LD.ops.summarize(st))}</li>`));
      parts.push('</ol>');
    }

    if (hasCurve) {
      sec++;
      parts.push(`<h2>${sec} 曲线分析</h2>`);
      curveBlocks(state).forEach((b) => parts.push(b));
    }

    sec++;
    parts.push(`<h2>${sec} 描述统计</h2>`);
    parts.push(descTable(state.descRows));

    if (hasTest) {
      sec++;
      const r = state.lastTest.render;
      parts.push(`<h2>${sec} 统计分析：${esc(r.title || '')}</h2>`);
      if (r.stats && r.stats.length) {
        parts.push('<table><thead><tr><th>指标</th><th>数值</th></tr></thead><tbody>'
          + r.stats.map((s) => `<tr><td>${esc(s.k)}</td><td class="num">${esc(s.v)}</td></tr>`).join('')
          + '</tbody></table>');
      }
      if (r.table) {
        const tTitle = r.table.title || (r.table.columns && r.table.columns[0] === '比较' ? '两两比较' : '统计表');
        parts.push(`<h3>${esc(tTitle)}</h3><table><thead><tr>`
          + r.table.columns.map((c) => `<th>${esc(c)}</th>`).join('')
          + '</tr></thead><tbody>'
          + r.table.rows.map((row) => '<tr>' + row.map((c) => `<td class="num">${esc(c)}</td>`).join('') + '</tr>').join('')
          + '</tbody></table>');
      }
      if (r.table2) {
        parts.push(`<h3>${esc(r.table2.title || '两两比较')}</h3><table><thead><tr>`
          + r.table2.columns.map((c) => `<th>${esc(c)}</th>`).join('')
          + '</tr></thead><tbody>'
          + r.table2.rows.map((row) => '<tr>' + row.map((c) => `<td class="num">${esc(c)}</td>`).join('') + '</tr>').join('')
          + '</tbody></table>');
      }
      if (r.notes && r.notes.length) {
        parts.push('<h3>前提检查</h3><ul>');
        r.notes.forEach((n) => parts.push(`<li>${esc(n)}</li>`));
        parts.push('</ul>');
      }
      if (r.conclusion) parts.push(`<p><strong>结论：</strong>${esc(r.conclusion)}</p>`);
      if (r.text) parts.push(`<h3>规范表述</h3><p>${esc(r.text)}</p>`);
      if (state.interpretation) parts.push(`<h3>AI 解读</h3><p>${esc(state.interpretation).replace(/\n/g, '<br>')}</p>`);
    }

    if (o.svg) {
      sec++;
      parts.push(`<h2>${sec} 图表</h2>`);
      parts.push(`<div class="fig">${o.svg}</div>`);
      if (o.caption) parts.push(`<p><strong>图注：</strong>${esc(o.caption).replace(/\n/g, '<br>')}</p>`);
    }

    return `<style>${REPORT_CSS}</style><div class="ld-report">${parts.join('\n')}</div>`;
  }

  /** 导出为可独立打开的 HTML 文件 */
  function documentHTML(fragment) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>LabDesk 数据分析报告</title>
<style>
  body{margin:0 auto;max-width:900px;padding:36px 28px;background:#fff}
  @media print{ body{padding:0;max-width:none} }
</style>
</head><body>${fragment || ''}</body></html>`;
  }

  function buildMarkdown(state) {
    const ds = state.dataset;
    const L = [];
    L.push(`# ${ds ? ds.name : '未命名数据集'} · 数据分析报告`);
    L.push('');
    L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}　|　LabDesk 科研数据台`);
    L.push('');
    L.push('## 1 数据概况');
    L.push('');
    if (ds) {
      L.push(`- 数据规模：${ds.rows.length} 行 × ${ds.columns.length} 列`);
      L.push(`- 数值列 ${ds.columns.filter((c) => c.type === 'number').length} 个，分类列 ${ds.columns.filter((c) => c.type !== 'number' && c.type !== 'date').length} 个`);
      L.push('');
      L.push('| 列名 | 类型 | 有效值 | 缺失 |');
      L.push('| --- | --- | --- | --- |');
      ds.columns.forEach((c, i) => {
        const vals = ds.rows.map((r) => r[i]);
        const miss = vals.filter((v) => v === null || v === '').length;
        L.push(`| ${c.name} | ${({ number: '数值', category: '分类', text: '文本', date: '日期' }[c.type] || c.type)} | ${ds.rows.length - miss} | ${miss} |`);
      });
    }
    L.push('');
    if (state.pipeline && state.pipeline.length) {
      L.push('## 2 数据整理步骤');
      L.push('');
      state.pipeline.forEach((st, i) => L.push(`${i + 1}. ${LD.ops.summarize(st)}`));
      L.push('');
    }
    if (state.curveAnalysis && state.curveAnalysis.series && state.curveAnalysis.series.length) {
      const a = state.curveAnalysis;
      const c = state.curve || {};
      const pre = c.pre || {};
      L.push('## 曲线分析');
      L.push('');
      L.push(`- 横轴：${a.x}`);
      L.push(`- 曲线：${a.series.map((s) => s.name).join('、')}`);
      L.push(`- 基线：${({ none: '不校正', als: 'ALS', poly: '多项式', linear: '端点连线', min: '减最小值' }[pre.baseline.method] || pre.baseline.method)}；平滑：${({ none: '不平滑', sg: 'Savitzky–Golay', moving: '移动平均', median: '中值', gaussian: '高斯' }[pre.smooth.method] || pre.smooth.method)}`);
      L.push('');
      const rows = [];
      a.series.forEach((s) => s.peaks.forEach((p, i) => rows.push([s.name, i + 1, p.x, p.y, p.prominence, p.fwhm, p.area])));
      if (c.peaks && c.peaks.on && rows.length) {
        L.push('| 曲线 | 序号 | 峰位 | 峰高 | 显著度 | FWHM | 面积 |');
        L.push('| --- | --- | --- | --- | --- | --- | --- |');
        rows.forEach((r) => L.push(`| ${r[0]} | ${r[1]} | ${U.fmt(r[2], 4)} | ${U.fmt(r[3], 4)} | ${U.fmt(r[4], 3)} | ${r[5] === null ? '—' : U.fmt(r[5], 4)} | ${r[6] === null ? '—' : U.fmt(r[6], 4)} |`));
        L.push('');
      }
      const f = state.curveFit;
      if (f && f.ok) {
        L.push(`### 非线性拟合：${f.modelName || f.model}`);
        L.push('');
        L.push(`目标曲线：${f.target}；R² = ${U.fmt(f.r2, 4)}，调整 R² = ${U.fmt(f.adjR2, 4)}，RMSE = ${U.fmt(f.rmse, 4)}，n = ${f.n}。`);
        L.push('');
        L.push('| 参数 | 估计值 | 标准误 | 95% CI |');
        L.push('| --- | --- | --- | --- |');
        f.paramList.forEach((p) => L.push(`| ${p.label} | ${U.fmt(p.value, 5)} | ${isFinite(p.se) ? U.fmt(p.se, 4) : '—'} | ${isFinite(p.ciLow) ? U.fmt(p.ciLow, 4) + ' ~ ' + U.fmt(p.ciHigh, 4) : '—'} |`));
        L.push('');
      }
    }
    L.push('## 描述统计');
    L.push('');
    if (state.descRows && state.descRows.length) {
      L.push('| 变量 | n | 均值 | 标准差 | 中位数 | 最小值 | 最大值 |');
      L.push('| --- | --- | --- | --- | --- | --- | --- |');
      state.descRows.forEach((d) => {
        L.push(`| ${d.name} | ${d.n} | ${U.fmt(d.mean, 3)} | ${U.fmt(d.sd, 3)} | ${U.fmt(d.median, 3)} | ${U.fmt(d.min, 3)} | ${U.fmt(d.max, 3)} |`);
      });
    }
    L.push('');
    if (state.lastTest && state.lastTest.render) {
      const r = state.lastTest.render;
      L.push(`## 统计分析：${r.title || ''}`);
      L.push('');
      if (r.stats) r.stats.forEach((s) => L.push(`- ${s.k}：${s.v}`));
      L.push('');
      if (r.notes && r.notes.length) {
        L.push('**前提检查**');
        L.push('');
        r.notes.forEach((n) => L.push(`- ${n}`));
        L.push('');
      }
      if (r.conclusion) L.push(`**结论：** ${r.conclusion}`);
      L.push('');
      if (r.text) { L.push('**规范表述**'); L.push(''); L.push(r.text); L.push(''); }
      if (state.interpretation) { L.push('**AI 解读**'); L.push(''); L.push(state.interpretation); L.push(''); }
    }
    return L.join('\n');
  }

  LD.report = { buildHTML, buildMarkdown, documentHTML };
})();
