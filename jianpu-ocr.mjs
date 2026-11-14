const directory = new URL('./vendor/tesseract/', import.meta.url);
const downloaded = new Map();
const CACHE_NAME = 'ocarina-workshop-jianpu-v1';
const DOWNLOAD_IDLE_MS = 20000;
const INITIALIZE_MS = 15000;
const GZIP_WORKER = { name: 'jianpu-worker-v1.js.gz', size: 1497046, label: '简谱识别引擎' };
const BROTLI_WORKER = { name: 'jianpu-worker-v1.js.br', size: 1153339, label: '简谱识别引擎' };
let assetLoad;

class OcrLoadError extends Error {
  name = 'OcrLoadError';
}

async function readCached({ name, size }, cache, signal) {
  signal.throwIfAborted();
  if (downloaded.has(name)) return downloaded.get(name);
  const cached = await cache?.match(new URL(name, directory)).catch(() => undefined);
  const bytes = await cached?.arrayBuffer().catch(() => undefined);
  signal.throwIfAborted();
  if (bytes?.byteLength !== size) return undefined;
  const result = new Uint8Array(bytes);
  downloaded.set(name, result);
  return result;
}

async function download({ name, size: expected }, cache, signal, onBytes, retry = false) {
  const url = new URL(name, directory);
  const attempt = new AbortController();
  const cancel = () => attempt.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  let timer;
  function restartTimer() {
    clearTimeout(timer);
    timer = setTimeout(() => attempt.abort(), DOWNLOAD_IDLE_MS);
  }
  try {
    signal.throwIfAborted();
    restartTimer();
    const response = await fetch(url, { signal: attempt.signal, cache: retry ? 'reload' : 'default' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      onBytes(size);
      restartTimer();
    }
    if (size !== expected) throw new Error('Incomplete OCR asset');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    downloaded.set(name, bytes);
    void cache?.put(url, new Response(bytes)).catch(() => {});
    return bytes;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

async function loadAssets(assets, cache, signal, onProgress) {
  const sizes = new Map();
  const total = assets.reduce((sum, asset) => sum + asset.size, 0);
  const scope = new AbortController();
  const cancel = () => scope.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  const retryingFiles = new Set();
  try {
    signal.throwIfAborted();
    return await Promise.all(assets.map(async asset => {
      const { name, label } = asset;
      const report = size => {
        sizes.set(name, size);
        const loaded = [...sizes.values()].reduce((sum, current) => sum + current, 0);
        const received = (loaded / 1000000).toFixed(1);
        const message = retryingFiles.size
          ? '正在重试下载' + [...retryingFiles].join('、') + '…'
          : '下载简谱组件… 已接收 ' + received + ' MB';
        onProgress(message,
          0.04 + 0.60 * Math.min(1, loaded / total));
      };
      let bytes = await readCached(asset, cache, scope.signal);
      if (bytes) {
        report(bytes.length);
        return bytes;
      }
      try {
        bytes = await download(asset, cache, scope.signal, report);
      } catch {
        scope.signal.throwIfAborted();
        retryingFiles.add(label);
        report(0);
        try {
          bytes = await download(asset, cache, scope.signal, size => {
            retryingFiles.delete(label);
            report(size);
          }, true);
        } catch {
          scope.signal.throwIfAborted();
          throw new OcrLoadError(label + '下载失败。请重试，网络不稳定时可用离线版。');
        }
      }
      report(bytes.length);
      return bytes;
    }));
  } finally {
    scope.abort();
    signal.removeEventListener('abort', cancel);
  }
}

async function loadRecognizerAssets(signal, progress) {
  const cache = await globalThis.caches?.open(CACHE_NAME).catch(() => undefined);
  signal.throwIfAborted();
  let format = null;
  if (typeof DecompressionStream === 'function') {
    format = 'gzip';
    try {
      new DecompressionStream('brotli');
      // Reuse an engine downloaded by the previous release.
      if (!(await readCached(GZIP_WORKER, cache, signal))) format = 'brotli';
    } catch {
      signal.throwIfAborted();
    }
  }
  let engine = [
    { name: 'tesseract-core-lstm.wasm.js', size: 3954464, label: '简谱识别引擎' },
    { name: 'worker.min.js', size: 111164, label: '简谱识别程序' },
  ];
  if (format) engine = [format === 'brotli' ? BROTLI_WORKER : GZIP_WORKER];
  const [model, ...scripts] = await loadAssets([
    { name: 'eng-jianpu-v1.traineddata.gz', size: 1336014, label: '简谱数字模型' },
    ...engine,
  ], cache, signal, progress);
  return { model, scripts, format };
}

// A conversion can join a download already started by the simplified-score selector.
export function prepareTextRecognizer(signal, onProgress = () => {}) {
  signal.throwIfAborted();
  if (!assetLoad) {
    const load = { controller: new AbortController(), listeners: new Set(), progress: ['正在下载简谱组件…', 0.04] };
    assetLoad = load;
    load.promise = loadRecognizerAssets(load.controller.signal, (...progress) => {
      load.progress = progress;
      for (const notify of load.listeners) notify(...progress);
    }).finally(() => {
      if (assetLoad === load) assetLoad = null;
    });
  }
  const load = assetLoad;
  const notify = (...progress) => onProgress(...progress);
  load.listeners.add(notify);
  return new Promise((resolve, reject) => {
    function cleanup() {
      signal.removeEventListener('abort', cancel);
      load.listeners.delete(notify);
    }
    function cancel() {
      cleanup();
      if (!load.listeners.size && assetLoad === load) {
        assetLoad = null;
        load.controller.abort(signal.reason);
      }
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
    load.promise.then(result => { cleanup(); resolve(result); }, error => { cleanup(); reject(error); });
    notify(...load.progress);
  });
}

// These messages match the bundled Tesseract.js 5.1.1 worker.
export async function makeTextRecognizer(signal, onProgress) {
  const { model, scripts, format } = await prepareTextRecognizer(signal, onProgress);
  signal.throwIfAborted();
  onProgress('正在初始化简谱识别引擎…', 0.68);
  const workerSource = format
    ? [await new Response(new Blob(scripts).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer()]
    : [scripts[0], '\n;\n', scripts[1]];
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob(workerSource, { type: 'text/javascript' }));
  let worker;
  try {
    worker = new Worker(url);
  } catch {
    throw new OcrLoadError('当前浏览器无法启动简谱识别引擎。请换浏览器重试。');
  } finally {
    URL.revokeObjectURL(url);
  }
  let sequence = 0;
  let pending;
  const rejectPending = error => {
    pending?.reject(error);
    pending = null;
  };
  function terminate() {
    worker.terminate();
    rejectPending(signal.reason ?? new Error('简谱识别已结束。'));
    signal.removeEventListener('abort', terminate);
    return Promise.resolve();
  }
  signal.addEventListener('abort', terminate, { once: true });
  worker.onerror = () => rejectPending(new OcrLoadError('简谱识别引擎启动失败。请重试或使用离线版。'));
  worker.onmessage = ({ data }) => {
    if (!pending || data.jobId !== pending.id) return;
    if (data.status === 'progress') {
      if (data.data.status === 'recognizing text') onProgress('正在读取简谱数字…', 0.78 + 0.19 * data.data.progress);
      return;
    }
    if (data.status === 'resolve') {
      pending.resolve({ data: data.data });
      pending = null;
    } else rejectPending(new Error('简谱识别组件处理失败。请重试或使用离线版。'));
  };
  function send(action, payload) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      pending = { id, resolve, reject };
      worker.postMessage({ workerId: 'jianpu', jobId: id, action, payload });
    });
  }

  const timer = setTimeout(() => rejectPending(new OcrLoadError('简谱识别引擎初始化超时。请重试或使用离线版。')), INITIALIZE_MS);
  try {
    await send('load', { options: { lstmOnly: true } });
    await send('loadLanguage', { langs: [{ code: 'eng', data: model }], options: { cacheMethod: 'none' } });
    await send('initialize', { langs: 'eng', oem: 1 });
  } catch (error) {
    await terminate();
    signal.throwIfAborted();
    throw error instanceof OcrLoadError ? error : new OcrLoadError('简谱识别引擎初始化失败。请重试或使用离线版。');
  } finally {
    clearTimeout(timer);
  }
  return {
    terminate,
    setParameters: params => send('setParameters', { params }),
    async recognize(canvas, options = {}, output = { text: true }) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('无法读取简谱图像。');
      return send('recognize', { image: new Uint8Array(await blob.arrayBuffer()), options, output });
    },
  };
}
