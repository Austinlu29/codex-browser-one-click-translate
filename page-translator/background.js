/* Route requests to the top frame's local model. No cloud translation or fetch. */
const commands = new Map();
function validateTexts(texts) {
  return Array.isArray(texts) && texts.length <= 32 &&
    texts.every(text => typeof text === 'string' && text.trim() && text.length <= 30000);
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('无效的扩展来源');
  const tabId = sender.tab?.id ?? message.tabId;
  if (!Number.isInteger(tabId)) throw new Error('请先打开普通网页');
  if (message.type === 'translate-texts') {
    if (!validateTexts(message.texts)) throw new Error('翻译文本过长或格式错误');
    return await chrome.tabs.sendMessage(tabId, { type: 'translator-local-texts', texts: message.texts }, { frameId: 0 });
  }
  if (message.type === 'check-local-support') {
    return await chrome.tabs.sendMessage(tabId, { type: 'translator-capabilities' }, { frameId: 0 });
  }
  if (message.type === 'page-command') {
    if (!['translate', 'restore'].includes(message.command)) throw new Error('不支持的操作');
    const version = (commands.get(tabId) || 0) + 1;
    commands.set(tabId, version);
    if (message.command === 'translate') {
      const prepared = await chrome.tabs.sendMessage(tabId, { type: 'translator-prepare' }, { frameId: 0 });
      if (commands.get(tabId) !== version) return { ok: true, cancelled: true };
      if (!prepared?.ok) return prepared || { ok: false, error: '本地模型准备失败' };
    }
    await chrome.tabs.sendMessage(tabId, { type: 'translator-command', command: message.command });
    return { ok: true };
  }
  throw new Error('不支持的消息');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved?.addListener(tabId => commands.delete(tabId));
