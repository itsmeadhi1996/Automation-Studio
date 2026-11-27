// The recording window. On a Studio server without a screen the recording browser runs hidden;
// Record Web opens this window to show it and to send clicks, scrolling and keys back to it.
(() => {
  const STATUS_MS = 1000;
  const FRAME_MS = 350;
  const MOVE_MS = 200;
  // A streamed view that has shown no frame by then falls back to asking for one frame at a time,
  // for example behind a proxy that holds back streamed responses.
  const STREAM_WAIT_MS = 5000;
  // Without a recording by then, Record Web did not start one for this window.
  const START_WAIT_MS = 120000;
  const CLOSE_AFTER_STOP_MS = 1500;
  const CLICK_MARK_MS = 700;
  const MAX_TEXT = 1000;
  const MAX_SCROLL = 5000;
  const KEYS = {
    Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  };

  const viewer = document.getElementById('remote-screen');
  const figure = viewer.closest('figure');
  const frame = viewer.parentElement;
  const status = document.getElementById('live-status');
  const title = document.getElementById('live-title');
  const openedAt = Date.now();

  let recording = null;
  let streaming = false;
  let frameLoop = null;
  let streamCheck = null;
  let loadingFrame = false;
  let movedAt = 0;
  let sending = false;
  const queue = [];

  const setStatus = (message) => {
    status.textContent = message;
  };

  /* ---------- Frames ---------- */

  const screenUrl = () => `/api/recordings/${encodeURIComponent(recording.id)}/screen?frame=${Date.now()}`;

  // Frames load as same-origin images (the CSP allows no blob: URLs); a frame replaces the shown
  // one only after it has loaded, so the view never flickers to empty.
  function refreshFrame() {
    if (!recording || streaming || loadingFrame) return;
    const url = screenUrl();
    loadingFrame = true;
    const next = new Image();
    next.onload = next.onerror = () => {
      loadingFrame = false;
      if (next.naturalWidth && recording && !streaming) viewer.src = url;
    };
    next.src = url;
  }

  function useFrames() {
    streaming = false;
    clearTimeout(streamCheck);
    viewer.removeAttribute('src');
    refreshFrame();
    frameLoop ??= setInterval(refreshFrame, FRAME_MS);
  }

  function useStream() {
    streaming = true;
    viewer.src = `/api/recordings/${encodeURIComponent(recording.id)}/stream`;
    streamCheck = setTimeout(() => {
      if (streaming && !viewer.naturalWidth) useFrames();
    }, STREAM_WAIT_MS);
  }

  viewer.addEventListener('error', () => {
    if (streaming) useFrames();
  });

  /* ---------- Input ---------- */

  // Inputs go to the server one at a time and in order. Over a slow connection a queue of pointer
  // moves would hold a click or key back for seconds, so a move is sent only when nothing waits,
  // and typed text and scrolling that pile up are merged into one request.
  function send(event) {
    if (!recording) return;
    const last = queue.at(-1);
    if (event.type === 'move' && (sending || queue.length)) return;
    if (event.type === 'text' && last?.type === 'text' && last.text.length + event.text.length <= MAX_TEXT) {
      last.text += event.text;
      return;
    }
    if (event.type === 'scroll' && last?.type === 'scroll') {
      const clamp = (value) => Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, value));
      last.dx = clamp(last.dx + event.dx);
      last.dy = clamp(last.dy + event.dy);
      return;
    }
    queue.push({ ...event, recording: recording.id });
    void drain();
  }

  async function post(id, event) {
    const response = await fetch(`/api/recordings/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'The recording browser did not accept the input');
    }
  }

  async function drain() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) {
        const { recording: id, ...event } = queue.shift();
        try {
          await post(id, event);
        } catch (error) {
          queue.length = 0;
          setStatus(error.message);
        }
      }
    } finally {
      sending = false;
    }
    refreshFrame();
  }

  function point(event) {
    if (!recording) return {};
    const box = viewer.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - box.left) / box.width) * recording.remote.width),
      y: Math.round(((event.clientY - box.top) / box.height) * recording.remote.height),
    };
  }

  // Shows the click at once, before the frame that shows its effect arrives.
  function markClick(event) {
    const box = viewer.getBoundingClientRect();
    const mark = document.createElement('span');
    mark.className = 'click-mark';
    mark.style.left = `${event.clientX - box.left}px`;
    mark.style.top = `${event.clientY - box.top}px`;
    frame.append(mark);
    setTimeout(() => mark.remove(), CLICK_MARK_MS);
  }

  viewer.addEventListener('click', (event) => {
    viewer.focus();
    markClick(event);
    send({ type: 'click', ...point(event) });
  });
  viewer.addEventListener('dblclick', (event) => {
    send({ type: 'click', clickCount: 2, ...point(event) });
  });
  viewer.addEventListener('mousemove', (event) => {
    if (Date.now() - movedAt < MOVE_MS) return;
    movedAt = Date.now();
    send({ type: 'move', ...point(event) });
  });
  viewer.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      send({ type: 'scroll', dx: event.deltaX, dy: event.deltaY });
    },
    { passive: false },
  );
  viewer.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    let key = KEYS[event.key];
    if (event.key === 'Tab' && event.shiftKey) key = 'Shift+Tab';
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') key = event.metaKey ? 'Meta+a' : 'Control+a';
    if (key) {
      event.preventDefault();
      send({ type: 'key', key });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      send({ type: 'text', text: event.key });
    }
  });
  viewer.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') || '';
    if (!text) return;
    event.preventDefault();
    send({ type: 'text', text: text.slice(0, MAX_TEXT) });
  });

  /* ---------- Recorder controls ---------- */

  const tools = document.getElementById('live-tools');
  const pauseButton = document.getElementById('live-pause');
  const lastStep = document.getElementById('live-last');
  let commandBusy = false;

  function showControls(active) {
    tools.hidden = false;
    for (const button of tools.querySelectorAll('[data-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === (active.mode || 'actions')));
    }
    const paused = active.status === 'paused';
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.dataset.command = paused ? 'resume' : 'pause';
    const last = active.steps.at(-1);
    lastStep.textContent = last ? `Last step: ${last.name}` : '';
  }

  // Modes and commands go through Studio's recording API, as the Record Web page sends them.
  async function command(path, body = {}) {
    if (!recording || commandBusy) return;
    commandBusy = true;
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(recording.id)}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Studio did not accept the command');
      if (result.status === 'stopped') finish('Recording stopped. This window closes now.');
      else if (recording) {
        recording = result;
        showControls(result);
      }
    } catch (error) {
      setStatus(error.message);
    } finally {
      commandBusy = false;
      viewer.focus({ preventScroll: true });
    }
  }

  tools.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.mode) void command('mode', { mode: button.dataset.mode });
    else if (button.dataset.command) void command(button.dataset.command);
  });

  /* ---------- Recording state ---------- */

  function attach(active) {
    recording = active;
    viewer.setAttribute('width', active.remote.width);
    viewer.setAttribute('height', active.remote.height);
    viewer.dataset.recording = active.id;
    figure.hidden = false;
    if (active.remote.stream) useStream();
    else useFrames();
    viewer.focus({ preventScroll: true });
  }

  function finish(message) {
    recording = null;
    streaming = false;
    clearInterval(frameLoop);
    clearTimeout(streamCheck);
    viewer.removeAttribute('src');
    figure.hidden = true;
    tools.hidden = true;
    document.body.classList.add('stopped');
    setStatus(message);
    setTimeout(() => window.close(), CLOSE_AFTER_STOP_MS);
  }

  async function poll() {
    let data;
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (response.status === 401) {
        finish('Your session ended. Sign in to Studio again.');
        return;
      }
      data = await response.json();
    } catch {
      setStatus('Cannot reach Studio. Retrying…');
      setTimeout(poll, STATUS_MS);
      return;
    }
    const active = data.activeRecording;
    const isLive = active?.remote && active.status !== 'stopped';
    if (!isLive) {
      if (recording) return finish('Recording stopped. This window closes now.');
      if (active && !active.remote) return finish('This recording uses its own browser window. This window closes now.');
      if (Date.now() - openedAt > START_WAIT_MS) return finish('No recording started. This window closes now.');
    } else {
      if (recording?.id !== active.id) attach(active);
      recording = active;
      showControls(active);
      title.textContent = `Recording: ${active.testName}`;
      document.title = `Recording: ${active.testName}`;
      const paused = active.status === 'paused' ? ' · paused' : '';
      setStatus(`${active.browser}${paused} · ${active.steps.length} steps saved`);
    }
    setTimeout(poll, STATUS_MS);
  }

  void poll();
})();
