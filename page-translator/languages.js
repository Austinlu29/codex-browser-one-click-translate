(() => {
  const entries = [
    ['en', '英语'], ['zh', '简体中文'], ['zh-Hant', '繁体中文'], ['ja', '日语'], ['ko', '韩语'],
    ['de', '德语'], ['fr', '法语'], ['es', '西班牙语'], ['ru', '俄语'], ['ar', '阿拉伯语'],
    ['bg', '保加利亚语'], ['bn', '孟加拉语'], ['cs', '捷克语'], ['da', '丹麦语'], ['el', '希腊语'],
    ['fi', '芬兰语'], ['he', '希伯来语'], ['hi', '印地语'], ['hr', '克罗地亚语'], ['hu', '匈牙利语'],
    ['id', '印尼语'], ['it', '意大利语'], ['kn', '卡纳达语'], ['lt', '立陶宛语'], ['mr', '马拉地语'],
    ['nl', '荷兰语'], ['no', '挪威语'], ['pl', '波兰语'], ['pt', '葡萄牙语'], ['ro', '罗马尼亚语'],
    ['sk', '斯洛伐克语'], ['sl', '斯洛文尼亚语'], ['sv', '瑞典语'], ['ta', '泰米尔语'], ['te', '泰卢固语'],
    ['th', '泰语'], ['tr', '土耳其语'], ['uk', '乌克兰语'], ['vi', '越南语']
  ];
  const labels = new Map(entries);
  function normalize(value, fallback = 'en') {
    const language = String(value || '').trim();
    if (/^zh-(TW|HK|Hant)(?:-|$)/i.test(language)) return 'zh-Hant';
    const base = language.toLowerCase().split('-')[0];
    return labels.has(base) ? base : fallback;
  }
  function settings(values = {}) {
    return { sourceLanguage: values.sourceLanguage === 'auto' ? 'auto' : normalize(values.sourceLanguage),
      targetLanguage: normalize(values.targetLanguage, 'zh') };
  }
  function fill(select, auto = false) {
    if (auto) select.add(new Option('自动检测', 'auto'));
    for (const [code, label] of entries) select.add(new Option(label, code));
  }
  globalThis.PageLanguages = { entries, normalize, settings, fill,
    label: code => code === 'auto' ? '自动检测' : labels.get(code) || code };
})();
