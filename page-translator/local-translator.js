/* Browser-provided models only. This module never sends text to a cloud service. */
(() => {
  const supported = new Set(globalThis.PageLanguages.entries.map(([code]) => code));
  const { normalize, label } = globalThis.PageLanguages;
  class LocalTranslationError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }
  function withDeadline(factory, milliseconds, timeoutError, hooks = {}) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) {
          if (!error) { try { hooks.onLate?.(value); } catch {} }
          return;
        }
        settled = true;
        clearTimeout(timer);
        hooks.unregister?.(cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = error => {
        if (settled) return;
        finish(error);
        controller.abort(error);
      };
      const arm = (duration, error) => {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(() => cancel(error), duration);
      };
      hooks.register?.(cancel);
      arm(milliseconds, timeoutError);
      try {
        Promise.resolve(factory({ signal: controller.signal, arm, active: () => !settled }))
          .then(value => finish(null, value), error => finish(error));
      } catch (error) { finish(error); }
    });
  }
  class PageLocalTranslator {
    constructor(onProgress = () => {}, deadlines = {}) {
      this.onProgress = onProgress;
      this.translators = new Map();
      this.cache = new Map();
      this.needed = new Set();
      this.detector = null;
      this.detectorPromise = null;
      this.source = 'en';
      this.target = 'zh';
      this.hint = normalize(document.documentElement.lang);
      if (this.hint === 'zh') this.hint = 'en';
      this.ready = false;
      this.deadlines = { availability: 10000, download: 120000, initialization: 30000,
        detectorCreation: 10000, detection: 1500, translation: 30000, ...deadlines };
      this.preparationCancels = new Set();
      this.prepareVersion = 0;
    }
    capabilities() {
      return { translator: typeof globalThis.Translator !== 'undefined',
        languageDetector: typeof globalThis.LanguageDetector !== 'undefined', secureContext: globalThis.isSecureContext };
    }
    timed(factory, milliseconds, error, preparation = false, onLate) {
      return withDeadline(factory, milliseconds, error, {
        onLate,
        register: preparation ? cancel => this.preparationCancels.add(cancel) : undefined,
        unregister: preparation ? cancel => this.preparationCancels.delete(cancel) : undefined
      });
    }
    cancelPreparation() {
      this.prepareVersion++;
      this.ready = false;
      const error = new LocalTranslationError('已取消模型准备，可以重新点击翻译', 'CANCELLED');
      for (const cancel of [...this.preparationCancels]) cancel(error);
    }
    startDetector() {
      if (!this.capabilities().languageDetector || this.detector || this.detectorPromise) return;
      const task = this.timed(({ signal, active }) => globalThis.LanguageDetector.create({
        signal,
        monitor: monitor => monitor.addEventListener('downloadprogress', event => {
          // Optional detection must not replace the translator's preparation status.
          if (active() && !this.translators.size && !this.ready) {
            this.onProgress(`语言检测模型下载 ${Math.min(99, Math.floor(event.loaded * 100))}%`);
          }
        })
      }), this.deadlines.detectorCreation,
      new LocalTranslationError('语言检测未就绪，先按网页原文语言翻译', 'DETECTOR_TIMEOUT'), true,
      detector => detector.destroy?.())
        .then(detector => { this.detector = detector; })
        .catch(() => { this.detector = null; })
        .finally(() => { if (this.detectorPromise === task) this.detectorPromise = null; });
      this.detectorPromise = task;
    }
    createModel(source, available, options) {
      let initializing = available === 'available';
      const pairLabel = `${label(source)} → ${label(options.targetLanguage)}`;
      const initError = new LocalTranslationError(`${pairLabel}模型下载完成，但初始化超过 30 秒。请重试；仍失败时重启内置浏览器`, 'MODEL_INIT_TIMEOUT');
      this.onProgress(initializing ? `${pairLabel}模型正在初始化…` : `正在准备 ${pairLabel}本地模型…`);
      return this.timed(({ signal, arm, active }) => globalThis.Translator.create({
        ...options, signal,
        monitor: monitor => monitor.addEventListener('downloadprogress', event => {
          if (!active()) return;
          if (event.loaded >= 1) {
            if (!initializing) { initializing = true; arm(this.deadlines.initialization, initError); }
            this.onProgress(`${pairLabel}模型下载完成，正在初始化…`);
          } else if (!initializing) {
            this.onProgress(`${pairLabel}模型下载 ${Math.max(0, Math.min(99, Math.floor(event.loaded * 100)))}%`);
          }
        })
      }), initializing ? this.deadlines.initialization : this.deadlines.download,
      initializing ? initError : new LocalTranslationError(`${pairLabel}模型准备超过 2 分钟，请检查模型下载网络后重试`, 'MODEL_DOWNLOAD_TIMEOUT'),
      true, translator => translator.destroy?.());
    }
    async pair(source, allowDownload, target = this.target) {
      if (source === target) return null;
      const key = source + '\u0000' + target;
      const pairLabel = `${label(source)} → ${label(target)}`;
      if (this.translators.has(key)) return this.translators.get(key);
      const promise = (async () => {
        const options = { sourceLanguage: source, targetLanguage: target };
        const available = await this.timed(() => globalThis.Translator.availability(options), this.deadlines.availability,
          new LocalTranslationError('检查本地模型状态超时，请重试', 'AVAILABILITY_TIMEOUT'), allowDownload);
        if (available === 'unavailable') throw new LocalTranslationError(`浏览器不支持 ${pairLabel}本地翻译，请选择其他语言组合`, 'UNSUPPORTED_PAIR');
        if (available !== 'available' && !allowDownload) {
          this.needed.add(key);
          throw new LocalTranslationError(`需要下载 ${pairLabel}模型，请再次点击网页上的“一键翻译”`, 'MODEL_REQUIRED');
        }
        try {
          const translator = await this.createModel(source, available, options);
          this.needed.delete(key);
          return translator;
        } catch (error) {
          if (error instanceof LocalTranslationError) throw error;
          if (error.name === 'NotAllowedError') {
            this.needed.add(key);
            throw new LocalTranslationError('请直接点击网页左下角“一键翻译”，授权浏览器下载本地模型', 'MODEL_REQUIRED');
          }
          throw new LocalTranslationError(`本地模型加载失败：${error.message}`, 'MODEL_FAILED');
        }
      })();
      this.translators.set(key, promise);
      promise.catch(() => { if (this.translators.get(key) === promise) this.translators.delete(key); });
      return promise;
    }
    async prepare(source = 'en', target = 'zh') {
      this.ready = false;
      if (!this.capabilities().translator) {
        throw new LocalTranslationError('当前浏览器未提供本地翻译 API，无法使用本地模式', 'UNSUPPORTED_BROWSER');
      }
      this.source = source === 'auto' ? 'auto' : normalize(source);
      this.target = normalize(target, 'zh');
      const selectedTarget = this.target;
      const version = ++this.prepareVersion;
      this.hint = normalize(document.documentElement.lang);
      // Detection is optional: prepare it in parallel without waiting for it to finish.
      if (this.source === 'auto') this.startDetector();
      const needed = [...this.needed].map(key => key.split('\u0000')).filter(([, to]) => to === selectedTarget).map(([from]) => from);
      const sources = this.source === 'auto' ? new Set([this.hint, ...needed]) : new Set([this.source]);
      await Promise.all([...sources].map(language => this.pair(language, true, selectedTarget)));
      if (version !== this.prepareVersion) throw new LocalTranslationError('模型准备已取消', 'CANCELLED');
      this.ready = true;
      this.onProgress(this.source === 'auto' && !this.detector ? `本地模型已就绪，先按 ${label(this.hint)} → ${label(selectedTarget)} 翻译` : `${label(this.source)} → ${label(selectedTarget)} · 本地模型已就绪`);
      return { ok: true, source: this.source, target: selectedTarget };
    }
    async language(text) {
      if (this.source !== 'auto') return this.source;
      if (!this.detector || text.trim().length < 12) return this.hint;
      try {
        const [best] = await this.timed(({ signal }) => this.detector.detect(text, { signal }), this.deadlines.detection,
          new LocalTranslationError('语言检测超时', 'DETECTION_TIMEOUT'));
        return best?.confidence >= 0.65 && supported.has(best.detectedLanguage) ? best.detectedLanguage : this.hint;
      } catch { return this.hint; }
    }
    async translate(text) {
      if (!this.ready) throw new LocalTranslationError('请先点击网页上的“一键翻译”准备本地模型', 'MODEL_REQUIRED');
      const version = this.prepareVersion;
      const target = this.target;
      const source = await this.language(text);
      if (version !== this.prepareVersion) throw new LocalTranslationError('语言设置已改变，请重新翻译', 'CANCELLED');
      const key = source + '\u0000' + target + '\u0000' + text;
      if (this.cache.has(key)) return this.cache.get(key);
      const promise = (async () => {
        if (source === target) return text;
        const translator = await this.pair(source, false, target);
        const result = await this.timed(({ signal }) => translator.translate(text, { signal }), this.deadlines.translation,
          new LocalTranslationError('本地翻译超过 30 秒，请重试或指定原文语言', 'TRANSLATION_TIMEOUT'));
        if (typeof result !== 'string' || !result.trim()) throw new Error('本地模型未返回译文');
        return result;
      })();
      this.cache.set(key, promise);
      if (this.cache.size > 1200) this.cache.delete(this.cache.keys().next().value);
      promise.catch(() => { if (this.cache.get(key) === promise) this.cache.delete(key); });
      return promise;
    }
  }
  globalThis.PageLocalTranslator = PageLocalTranslator;
})();
