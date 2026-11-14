const directory = new URL('./vendor/tesseract/', import.meta.url);
// Pin the mirror to a commit containing the exact packed assets below.
const mirrorDirectory = new URL('https://cdn.jsdmirror.com/gh/Kitsch27/ocarina-workshop@bee0b02f27d3ecda42a74089c8b58f2ab69137d4/vendor/tesseract/');
const downloaded = new Map();
const CACHE_NAME = 'ocarina-workshop-jianpu-v1';
const DOWNLOAD_IDLE_MS = 20000;
const MIRROR_IDLE_MS = 8000;
const INITIALIZE_MS = 15000;

class OcrLoadError extends Error {
  name = 'OcrLoadError';
}

async function download(url, expected, signal, onBytes, { retry = false, sha256 } = {}) {
  const attempt = new AbortController();
  const cancel = () => attempt.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  let timer;
  function restartTimer() {
    clearTimeout(timer);
    timer = setTimeout(() => attempt.abort(), sha256 ? MIRROR_IDLE_MS : DOWNLOAD_IDLE_MS);
  }
  try {
    signal.throwIfAborted();
    restartTimer();
    const response = await fetch(url, {
      signal: attempt.signal, cache: retry ? 'reload' : 'default',
      ...(sha256 ? { credentials: 'omit', referrerPolicy: 'no-referrer' } : {}),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected) throw new Error('Unexpected OCR asset size');
      chunks.push(value);
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
    if (sha256) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== sha256) throw new Error('Unexpected OCR asset hash');
    }
    attempt.signal.throwIfAborted();
    return bytes;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    attempt.abort();
  }
}

async function loadAssets(assets, signal, onProgress, preferMirror) {
  const sizes = new Map();
  const total = assets.reduce((sum, asset) => sum + asset.size, 0);
  const cache = await globalThis.caches?.open(CACHE_NAME).catch(() => undefined);
  const scope = new AbortController();
  const cancel = () => scope.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.all(assets.map(async asset => {
      const { name, size: expected, label, sha256 } = asset;
      const url = new URL(name, directory);
      const report = (size, status) => {
        sizes.set(name, size);
        const loaded = [...sizes.values()].reduce((sum, current) => sum + current, 0);
        const received = (loaded / 1024 / 1024).toFixed(1);
        onProgress(`${status}… 已接收 ${received} MB`,
          0.04 + 0.60 * Math.min(1, loaded / total));
      };
      let bytes = downloaded.get(name);
      if (!bytes) {
        const cached = await cache?.match(url).catch(() => undefined);
        const stored = await cached?.arrayBuffer().catch(() => undefined);
        if (stored?.byteLength === expected) bytes = new Uint8Array(stored);
      }
      scope.signal.throwIfAborted();
      if (bytes) {
        downloaded.set(name, bytes);
        report(bytes.length, '读取本机简谱组件缓存');
        return { bytes, source: '本机缓存' };
      }

      const useMirror = preferMirror && sha256 && globalThis.crypto?.subtle;
      const originStatus = preferMirror ? '原线路下载简谱组件' : '下载简谱组件';
      const attempts = [
        { url, source: '原线路', status: useMirror ? `镜像不可用，改用原线路下载${label}` : originStatus },
        { url, source: '原线路', status: `正在重试下载${label}`, retry: true },
      ];
      if (useMirror) {
        attempts.unshift({ url: new URL(name, mirrorDirectory), source: 'JSDMirror', status: 'JSDMirror 下载简谱组件', sha256 });
      }
      for (const attempt of attempts) {
        const { status, source } = attempt;
        report(0, status);
        try {
          bytes = await download(attempt.url, expected, scope.signal, size => report(size, status), attempt);
        } catch {
          scope.signal.throwIfAborted();
          continue;
        }
        downloaded.set(name, bytes);
        void cache?.put(url, new Response(bytes)).catch(() => {});
        report(bytes.length, status);
        return { bytes, source };
      }
      throw new OcrLoadError(label + '下载失败。请重试，网络不稳定时可用离线版。');
    }));
  } finally {
    scope.abort();
    signal.removeEventListener('abort', cancel);
  }
}

// These messages match the bundled Tesseract.js 5.1.1 worker.
export async function makeTextRecognizer(signal, onProgress, { preferMirror = false } = {}) {
  onProgress('正在下载简谱组件…', 0.04);
  const compressed = typeof DecompressionStream === 'function';
  const engine = compressed
    ? [{
      name: 'jianpu-worker-v1.js.gz', size: 1497046, label: '简谱识别引擎',
      sha256: '46226dac3bf440a0205035e1d96042ef588515e5a45baf0a449ff9545e5f5389',
    }]
    : [
      { name: 'tesseract-core-lstm.wasm.js', size: 3954464, label: '简谱识别引擎' },
      { name: 'worker.min.js', size: 111164, label: '简谱识别程序' },
    ];
  const assets = await loadAssets([
    {
      name: 'eng-jianpu-v1.traineddata.gz', size: 1336014, label: '简谱数字模型',
      sha256: '9010e1e4806828015fca1b59268029cea3e28f3c5807d2a24dffea8d232f95ab',
    },
    ...engine,
  ], signal, onProgress, preferMirror);
  const [model, ...scripts] = assets.map(asset => asset.bytes);
  signal.throwIfAborted();
  onProgress('正在初始化简谱识别引擎…', 0.68);
  const workerSource = compressed
    ? [await new Response(new Blob(scripts).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()]
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
    assetSources: [...new Set(assets.map(asset => asset.source))],
    terminate,
    setParameters: params => send('setParameters', { params }),
    async recognize(canvas, options = {}, output = { text: true }) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('无法读取简谱图像。');
      return send('recognize', { image: new Uint8Array(await blob.arrayBuffer()), options, output });
    },
  };
}
