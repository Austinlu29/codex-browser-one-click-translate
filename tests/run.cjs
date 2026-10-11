const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const contentSource = fs.readFileSync(path.join(root, 'page-translator/content.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'page-translator/background.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(root, 'page-translator/local-translator.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for expected DOM state');
    await delay(10);
  }
}

function page(html, send, beforeLoad, afterEngine) {
  const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only' });
  const listeners = [];
  const calls = [];
  dom.window.chrome = {
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) {
        calls.push(message);
        if (message.type === 'page-command') return command(message.command);
        return send(message);
      } },
    storage: { local: { get: async defaults => defaults }, onChanged: { addListener() {} } }
  };
  function command(name) {
    let response;
    for (const listener of listeners) listener({ type: 'translator-command', command: name }, {}, value => { response = value; });
    return response;
  }
  beforeLoad?.(dom.window.document);
  dom.window.eval(engineSource);
  afterEngine?.(dom.window);
  dom.window.eval(contentSource);
  function request(message) {
    return new Promise(resolve => {
      for (const listener of listeners) listener(message, {}, resolve);
    });
  }
  return { dom, document: dom.window.document, command, request, calls, close: () => dom.window.close() };
}
function translateMock(message) {
  return Promise.resolve({ ok: true, results: message.texts.map(text => ({ text: `译：${text}` })) });
}
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('不会在用户点击前上传文本；保留嵌套 HTML、空白和表单值', async () => {
  const p = page('<title>Hello</title><p id="p">  Hello <strong>world</strong>!  </p><input value="private" placeholder="Search"><textarea placeholder="Message">secret note</textarea><pre>const value = 1</pre><p translate="no">Leave alone</p><p class="notranslate">Also leave</p>', translateMock);
  await delay(20);
  assert.equal(p.calls.length, 0);
  p.command('translate');
  await until(() => p.document.querySelector('strong').textContent === '译：world');
  assert.equal(p.document.title, '译：Hello');
  assert.equal(p.document.querySelector('#p').firstChild.nodeValue, '  译：Hello ');
  assert.equal(p.document.querySelector('input').value, 'private');
  assert.equal(p.document.querySelector('input').placeholder, '译：Search');
  assert.equal(p.document.querySelector('textarea').value, 'secret note');
  assert.equal(p.document.querySelector('textarea').placeholder, '译：Message');
  assert.equal(p.document.querySelector('pre').textContent, 'const value = 1');
  assert.equal(p.document.querySelector('[translate=no]').textContent, 'Leave alone');
  assert.equal(p.document.querySelector('.notranslate').textContent, 'Also leave');
  p.command('restore');
  assert.equal(p.document.title, 'Hello');
  assert.equal(p.document.querySelector('#p').textContent, '  Hello world!  ');
  assert.equal(p.document.querySelector('input').placeholder, 'Search');
  p.close();
});

test('纯中文、数字、网址、可编辑区域不发翻译请求', async () => {
  const p = page('<p>你好世界！123</p><p>42 / 50</p><p>https://example.com/path</p><div contenteditable="true">my secret draft</div>', translateMock);
  p.command('translate');
  await delay(20);
  assert.equal(p.calls.length, 0);
  p.close();
});

test('支持开放 Shadow DOM 和提示属性，恢复时完整还原', async () => {
  const p = page('<div id="shadow"></div><img alt="A cat" title="Photo">', translateMock, document => {
    document.querySelector('#shadow').attachShadow({ mode: 'open' }).innerHTML = '<span>Hello shadow</span>';
  });
  p.command('translate');
  await until(() => p.document.querySelector('#shadow').shadowRoot.textContent === '译：Hello shadow');
  assert.equal(p.document.querySelector('img').alt, '译：A cat');
  p.command('restore');
  assert.equal(p.document.querySelector('#shadow').shadowRoot.textContent, 'Hello shadow');
  assert.equal(p.document.querySelector('img').alt, 'A cat');
  p.close();
});

