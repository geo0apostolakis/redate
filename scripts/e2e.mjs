// Drive the built site in headless Chrome over CDP: open a .docx or .pdf, set
// one date for all, save the result(s), and take screenshots.
//   node scripts/e2e.mjs URL FILE.docx|FILE.pdf YYYY-MM-DD OUTDIR
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [url, fileArg, iso, out] = process.argv.slice(2);
const file = resolve(fileArg);
await mkdir(out, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333;
const profile = join(tmpdir(), `e2e-profile-${process.pid}`);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

let ws;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (msg.method === 'Log.entryAdded') logs.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
    if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  const waitFor = async (expr, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) { if (await js(expr)) return; await sleep(100); }
    throw new Error(`timed out waiting for ${expr}`);
  };
  const shot = async (name, full = true) => {
    const { contentSize } = await send('Page.getLayoutMetrics');
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, clip: full ? { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 } : undefined });
    await writeFile(join(out, `${name}.png`), Buffer.from(r.data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Log.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: out, eventsEnabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete' && document.fonts.status === 'loaded'`);
  await shot('1-start');

  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await waitFor(`document.querySelectorAll('.row').length > 0 || !document.getElementById('message').hidden && !document.getElementById('message').textContent.startsWith('Άνοιγμα')`);
  if (!(await js(`document.querySelectorAll('.row').length`))) {
    console.log('message:', await js(`document.getElementById('message').textContent`));
    await shot('2-message');
    process.exitCode = 0;
    throw Object.assign(new Error('no dates'), { quiet: true });
  }
  console.log('found:', await js(`[...document.querySelectorAll('.row')].map(r => r.querySelector('.row-where').textContent + ' | ' + r.querySelector('mark').textContent)`));
  await waitFor(`document.getElementById('step-preview').hidden || document.querySelectorAll('.page canvas').length > 0`);
  await sleep(500);
  await shot('2-loaded');

  await js(`(() => { const d = document.getElementById('all-date'); d.value = '${iso}'; document.getElementById('all-apply').click(); })()`);
  await sleep(800);
  console.log('new texts:', await js(`[...document.querySelectorAll('.result')].map(i => i.value)`));
  console.log('summary:', await js(`document.getElementById('summary').textContent`));
  await shot('3-changed');

  await sleep(1500);
  await shot('3-preview');
  if (await js(`!document.getElementById('save-docx').hidden`)) {
    await js(`document.getElementById('save-docx').click()`);
    await waitFor(`document.getElementById('message').textContent.includes('.docx')`);
  }
  if (await js(`!document.getElementById('save-pdf').hidden`)) {
    await js(`document.getElementById('save-pdf').click()`);
    await waitFor(`document.getElementById('message').textContent.includes('.pdf')`, 60000);
  }
  for (let i = 0; i < 50; i++) {
    const files = await readdir(out);
    if (!files.some((f) => f.endsWith('.crdownload'))) break;
    await sleep(200);
  }
  console.log('downloads:', (await readdir(out)).filter((f) => !f.endsWith('.png')));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  console.log('page wider than phone:', await js(`document.documentElement.scrollWidth > window.innerWidth`));
  await shot('4-phone');
  if (logs.length) console.log('console:', logs);
} catch (e) {
  if (!e.quiet) throw e;
} finally {
  ws?.close();
  chrome.kill();
}
