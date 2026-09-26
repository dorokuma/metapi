import { describe, expect, it } from 'vitest';
import { translateText } from './i18n.js';

describe('translateText', () => {
  it('keeps zh text unchanged in zh mode', () => {
    expect(translateText('模型广场', 'zh')).toBe('模型广场');
  });

  it('translates exact key in en mode', () => {
    expect(translateText('模型广场', 'en')).toBe('Model Marketplace');
  });

  it('supports phrase replacement for mixed text', () => {
    expect(translateText('覆盖槽位 3', 'en')).toBe('Coverage Slots 3');
    expect(translateText('共 12 个模型', 'en')).toBe('Total 12 models');
  });

  it('never returns Chinese characters in strict en mode', () => {
    const samples = [
      '站点已禁用',
      '缓存清理后重建失败：unknown error',
      '签到任务执行中，请稍后查看签到日志',
    ];

    for (const sample of samples) {
      expect(translateText(sample, 'en')).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it('uses concrete english translations instead of fallback for common runtime text', () => {
    expect(translateText('切换到中文', 'en')).toBe('Switch to Chinese');
    expect(translateText('中', 'en')).toBe('ZH');

    const samples = [
      '站点已禁用',
      '签到任务执行中，请稍后查看签到日志',
      '下游访问令牌至少 6 位（含 sk-）',
      '路由重建任务执行中，请稍后查看程序日志',
    ];

    for (const sample of samples) {
      const translated = translateText(sample, 'en');
      expect(translated).not.toBe('Untranslated');
      expect(translated).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it('translates reworked terminology (词元 / 令牌 / 密钥) to concrete english', () => {
    expect(translateText('词元总量', 'en')).toBe('Total tokens');
    expect(translateText('缓存词元', 'en')).toBe('Cached tokens');
    expect(translateText('下游密钥', 'en')).toBe('Downstream key');
    expect(translateText('API 密钥连接', 'en')).toBe('API key connection');
    expect(translateText('验证令牌', 'en')).toBe('Verify token');
    expect(translateText('网关成本 $0.000027', 'en')).toBe('Gateway cost $0.000027');
    expect(translateText('网关推理成本 0.000028', 'en')).toBe('Gateway inference cost 0.000028');
    expect(translateText('命中 0 / 未命中 34 / 指纹 fp-1', 'en')).toBe('Hit 0 / Miss 34 / Fingerprint fp-1');
    expect(translateText('1 个模型 / 2 次提供方尝试', 'en')).toBe('1 models / 2 provider attempts');
    expect(translateText('回退', 'en')).toBe('Fallback');
  });

  it('maps the session affinity value words back to english in en mode', () => {
    expect(translateText('已确认', 'en')).toBe('confirmed');
    expect(translateText('显式', 'en')).toBe('explicit');
    expect(translateText('（显式）', 'en')).toBe('（explicit）');

    const affinityLine = translateText('结果 已确认、上游钉选 deepseek', 'en');
    expect(affinityLine).toContain('Result confirmed');
    expect(affinityLine).toContain('Upstream pinned deepseek');
    expect(affinityLine).not.toMatch(/[\u3400-\u9fff]/);

    const sessionLine = translateText('客户端会话 sess-desktop-1（显式）', 'en');
    expect(sessionLine).toContain('Client session sess-desktop-1');
    expect(sessionLine).toContain('explicit');
    expect(sessionLine).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('keeps longer keys containing 显式 intact when the short value word is added', () => {
    // 精确命中整句键（含「显式」）不受新增短词影响
    expect(
      translateText('支持排除显式令牌，以及 `tokenId` 为空时实际使用的默认 API 密钥。', 'en'),
    ).toBe('Supports excluding explicit tokens and the default API key actually used when `tokenId` is empty.');
    expect(
      translateText('默认不抓取请求体/响应体，只有显式开启后才记录。', 'en'),
    ).toBe('Request/response bodies are not captured by default; only recorded when explicitly enabled.');

    // 拼接文本中长句仍先于短词命中（最长匹配）
    const composite = translateText(
      '提示：支持排除显式令牌，以及 `tokenId` 为空时实际使用的默认 API 密钥。',
      'en',
    );
    expect(composite).toContain('Supports excluding explicit tokens and the default API key actually used when `tokenId` is empty.');
    expect(composite).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('maps whole sentences containing 显式 to concrete english (no partial-word leakage)', () => {
    // 短键「显式」引入后，含「显式」的整句必须整段命中，避免 en 模式半翻译混排
    expect(translateText('显式群组至少需要选择一个来源模型', 'en')).toBe(
      'Explicit groups require at least one source model',
    );
    expect(translateText('显式群组不能引用自身作为来源模型', 'en')).toBe(
      'An explicit group cannot reference itself as a source model',
    );
    expect(translateText('显式群组只能选择精确模型路由作为来源模型', 'en')).toBe(
      'Explicit groups can only use exact model routes as source models',
    );
    expect(translateText('关闭时请求本身显式传入的请求头优先级更高。', 'en')).toBe(
      'When disabled, headers explicitly passed in the request take precedence.',
    );

    // 顺扫补录：tokens 接口其余含「显式」消息
    expect(translateText('显式群组不支持直接维护通道', 'en')).toBe(
      'Explicit groups cannot manage channels directly',
    );
    expect(translateText('显式群组必须填写对外模型名', 'en')).toBe(
      'Explicit groups require a public model name',
    );

    const samples = [
      '显式群组至少需要选择一个来源模型',
      '显式群组不能引用自身作为来源模型',
      '显式群组只能选择精确模型路由作为来源模型',
      '显式群组不支持直接维护通道',
      '显式群组必须填写对外模型名',
      '关闭时请求本身显式传入的请求头优先级更高。',
    ];

    for (const sample of samples) {
      const translated = translateText(sample, 'en');
      expect(translated).not.toBe('Untranslated');
      expect(translated).not.toContain('explicit群组');
      expect(translated).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it('translates the hard-link empty-state copy including the window-collision clause', () => {
    const copy = '未记录上游观测，可能超出保留期，或与相邻请求撞窗无法唯一关联（观测默认保留 14 天，短于日志 30 天）';
    const translated = translateText(copy, 'en');
    expect(translated).not.toBe('Untranslated');
    expect(translated).not.toMatch(/[\u3400-\u9fff]/);
    expect(translated).toContain('or could not be uniquely matched against a neighboring request');
  });

  it('keeps upstream-observation copy free of chinese in en mode', () => {
    const samples = [
      '未记录上游观测，可能超出保留期，或与相邻请求撞窗无法唯一关联（观测默认保留 14 天，短于日志 30 天）',
      '上游自报，非 metapi 计费',
      '当前回退清单（每个站点/模型/规范模型取窗口内最新一条，不跨行并集）',
      '暂无回退清单（观测未携带回退数据）。',
      '提供方分布（按观测数排序，共 4 次观测）',
      '搜索模型、下游密钥、主分组、标签...',
      '尝试记录 (3)',
      '暂无尝试记录',
      '内容已截断展示，原始 1024 字节，当前保留 512 字节。复制按钮会复制当前数据库里保存的内容。',
      '适合定位 SSE / 流式过程中的兼容问题。',
      '按请求 ID 稳定采样，同一请求结果不随刷新变化。',
      '观测默认保留 14 天（短于日志 30 天）；请求详情按 ±2s 唯一匹配，对不上不猜测。',
      '参与站点（多选）',
      '未选择任何站点 = 不采集（即使总开关开启）',
    ];

    for (const sample of samples) {
      const translated = translateText(sample, 'en');
      expect(translated).not.toBe('Untranslated');
      expect(translated).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
});