test('新增内容自动翻译；恢复不覆盖网站的新值', async () => {
  const p = page('<p id="first">Hello</p>', translateMock);
  p.command('translate');
  await until(() => p.document.querySelector('#first').textContent === '译：Hello');
  const added = p.document.createElement('p'); added.textContent = 'New content'; p.document.body.append(added);
  await until(() => added.textContent === '译：New content');
  p.document.querySelector('#first').firstChild.nodeValue = 'New site value';
  p.command('restore');
  assert.equal(p.document.querySelector('#first').textContent, 'New site value');
  assert.equal(added.textContent, 'New content');
  await delay(500);
  assert.equal(p.document.querySelector('#first').textContent, 'New site value');
  p.close();
});

test('停止后丢弃迟到的译文，连续启动不会写回旧会话', async () => {
  const pending = [];
  const p = page('<p>Hello</p>', message => new Promise(resolve => pending.push(() => resolve({ ok: true, results: message.texts.map(() => ({ text: '你好' })) }))));
  p.command('translate');
  assert.equal(pending.length, 1);
  p.command('restore');
  pending.shift()();
  await delay(20);
  assert.equal(p.document.querySelector('p').textContent, 'Hello');
  p.command('translate');
  p.command('restore');
  p.command('translate');
  pending.shift()();
  await until(() => pending.length === 1);
  pending.shift()();
  await until(() => p.document.querySelector('p').textContent === '你好');
  p.close();
});

test('失败保留原文，重试成功，译文不会再次循环翻译', async () => {
  let failing = true;
  const p = page('<p>Hello</p>', message => failing ? Promise.resolve({ ok: true, results: [{ error: 'offline' }] }) : translateMock(message));
  p.command('translate');
  await delay(30);
  assert.equal(p.document.querySelector('p').textContent, 'Hello');
  await delay(500);
  assert.equal(p.calls.length, 1);
  failing = false;
  p.command('translate');
  await until(() => p.document.querySelector('p').textContent === '译：Hello');
  await delay(500);
  assert.equal(p.calls.length, 2);
  p.close();
});

test('慢请求不阻塞已完成的文本和后续文本', async () => {
  let resolveSlow;
  const html = '<p id="slow">Slow</p>' + Array.from({ length: 40 }, (_, i) => `<p id="n${i}">Quick ${i}</p>`).join('');
  const p = page(html, message => message.texts[0] === 'Slow' ? new Promise(resolve => { resolveSlow = resolve; }) : translateMock(message));
  p.command('translate');
  await until(() => p.document.querySelector('#n39').textContent === '译：Quick 39');
  assert.equal(p.document.querySelector('#slow').textContent, 'Slow');
  resolveSlow({ ok: true, results: [{ text: '慢' }] });
  await until(() => p.document.querySelector('#slow').textContent === '慢');
  p.close();
});

test('屏幕内的文本优先，重复原文全页仅发送一次', async () => {
  const html = Array.from({ length: 35 }, (_, i) => `<p>Below ${i}</p>`).join('') + '<p id="visible">Visible</p><p>Visible</p>';
  const sent = [];
  const p = page(html, message => { sent.push(message.texts[0]); return translateMock(message); }, document => {
    document.querySelector('#visible').getBoundingClientRect = () => ({ width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 });
  });
  p.command('translate');
  await until(() => sent.length === 36);
  assert.equal(sent[0], 'Visible');
  assert.equal(sent.filter(text => text === 'Visible').length, 1);
  p.close();
});

