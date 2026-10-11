const status = document.querySelector('#status');
const translateButton = document.querySelector('#translate');
const restoreButton = document.querySelector('#restore');
const floating = document.querySelector('#floating');
const source = document.querySelector('#source');

chrome.storage.local.get({ floating: true }).then(settings => { floating.checked = settings.floating; });
chrome.storage.local.get({ sourceLanguage: 'auto' }).then(settings => { source.value = settings.sourceLanguage; });
source.addEventListener('change', () => chrome.storage.local.set({ sourceLanguage: source.value }));
floating.addEventListener('change', () => chrome.storage.local.set({ floating: floating.checked }));

async function run(command) {
  translateButton.disabled = restoreButton.disabled = true;
  status.textContent = '';
  try {
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
