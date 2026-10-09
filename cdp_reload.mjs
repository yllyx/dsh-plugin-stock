import fs from 'fs';
const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const target = list.find(t => t.url.includes('43120'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 10;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = ++mid;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === i) { ws.removeEventListener('message', h); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
await new Promise(r => { ws.onopen = r; });
// 硬重载（绕缓存）
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
console.log('page reloading (ignoreCache)...');
await new Promise(r => setTimeout(r, 15000));
// 页面上下文拉指数卡（新 JS 逻辑同款请求）
const r1 = await send('Runtime.evaluate', {
  expression: `fetch('http://127.0.0.1:8765/api/kpl/index-cards').then(r=>r.json()).then(d=>JSON.stringify((d.cards||[]).map(c=>c.name+' '+c.price+' '+(c.incRate>0?'+':'')+c.incRate+'%'))).catch(e=>'ERR:'+e.message)`,
  awaitPromise: true, returnByValue: true, userGesture: true,
});
console.log('index-cards from page:', JSON.stringify(r1.result?.value || r1));
// 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('E:/zcode-projects/kanpan_spec/shots/final_after_reload.png', Buffer.from(shot.data, 'base64'));
console.log('final screenshot saved');
process.exit(0);