function engine(options = {}) {
  const dom = new JSDOM('<html lang="en"><body></body></html>', { url: 'https://example.com/', runScripts: 'outside-only' });
  const progress = [], translated = [], created = [];
  dom.window.fetch = () => { throw new Error('Local mode must not fetch'); };
  if (!options.unsupported) dom.window.Translator = {
    availability: async ({ sourceLanguage }) => options.availability?.(sourceLanguage) || 'available',
    create: async ({ sourceLanguage, targetLanguage, monitor }) => {
      created.push(sourceLanguage);
      assert.equal(targetLanguage, 'zh');
      monitor({ addEventListener(_name, callback) { callback({ loaded: .5 }); } });
      if (options.denied) { const error = new Error('gesture needed'); error.name = 'NotAllowedError'; throw error; }
      return { translate: async text => { translated.push(text); return `译：${text}`; } };
    }
  };
  if (options.detect) dom.window.LanguageDetector = {
    create: async () => ({ detect: async text => options.detect(text) })
  };
  dom.window.eval(engineSource);
  if (options.create) dom.window.Translator.create = options.create;
  if (options.detectorCreate) dom.window.LanguageDetector = { create: options.detectorCreate };
  const instance = new dom.window.PageLocalTranslator(message => progress.push(message), options.deadlines);
  return { dom, instance, progress, translated, created, close: () => { instance.cancelPreparation(); dom.window.close(); } };
}

test('本地模型无需网络、缓存相同文本，下载显示进度', async () => {
  const e = engine({ availability: () => 'downloadable' });
  await e.instance.prepare('en');
  assert.equal(await e.instance.translate('Hello world'), '译：Hello world');
  assert.equal(await e.instance.translate('Hello world'), '译：Hello world');
  assert.equal(e.translated.length, 1);
  assert.equal(e.created.length, 1);
  assert.ok(e.progress.some(message => message.includes('50%')));
  e.close();
});

test('不支持本地 API 时明确失败，不回退云端', async () => {
  const e = engine({ unsupported: true });
  assert.equal(e.instance.capabilities().translator, false);
  await assert.rejects(e.instance.prepare(), error => error.code === 'UNSUPPORTED_BROWSER');
  e.close();
});

test('自动识别语言；低置信度短文本使用页面语言', async () => {
  const e = engine({ detect: async text => [{ detectedLanguage: text.includes('Bonjour') ? 'fr' : 'de', confidence: text.includes('Bonjour') ? .95 : .1 }] });
  await e.instance.prepare('auto');
  await e.instance.translate('Bonjour tout le monde');
  await e.instance.translate('Uncertain source language');
  await e.instance.translate('Search');
  assert.equal(e.created.join(','), 'en,fr');
  e.close();
});

test('新的语言包需要用户点击准备，不静默开始下载', async () => {
  let frenchReady = false;
  const e = engine({ availability: language => language === 'fr' && !frenchReady ? 'downloadable' : 'available',
    detect: async () => [{ detectedLanguage: 'fr', confidence: .95 }] });
  await e.instance.prepare('auto');
  await assert.rejects(e.instance.translate('Bonjour tout le monde'), error => error.code === 'MODEL_REQUIRED');
  assert.equal(e.created.join(','), 'en');
  await e.instance.prepare('auto');
  frenchReady = true;
  assert.equal(await e.instance.translate('Bonjour tout le monde'), '译：Bonjour tout le monde');
  assert.equal(e.created.join(','), 'en,fr');
  e.close();
});

test('模型下载需要手势或语言不受支持时给出具体原因', async () => {
  const denied = engine({ denied: true });
  await assert.rejects(denied.instance.prepare('en'), error => error.code === 'MODEL_REQUIRED' && error.message.includes('左下角'));
  denied.close();
  const unavailable = engine({ availability: () => 'unavailable' });
  await assert.rejects(unavailable.instance.prepare('ja'), error => error.code === 'UNSUPPORTED_PAIR');
  unavailable.close();
});

test('切换原文语言不会复用旧语言的译文缓存', async () => {
  const e = engine();
  await e.instance.prepare('en'); await e.instance.translate('Hello');
  await e.instance.prepare('de'); await e.instance.translate('Hello');
  assert.equal(e.translated.length, 2);
  e.close();
});

function router(sendMessage) {
  let handler;
  const sandbox = { chrome: { runtime: { id: 'test-extension', onMessage: { addListener(fn) { handler = fn; } } }, tabs: { sendMessage } } };
  vm.createContext(sandbox); vm.runInContext(workerSource, sandbox);
  return (message, sender = { id: 'test-extension', tab: { id: 7 } }) => new Promise(resolve => handler(message, sender, resolve));
}

