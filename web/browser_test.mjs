/*
 * End-to-end browser test for the demo, dependency-free (CDP over the Node 22+
 * built-in WebSocket). Expects:
 *   - the static server running on $DEMO_PORT (default 8000)
 *   - headless chromium with --remote-debugging-port=$CDP_PORT (default 9222)
 *
 * Loads the page, selects the GTCRN model, clicks Enhance, and asserts the
 * pipeline reaches "done" with a non-black enhanced spectrogram. Writes a
 * screenshot to web/browser_test.png. Exit 0 on success.
 */
import { writeFileSync } from 'node:fs';

const DEMO_PORT = process.env.DEMO_PORT || '8000';
const CDP_PORT = process.env.CDP_PORT || '9222';
const URL = `http://localhost:${DEMO_PORT}/`;

async function newTab() {
  const ep = `http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(URL)}`;
  for (const method of ['PUT', 'GET']) {
    try {
      const r = await fetch(ep, { method });
      if (r.ok) return r.json();
    } catch (_) {}
  }
  throw new Error('could not open CDP tab');
}

const tab = await newTab();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const waiting = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
};
const send = (method, params = {}) => new Promise((res) => { const _id = ++id; waiting.set(_id, res); ws.send(JSON.stringify({ id: _id, method, params })); });
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + r.result.exceptionDetails.text);
  return r.result.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });

const deadline = Date.now() + 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for app.js (a deferred module, no top-level await) to finish: once the
// model <select> is populated the whole module has run, handlers included.
while (Date.now() < deadline) {
  if (await evalJs(`document.getElementById('model').options.length === 3`)) break;
  await sleep(200);
}

// Select GTCRN (smallest) and run.
await evalJs(`(() => { const s=document.getElementById('model'); s.value='gtcrn'; s.dispatchEvent(new Event('change')); document.getElementById('run').click(); return true; })()`);

let status = '';
while (Date.now() < deadline) {
  status = await evalJs(`document.getElementById('status').textContent`);
  if (status === 'done' || status.startsWith('error')) break;
  await sleep(500);
}

const perf = await evalJs(`document.getElementById('perf').textContent`);
const enhInk = await evalJs(`(() => {
  const c = document.getElementById('spec-enh');
  const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let sum = 0; for (let i = 0; i < x.length; i += 4) sum += x[i] + x[i+1] + x[i+2];
  return sum;
})()`);
const hasAudioSrc = await evalJs(`!!document.getElementById('player').src`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) writeFileSync('web/browser_test.png', Buffer.from(shot.result.data, 'base64'));

console.log('--- console ---');
for (const l of logs) console.log(l);
console.log('--- result ---');
console.log('status   :', status);
console.log('perf     :', perf);
console.log('enh ink  :', enhInk, '(spectrogram non-black sum)');
console.log('audio src:', hasAudioSrc);

ws.close();
const ok = status === 'done' && enhInk > 0 && hasAudioSrc;
console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
