const status = document.querySelector('#status');
const translateButton = document.querySelector('#translate');
const restoreButton = document.querySelector('#restore');
const floating = document.querySelector('#floating');
const source = document.querySelector('#source');
const target = document.querySelector('#target');
const swap = document.querySelector('#swap');
const direction = document.querySelector('#direction');
const languages = globalThis.PageLanguages;
languages.fill(source, true);
languages.fill(target);
let preferences = { sourceLanguage: 'en', targetLanguage: 'zh' };
let saving = false;
function showSettings(settings) {
  preferences = languages.settings(settings);
  source.value = preferences.sourceLanguage;
  target.value = preferences.targetLanguage;
  swap.disabled = saving || source.value === 'auto';
  direction.textContent = `${languages.label(source.value)} → ${languages.label(target.value)}`;
}
showSettings(preferences);

const settingsReady = chrome.storage.local.get({ floating: true, sourceLanguage: 'en', targetLanguage: 'zh' })
  .then(settings => { floating.checked = settings.floating; showSettings(settings); })
  .catch(error => { status.textContent = error.message; });
async function saveLanguages(from, to) {
  saving = true;
  translateButton.disabled = source.disabled = target.disabled = swap.disabled = true;
  try {
    await chrome.storage.local.set({ sourceLanguage: from, targetLanguage: to });
    showSettings({ sourceLanguage: from, targetLanguage: to });
    status.textContent = '语言设置已保存，请点击翻译；已翻译的页面会先恢复原文。';
  } catch (error) { showSettings(preferences); status.textContent = error.message; }
  finally { saving = false; translateButton.disabled = source.disabled = target.disabled = false; swap.disabled = source.value === 'auto'; }
}
source.addEventListener('change', () => void saveLanguages(source.value, target.value));
target.addEventListener('change', () => void saveLanguages(source.value, target.value));
swap.addEventListener('click', () => void saveLanguages(target.value, source.value));
chrome.storage.onChanged.addListener(changes => {
  if (changes.sourceLanguage || changes.targetLanguage) showSettings({ ...preferences,
    ...(changes.sourceLanguage ? { sourceLanguage: changes.sourceLanguage.newValue } : {}),
    ...(changes.targetLanguage ? { targetLanguage: changes.targetLanguage.newValue } : {}) });
});
floating.addEventListener('change', () => chrome.storage.local.set({ floating: floating.checked }));

async function run(command) {
  translateButton.disabled = restoreButton.disabled = true;
  status.textContent = '';
  try {
    await settingsReady;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('请先打开需要翻译的网页');
    const response = await chrome.runtime.sendMessage({ type: 'page-command', command, tabId: tab.id });
    if (!response?.ok) throw new Error(response?.error || '网页没有响应');
    status.textContent = command === 'translate' ? '翻译已启动，可在网页中查看进度。' : '已恢复原文。';
  } catch (error) {
    status.textContent = error.message;
    status.title = error.message;
  } finally { translateButton.disabled = restoreButton.disabled = false; }
}
translateButton.addEventListener('click', () => void run('translate'));
restoreButton.addEventListener('click', () => void run('restore'));