test('子页面本地翻译路由到主页面，准备成功后才广播', async () => {
  const calls = [];
  const send = router(async (tabId, message, options) => {
    calls.push({ tabId, message, options });
    return message.type === 'translator-local-texts' ? { ok: true, results: [{ text: '你好' }] } : { ok: true };
  });
  const translated = await send({ type: 'translate-texts', texts: ['Hello'] });
  assert.equal(translated.results[0].text, '你好');
  assert.equal(calls[0].options.frameId, 0);
  await send({ type: 'page-command', command: 'translate' });
  assert.equal(calls[1].message.type, 'translator-prepare');
  assert.equal(calls[2].message.type, 'translator-command');
  assert.equal(calls[2].options, undefined);
});

test('准备模型时点击恢复会取消稍后的自动开始', async () => {
  let complete;
  const broadcast = [];
  const send = router(async (_tabId, message) => {
    if (message.type === 'translator-prepare') return new Promise(resolve => { complete = resolve; });
    broadcast.push(message.command); return { ok: true };
  });
  const pending = send({ type: 'page-command', command: 'translate' });
  await send({ type: 'page-command', command: 'restore' });
  complete({ ok: true });
  assert.equal((await pending).cancelled, true);
  assert.equal(broadcast.join(','), 'restore');
});

test('拒绝未知来源与过大文本，扩展不包含云端权限或请求', async () => {
  const send = router(() => { throw new Error('must not route invalid message'); });
  assert.equal((await send({ type: 'translate-texts', texts: ['Hello'] }, { id: 'other' })).ok, false);
  assert.equal((await send({ type: 'translate-texts', texts: ['x'.repeat(30001)] })).ok, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'page-translator/manifest.json'), 'utf8'));
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(!workerSource.includes('translate.googleapis.com'));
  assert.ok(!workerSource.includes('fetch('));
});

test('语言检测模型卡住时，英译中仍立即就绪并能翻译', async () => {
  const e = engine({ detectorCreate: () => new Promise(() => {}), deadlines: { detectorCreation: 30 } });
  await Promise.race([e.instance.prepare('auto'), delay(100).then(() => { throw new Error('Preparation waited for optional detector'); })]);
  assert.equal(await e.instance.translate('Welcome to this English page'), '译：Welcome to this English page');
  await until(() => e.instance.detectorPromise === null);
  assert.equal(e.instance.detector, null);
  e.close();
});

test('语言检测单次推理超时会回退网页语言，不会挂住翻译', async () => {
  const e = engine({ detect: () => new Promise(() => {}), deadlines: { detection: 15 } });
  await e.instance.prepare('auto');
  assert.equal(await e.instance.translate('Welcome to this English page'), '译：Welcome to this English page');
  assert.equal(e.created.join(','), 'en');
  e.close();
});

test('下载到 100% 后显示初始化；卡住超时会清除缓存并允许重试', async () => {
  let signal, finishLate, destroyed = 0;
  const e = engine({ availability: () => 'downloadable', deadlines: { initialization: 20, download: 100 },
    create: ({ monitor, signal: supplied }) => {
      signal = supplied;
      monitor({ addEventListener(_name, callback) { callback({ loaded: 1 }); callback({ loaded: 1 }); } });
      return new Promise(resolve => { finishLate = resolve; });
    }
  });
  await assert.rejects(e.instance.prepare('en'), error => error.code === 'MODEL_INIT_TIMEOUT');
  assert.ok(signal.aborted);
  assert.ok(e.progress.some(message => message.includes('下载完成，正在初始化')));
  assert.ok(!e.progress.some(message => message.includes('下载 100%')));
  assert.equal(e.instance.translators.size, 0);
  finishLate({ destroy() { destroyed++; } });
  await delay(0);
  assert.equal(destroyed, 1);
  e.dom.window.Translator.create = async () => ({ translate: async () => '你好' });
  await e.instance.prepare('en');
  assert.equal(await e.instance.translate('Hello'), '你好');
  e.close();
});

