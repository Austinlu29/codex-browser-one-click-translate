(() => {
  if (globalThis.__oneClickTranslator) return;
  globalThis.__oneClickTranslator = true;

  const skippedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE']);
  const attributes = ['title', 'placeholder', 'alt', 'aria-label'];
  const records = new Map();
  const observedRoots = new Set();
  let enabled = false;
  let running = false;
  let rerun = false;
  let epoch = 0;
  let timer;
  let translatedCount = 0;
  let failures = 0;
  let lastError = '';
  let host;
  let button;
  let status;
  let preparing = false;
  let preparation;
  let progress = '';
  const languages = globalThis.PageLanguages;
  let preferences = { sourceLanguage: 'en', targetLanguage: 'zh' };
  let sourceSelect;
  let targetSelect;
  let swapButton;
  const local = new globalThis.PageLocalTranslator(message => { progress = message; updateUI(); });
  function showSettings(settings) {
    preferences = languages.settings(settings);
    if (sourceSelect) {
      sourceSelect.value = preferences.sourceLanguage;
      targetSelect.value = preferences.targetLanguage;
      swapButton.disabled = preferences.sourceLanguage === 'auto';
    }
  }
  async function saveLanguages(from, to) {
    try {
      await chrome.storage.local.set({ sourceLanguage: from, targetLanguage: to });
      showSettings({ sourceLanguage: from, targetLanguage: to });
    } catch (error) { lastError = error.message; showSettings(preferences); updateUI(); }
  }
  chrome.storage.onChanged.addListener(changes => {
    if (!changes.sourceLanguage && !changes.targetLanguage) return;
    showSettings({ ...preferences,
      ...(changes.sourceLanguage ? { sourceLanguage: changes.sourceLanguage.newValue } : {}),
      ...(changes.targetLanguage ? { targetLanguage: changes.targetLanguage.newValue } : {}) });
    restore();
    // Every frame restores immediately; the top frame also invalidates pending background commands.
    if (window.top === window) void command('restore');
  });
  void chrome.storage.local.get(preferences).then(showSettings).catch(() => {});

  function valueOf(item) {
    return item.key === '#text' ? item.node.nodeValue : item.node.getAttribute(item.key);
  }
  function writeValue(item, value) {
    if (item.key === '#text') item.node.nodeValue = value;
    else item.node.setAttribute(item.key, value);
  }
  function saved(item) { return records.get(item.node)?.get(item.key); }
  function save(item, translated) {
    let values = records.get(item.node);
    if (!values) records.set(item.node, values = new Map());
    values.set(item.key, { original: item.original, translated });
  }
  function forbidden(node) {
    if (node.nodeType === Node.TEXT_NODE && node.parentElement?.tagName === 'TEXTAREA') return true;
    for (let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement; element;) {
      if (element === host || skippedTags.has(element.tagName) || element.isContentEditable ||
          element.getAttribute('contenteditable') === '' || element.getAttribute('contenteditable') === 'true' ||
          element.getAttribute('translate') === 'no' || element.classList?.contains('notranslate')) return true;
      element = element.parentElement || element.getRootNode()?.host;
    }
    return false;
  }
  function needsTranslation(text) {
    if (!text || text.length > 30000) return false;
    const trimmed = text.trim();
    if (!trimmed || /^[\d\s\p{P}\p{S}]+$/u.test(trimmed) || /^https?:\/\/\S+$/i.test(trimmed)) return false;
    // Chinese can be a source language; only skip it for an already-Chinese target.
    return preferences.targetLanguage !== 'zh' || preferences.sourceLanguage === 'zh-Hant' ||
      !/^[\p{Script=Han}\d\s\p{P}\p{S}]+$/u.test(trimmed);
  }
  function addItem(items, node, key, original) {
    if (!needsTranslation(original)) return;
    const item = { node, key, original };
    if (saved(item)?.translated === original) return;
    items.push(item);
  }

  const observer = new MutationObserver(mutations => {
    if (!enabled) return;
    const changed = mutations.some(mutation => {
      if (forbidden(mutation.target)) return false;
      const key = mutation.type === 'characterData' ? '#text' : mutation.attributeName;
      if (key && saved({ node: mutation.target, key })?.translated === valueOf({ node: mutation.target, key })) return false;
      return true;
    });
    if (!changed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (running) rerun = true; else void scan(); }, 450);
  });
  function observe(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: [...attributes, 'translate', 'contenteditable'] });
  }
  function collect(root, items) {
    observe(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (forbidden(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) addItem(items, node, '#text', node.nodeValue);
      else {
        for (const key of attributes) addItem(items, node, key, node.getAttribute(key));
        if (node.shadowRoot) collect(node.shadowRoot, items);
      }
    }
  }

  function prioritize(items) {
    const priorities = new WeakMap();
    for (const item of items) {
      const element = item.node.nodeType === Node.TEXT_NODE ? item.node.parentElement : item.node;
      if (!element) { item.priority = 2; continue; }
      if (!priorities.has(element)) {
        const rect = element.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight &&
          rect.right > 0 && rect.left < window.innerWidth;
        priorities.set(element, element.tagName === 'TITLE' || visible ? 0 : 1);
      }
      item.priority = priorities.get(element);
    }
    items.sort((a, b) => a.priority - b.priority);
  }

  function applyResult(items, result) {
    for (const item of items) {
      if (!item.node.isConnected || valueOf(item) !== item.original) continue;
      if (result?.error || !result?.text) {
        failures++;
        lastError = result?.error || '没有译文';
        continue;
      }
      const leading = item.original.match(/^\s*/)[0];
      const trailing = item.original.match(/\s*$/)[0];
      const translated = leading + result.text + trailing;
      save(item, translated);
      writeValue(item, translated);
      translatedCount++;
    }
    updateUI();
  }

  function updateUI() {
    if (!button) return;
    button.textContent = preparing ? '取消准备' : !enabled ? '一键翻译' : running ? '停止并恢复' : '恢复原文';
    button.setAttribute('aria-label', button.textContent);
    if (preparing) status.textContent = progress || '正在准备本地翻译模型…';
    else if (running && enabled) status.textContent = `本地翻译 · 已完成 ${translatedCount} 处`;
    else if (enabled && failures) status.textContent = lastError || `${translatedCount} 处已翻译 · ${failures} 处未完成`;
    else if (enabled) status.textContent = translatedCount ? `已翻译 ${translatedCount} 处 · 新内容自动翻译` : '当前没有需要翻译的文本';
    else status.textContent = lastError || `${languages.label(preferences.sourceLanguage)} → ${languages.label(preferences.targetLanguage)} · 本地翻译`;
    status.title = lastError || progress;
  }

  async function scan() {
    if (!enabled || running) return;
    running = true;
    rerun = false;
    const version = epoch;
    const items = [];
    // Clean detached references, but retain document.title and shadow nodes.
    for (const node of records.keys()) if (!node.isConnected) records.delete(node);
    collect(document.documentElement, items);
    prioritize(items);
    const groups = new Map();
    for (const item of items) {
      const text = item.original.trim();
      if (!groups.has(text)) groups.set(text, []);
      groups.get(text).push(item);
    }
    const jobs = [...groups];
    let next = 0;
    let blocked = false;
    updateUI();
    try {
      async function work() {
        while (next < jobs.length && enabled && epoch === version && !blocked) {
          const [text, nodes] = jobs[next++];
          try {
            const response = await chrome.runtime.sendMessage({ type: 'translate-texts', texts: [text] });
            if (!enabled || epoch !== version) return;
            if (!response?.ok) throw new Error(response?.error || '翻译扩展未响应');
            if (response.results?.[0]?.code === 'UNSUPPORTED_BROWSER') blocked = true;
            applyResult(nodes, response.results?.[0]);
          } catch (error) {
            if (enabled && epoch === version) applyResult(nodes, { error: error.message });
          }
        }
      }
      // Local inference is queued by the browser; keep only a few requests in flight.
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, work));
    } catch (error) { lastError = error.message; failures++; }
    finally {
      running = false;
      updateUI();
      if (enabled && epoch !== version) void scan();
      else if (enabled && rerun && !failures) void scan();
    }
  }

  function start() {
    if (!enabled) { enabled = true; epoch++; }
    failures = 0;
    lastError = '';
    if (running) rerun = true;
    else void scan();
    return { ok: true };
  }
  function restore() {
    if (preparing) local.cancelPreparation();
    preparing = false;
    preparation = null;
    progress = '';
    enabled = false;
    epoch++;
    clearTimeout(timer);
    observer.disconnect();
    observedRoots.clear();
    for (const [node, values] of records) {
      for (const [key, record] of values) {
        const item = { node, key };
        // Do not overwrite newer values written by the site itself.
        if (node.isConnected && valueOf(item) === record.translated) writeValue(item, record.original);
      }
    }
    records.clear();
    translatedCount = 0;
    failures = 0;
    lastError = '';
    updateUI();
    return { ok: true };
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'translator-capabilities') { respond(local.capabilities()); return; }
    if (message.type === 'translator-prepare' && window.top === window) {
      prepare().then(respond, error => respond({ ok: false, error: error.message, code: error.code }));
      return true;
    }
    if (message.type === 'translator-local-texts' && window.top === window) {
      if (!Array.isArray(message.texts) || message.texts.length > 32 || message.texts.some(text => typeof text !== 'string' || text.length > 30000)) {
        respond({ ok: false, error: '无效的翻译文本' }); return;
      }
      Promise.all(message.texts.map(async text => {
        try { return { text: await local.translate(text) }; }
        catch (error) { return { error: error.message, code: error.code }; }
      })).then(results => respond({ ok: true, results }));
      return true;
    }
    if (message.type !== 'translator-command') return;
    respond(message.command === 'translate' ? start() : restore());
  });

  function prepare() {
    if (preparation) return preparation;
    preparing = true;
    lastError = '';
    progress = '';
    updateUI();
    const task = (async () => {
      const settings = await chrome.storage.local.get({ sourceLanguage: 'en', targetLanguage: 'zh' });
      if (preparation !== task) {
        const error = new Error('模型准备已取消');
        error.code = 'CANCELLED';
        throw error;
      }
      showSettings(settings);
      return await local.prepare(preferences.sourceLanguage, preferences.targetLanguage);
    })().catch(error => {
      if (preparation === task && error.code !== 'CANCELLED') lastError = error.message;
      throw error;
    }).finally(() => {
      if (preparation === task) {
        preparing = false;
        preparation = null;
        updateUI();
      }
    });
    preparation = task;
    return task;
  }

  async function command(command) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'page-command', command });
      if (!response?.ok) throw new Error(response?.error || '网页未响应');
    } catch (error) {
      lastError = error.message;
      status.textContent = error.message;
      status.title = error.message;
    }
  }
  async function mount() {
    if (window.top !== window) return;
    host = document.createElement('div');
    host.setAttribute('translate', 'no');
    host.setAttribute('data-page-local-translator', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;left:14px!important;bottom:18px!important;z-index:2147483647!important';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host{color-scheme:light} *{box-sizing:border-box}
      .panel{width:280px;padding:12px;border:1px solid #cddbd5;border-radius:14px;background:#fff;box-shadow:0 6px 30px #0002;font:13px/1.5 system-ui,sans-serif;color:#24352d}
      .row{display:flex;gap:7px;align-items:center} button{font:inherit;cursor:pointer;border:0;border-radius:9px;padding:8px 12px}
      .main{flex:1;color:#fff;background:#146b47;font-weight:600}.main:hover{background:#0f5337}.close{background:#eef3f0;color:#52685c;padding:8px}
      .status{margin:8px 0 0;font-size:11px;color:#53665b}.retry{margin-top:7px;background:#edf5f0;color:#146b47;font-size:12px;padding:4px 8px}
      button:focus-visible{outline:3px solid #57bb95;outline-offset:2px}.mini{background:transparent;color:#fff;border-radius:7px;width:42px;height:42px;padding:0}.mini img{display:block;width:42px;height:42px}
      .languages{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr);gap:7px;align-items:end;margin-bottom:10px}
      label{font-size:11px;color:#53665b}select{width:100%;margin-top:4px;padding:7px 4px;border:1px solid #cddbd5;border-radius:7px;background:#fff;color:#24352d;font:12px system-ui,sans-serif}
      .swap{padding:0;height:32px;background:#eef3f0;color:#146b47;font-size:19px}.swap:disabled{opacity:.4;cursor:default}select:focus-visible{outline:3px solid #57bb95;outline-offset:2px}
    `;
    shadow.append(style);
    const panel = document.createElement('div'); panel.className = 'panel'; panel.hidden = true;
    const selectors = document.createElement('div'); selectors.className = 'languages';
    function languageSelect(title, auto) {
      const label = document.createElement('label'); label.textContent = title;
      const select = document.createElement('select'); select.setAttribute('aria-label', title);
      languages.fill(select, auto); label.append(select);
      return { label, select };
    }
    const from = languageSelect('原文语言', true), to = languageSelect('目标语言', false);
    sourceSelect = from.select; targetSelect = to.select;
    swapButton = document.createElement('button'); swapButton.className = 'swap'; swapButton.textContent = '⇄';
    swapButton.title = '交换原文与目标语言'; swapButton.setAttribute('aria-label', '交换语言');
    sourceSelect.onchange = targetSelect.onchange = () => void saveLanguages(sourceSelect.value, targetSelect.value);
    swapButton.onclick = () => void saveLanguages(targetSelect.value, sourceSelect.value);
    selectors.append(from.label, swapButton, to.label); showSettings(preferences);
    const row = document.createElement('div'); row.className = 'row';
    button = document.createElement('button'); button.className = 'main';
    button.onclick = () => void command(preparing || enabled ? 'restore' : 'translate');
    const close = document.createElement('button'); close.className = 'close'; close.textContent = '−'; close.title = '收起翻译按钮';
    const mini = document.createElement('button'); mini.className = 'mini'; mini.title = '展开网页翻译'; mini.setAttribute('aria-label', '展开网页翻译'); mini.hidden = false;
    const miniIcon = document.createElement('img'); miniIcon.src = chrome.runtime.getURL('icons/icon-48.png'); miniIcon.alt = ''; mini.append(miniIcon);
    close.onclick = () => { panel.hidden = true; mini.hidden = false; };
    mini.onclick = () => { panel.hidden = false; mini.hidden = true; };
    status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status');
    const retry = document.createElement('button'); retry.className = 'retry'; retry.textContent = '翻译 / 重试'; retry.title = '翻译尚未完成的文本';
    retry.onclick = () => void command('translate');
    row.append(button, close); panel.append(selectors, row, status, retry); shadow.append(panel, mini);
    document.documentElement.append(host);
    // Page routers can replace the body or HTML children after document_idle.
    // Keep the existing UI alive, including while translation is inactive/collapsed.
    const hostObserver = new MutationObserver(() => {
      const root = globalThis.document?.documentElement;
      if (!root || host.parentNode === root) return;
      root.append(host);
      if (enabled) {
        if (running) rerun = true;
        else void scan();
      }
    });
    hostObserver.observe(document, { childList: true, subtree: true });
    function setFloatingVisible(visible) {
      host.hidden = !visible;
      // Inline all:initial must not override the user's hidden preference.
      host.style.setProperty('display', visible ? 'block' : 'none', 'important');
    }
    const floatingSettings = await chrome.storage.local.get({ floating: true });
    setFloatingVisible(floatingSettings.floating);
    chrome.storage.onChanged.addListener(changes => { if (changes.floating) setFloatingVisible(changes.floating.newValue); });
    updateUI();
  }
  void mount();
})();
