/* LabDesk · AI 能力（图片表格识别 / 结果解读 / 图注撰写）
   通过 WorkBuddy 云服务的免密钥大模型接口调用；未配置时自动降级为本地 OCR + 明确提示。
*/
(function () {
  const LD = (window.LD = window.LD || {});
  const U = LD.util;

  const state = {
    client: null,
    models: [],
    visionModel: null,
    textModel: null,
    status: 'idle', // idle | loading | ready | unavailable | error
    message: '',
  };

  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
  const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('资源加载失败：' + src));
      document.head.appendChild(s);
    });
  }

  async function init() {
    const cfg = window.LABDESK_CLOUD;
    if (!cfg || !cfg.endpoint || !cfg.publishableKey) {
      state.status = 'unavailable';
      state.message = '未配置模型服务';
      return state;
    }
    if (state.status === 'ready') return state;
    state.status = 'loading';
    try {
      await loadScript(SDK_URL);
      if (!window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) {
        throw new Error('SDK 未正确加载');
      }
      state.client = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
        publishableKey: cfg.publishableKey,
      });
      const models = await state.client.llm.models.list();
      state.models = (models || []).filter((m) => m.disabled !== true);
      state.visionModel = state.models.find((m) => m.supportsImages === true && m.disabledMultimodal !== true) || null;
      state.textModel = state.models.find((m) => m.supportsImages !== true) || state.models[0] || null;
      state.status = 'ready';
      state.message = `已连接模型服务（${state.models.length} 个可用模型）`;
    } catch (e) {
      state.status = 'error';
      state.message = '模型服务连接失败：' + (e && e.message ? e.message : '未知错误');
    }
    return state;
  }

  /* ---------------- 通用流式收集 ---------------- */
  async function collect(payload) {
    let text = '';
    let reasoning = '';
    const stream = state.client.llm.chat.completions.create(payload);
    for await (const chunk of stream) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (!d) continue;
      if (d.content) text += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
    }
    return { text, reasoning };
  }

  function friendlyError(e) {
    const code = (e && e.error && e.error.code) || '';
    if (code.startsWith('quota_')) return '模型调用额度不足或触发限流，请稍后再试。';
    if (code.startsWith('auth_')) return '模型服务鉴权失败，请刷新页面重试。';
    if (code.startsWith('gateway_') || code.startsWith('model_')) return '模型服务暂时不可用，请稍后重试。';
    if (code === 'request_stream_required') return '调用参数异常。';
    return '模型调用失败：' + ((e && e.error && e.error.message) || (e && e.message) || '未知错误');
  }

  /* ---------------- 图片表格识别 ---------------- */
  const OCR_SYSTEM = [
    '你是一名严谨的实验数据录入员，任务是把图片中的表格转成结构化数据。',
    '只输出 JSON，不要输出任何解释、Markdown 代码块标记或多余文字。',
    '输出格式：{"columns":["列名1","列名2"],"rows":[["值1","值2"]],"notes":"补充说明"}',
    '规则：',
    '1. 保持图片中的原始列顺序与行顺序，不要增删行列（合并单元格请按重复值展开）。',
    '2. 表头若缺失或不可读，按内容推断列名，并在 notes 中说明。',
    '3. 数值只保留数字与小数点、正负号、指数记号；不要把单位混入数值，单位写进列名或 notes。',
    '4. 完全无法辨认的单元格填 null，绝不猜测或编造数值。',
    '5. 手写体易混淆的数字（1/7、0/6、5/S、2/Z）若不确定，同样填 null 并在 notes 里标注位置。',
    '6. 图片中的批注、日期、页码、签名等非表格内容不要作为数据行，可写入 notes。',
  ].join('\n');

  function buildOcrPrompt(hint, unitHint) {
    const styleMap = {
      hand: '这是手写实验记录本的照片，数字可能有涂改、划线、箭头。请优先保证数字准确性。',
      print: '这是打印表格或软件截图，字迹清晰，请完整保留中英文列名。',
      mixed: '图片中可能同时包含手写与打印内容，请尽量完整保留可辨认的信息。',
    };
    return [
      styleMap[hint] || styleMap.hand,
      unitHint ? `已知单位信息：${unitHint}。请把单位体现在列名中（例如「产率 (%)」）。` : '',
      '请输出 JSON。',
    ].filter(Boolean).join('\n');
  }

  function parseJsonLoose(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { /* 尝试修复 */ }
    // 去掉末尾多余逗号
    try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
  }

  async function ocrImage(dataUrl, opts) {
    const o = opts || {};
    if (state.status !== 'ready') await init();
    if (state.status !== 'ready' || !state.client) throw new Error(state.message || '模型服务不可用');
    if (!state.visionModel) throw new Error('当前没有支持图片输入的模型，请改用本地备用识别或手动录入。');

    const messages = [
      { role: 'system', content: OCR_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildOcrPrompt(o.hint, o.unitHint) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];

    let res;
    try {
      res = await collect({
        model: state.visionModel.id,
        messages,
        stream: true,
        temperature: 0.1,
        stream_options: { include_usage: true },
      });
    } catch (e) {
      throw new Error(friendlyError(e));
    }

    const parsed = parseJsonLoose(res.text);
    if (!parsed || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) {
      throw new Error('模型返回的内容不是可解析的表格 JSON。可点击「本地备用识别」，或手动录入。');
    }
    const width = parsed.columns.length;
    const rows = parsed.rows.map((r) => {
      const a = Array.isArray(r) ? r.slice(0, width) : [];
      while (a.length < width) a.push(null);
      return a;
    });
    return {
      columns: parsed.columns.map((c, i) => String(c || '列' + (i + 1)).trim()),
      rows,
      notes: parsed.notes || '',
      model: state.visionModel.name || state.visionModel.id,
    };
  }

  /* ---------------- 本地 OCR 兜底 ---------------- */
  async function localOcr(dataUrl, onProgress) {
    await loadScript(TESS_URL);
    if (!window.Tesseract) throw new Error('本地识别引擎加载失败，请检查网络后重试');
    const res = await window.Tesseract.recognize(dataUrl, 'chi_sim+eng', {
      logger: (m) => { if (onProgress && m.status) onProgress(m.status, m.progress); },
    });
    const text = (res.data && res.data.text) || '';
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
    if (!lines.length) throw new Error('没有识别到文字');
    // 按行切分，再按 2 个以上空格 / 制表符分列
    const rows = lines.map((l) => l.split(/\t+|\s{2,}/).map((s) => s.trim()).filter((s, i, a) => s.length || (i > 0 && i < a.length - 1)));
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const norm = rows.map((r) => {
      const c = r.slice(0, width);
      while (c.length < width) c.push('');
      return c;
    });
    return { matrix: norm, text };
  }

  /* ---------------- 结果解读 ---------------- */
  const EXPLAIN_SYSTEM = [
    '你是一位有 20 年经验的生物医学/工程领域统计审稿人。',
    '任务：把给定的统计结果写成可直接用于论文「结果」部分的规范表述，并指出潜在的方法学问题。',
    '要求：',
    '1. 先给一段 2–4 句的规范表述，包含统计量、自由度、p 值与效应量，格式如「t(22) = 2.41, p = 0.024, Cohen\'s d = 0.78」。',
    '2. p 值按 APA 格式：小于 0.001 写作 p < 0.001，其余保留三位小数且不写前导零（p = .024）。',
    '3. 明确指出该检验的前提假设是否满足，以及若不满足应改用哪种方法。',
    '4. 不要编造数据中不存在的数字，只使用给定的统计量。',
    '5. 用中文回答，不要使用 Markdown 标题。',
  ].join('\n');

  async function explain(payload) {
    if (state.status !== 'ready') await init();
    if (state.status !== 'ready' || !state.client) throw new Error(state.message || '模型服务不可用');
    const model = state.textModel || state.visionModel;
    if (!model) throw new Error('没有可用的文本模型');
    const res = await collect({
      model: model.id,
      messages: [
        { role: 'system', content: EXPLAIN_SYSTEM },
        { role: 'user', content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) },
      ],
      stream: true,
      temperature: 0.3,
    });
    return res.text.trim();
  }

  /* ---------------- 图注 ---------------- */
  const CAPTION_SYSTEM = [
    '你是一位期刊编辑。请为给定的图表撰写英文图注（Figure legend）与中文图注各一段。',
    '英文图注格式：一句加粗的短标题 + 1–2 句方法说明（样本量 n、误差棒含义、统计检验方法、显著性标记含义）。',
    '中文图注与英文对应，术语准确。',
    '不要编造未提供的统计结果。',
  ].join('\n');

  async function caption(payload) {
    if (state.status !== 'ready') await init();
    if (state.status !== 'ready' || !state.client) throw new Error(state.message || '模型服务不可用');
    const model = state.textModel || state.visionModel;
    const res = await collect({
      model: model.id,
      messages: [
        { role: 'system', content: CAPTION_SYSTEM },
        { role: 'user', content: JSON.stringify(payload, null, 1) },
      ],
      stream: true,
      temperature: 0.4,
    });
    return res.text.trim();
  }

  LD.ai = {
    init, ocrImage, localOcr, explain, caption, parseJsonLoose,
    get state() { return state; },
    isReady: () => state.status === 'ready',
  };
})();