test('已下载的模型没有初始化进度事件时，同样会超时退出', async () => {
  const e = engine({ deadlines: { initialization: 15 }, create: () => new Promise(() => {}) });
  await assert.rejects(e.instance.prepare('en'), error => error.code === 'MODEL_INIT_TIMEOUT');
  e.close();
});

test('进度 99.9% 不会被四舍五入成下载完成', async () => {
  const e = engine({ availability: () => 'downloadable', create: async ({ monitor }) => {
    monitor({ addEventListener(_name, callback) { callback({ loaded: .999 }); } });
    return { translate: async text => text };
  } });
  await e.instance.prepare('en');
  assert.ok(e.progress.some(message => message.includes('下载 99%')));
  assert.ok(!e.progress.some(message => message.includes('下载完成')));
  e.close();
});

test('模型状态检查和翻译推理都设置等待上限', async () => {
  const unavailable = engine({ availability: () => new Promise(() => {}), deadlines: { availability: 15 } });
  await assert.rejects(unavailable.instance.prepare('en'), error => error.code === 'AVAILABILITY_TIMEOUT');
  unavailable.close();
  const inference = engine({ create: async () => ({ translate: () => new Promise(() => {}) }), deadlines: { translation: 15 } });
  await inference.instance.prepare('en');
  await assert.rejects(inference.instance.translate('Hello'), error => error.code === 'TRANSLATION_TIMEOUT');
  assert.equal(inference.instance.cache.size, 0);
  inference.close();
});

test('取消准备会中断模型创建，迟到结果不会恢复已取消的状态', async () => {
  let signal, finishLate, destroyed = 0;
  const e = engine({ create: ({ signal: supplied }) => {
    signal = supplied;
    return new Promise(resolve => { finishLate = resolve; });
  } });
  const pending = e.instance.prepare('en');
  await until(() => signal !== undefined);
  e.instance.cancelPreparation();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.ok(signal.aborted);
  finishLate({ destroy() { destroyed++; } });
  await delay(0);
  assert.equal(e.instance.ready, false);
  assert.equal(destroyed, 1);
  e.close();
});

test('悬浮面板在初始化超时后退出等待，可再次准备', async () => {
  const p = page('<p>Hello</p>', translateMock, document => {
    document.defaultView.Translator = {
      availability: async () => 'downloadable',
      create: ({ monitor }) => {
        monitor({ addEventListener(_name, callback) { callback({ loaded: 1 }); } });
        return new Promise(() => {});
      }
    };
  }, window => {
    const Base = window.PageLocalTranslator;
    window.PageLocalTranslator = class extends Base { constructor(progress) { super(progress, { initialization: 20 }); } };
  });
  const response = p.request({ type: 'translator-prepare' });
  const panel = [...p.document.querySelectorAll('div')].find(node => node.shadowRoot).shadowRoot;
  assert.equal(panel.querySelector('.main').textContent, '取消准备');
  assert.equal((await response).code, 'MODEL_INIT_TIMEOUT');
  assert.equal(panel.querySelector('.main').textContent, '一键翻译');
  assert.ok(panel.querySelector('.status').textContent.includes('初始化超过 30 秒'));
  p.dom.window.Translator.create = async () => ({ translate: async () => '你好' });
  assert.equal((await p.request({ type: 'translator-prepare' })).ok, true);
  p.close();
});

test('读取偏好时取消准备，不会在迟到的偏好返回后开始下载', async () => {
  let resolveSettings, created = 0;
  const p = page('<p>Hello</p>', translateMock, document => {
    document.defaultView.Translator = { availability: async () => 'available', create: async () => { created++; return {}; } };
    document.defaultView.chrome.storage.local.get = defaults => 'sourceLanguage' in defaults ?
      new Promise(resolve => { resolveSettings = resolve; }) : Promise.resolve(defaults);
  });
  const response = p.request({ type: 'translator-prepare' });
  p.command('restore');
  resolveSettings({ sourceLanguage: 'en' });
  assert.equal((await response).code, 'CANCELLED');
  assert.equal(created, 0);
  p.close();
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}`); console.error(error); process.exitCode = 1; }
  }
  console.log(`${passed}/${tests.length} checks passed`);
})();
