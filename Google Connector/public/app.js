async function getJSON(url, opts){
  const res = await fetch(url, opts);
  if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json().catch(()=>({}));
}

function setConn(connected){
  const pill = document.getElementById('conn-pill');
  if(pill){
    pill.classList.remove('ok','err');
    if(connected){ pill.textContent = 'connected'; pill.classList.add('ok'); }
    else { pill.textContent = 'not connected'; pill.classList.add('err'); }
  }
  const simple = document.getElementById('simple-status');
  if(simple){
    simple.classList.remove('ok','err');
    if(connected){ simple.textContent = 'CONNECTED'; simple.classList.add('ok'); }
    else { simple.textContent = 'NOT CONNECTED'; simple.classList.add('err'); }
  }
}

async function refreshStatus(){
  try{
    const data = await getJSON('/api/status');
    setConn(data.connected);
    const p = document.getElementById('profile');
    if(p){
      p.innerHTML = '';
      if(data.profile){
        const { emailAddress, historyId, messagesTotal, threadsTotal } = data.profile;
        if(emailAddress) p.innerHTML += `<div><strong>Email:</strong> ${emailAddress}</div>`;
        if(historyId) p.innerHTML += `<div><strong>HistoryId:</strong> ${historyId}</div>`;
        if(messagesTotal!=null) p.innerHTML += `<div><strong>Messages:</strong> ${messagesTotal}</div>`;
        if(threadsTotal!=null) p.innerHTML += `<div><strong>Threads:</strong> ${threadsTotal}</div>`;
      }
    }
  }catch(e){
    setConn(false);
  }
}

async function startWatch(){
  const log = document.getElementById('watch-log');
  log.textContent = 'Starting watch…';
  try{
    const res = await getJSON('/watch/start', { method:'POST' });
    log.textContent = JSON.stringify(res, null, 2);
  }catch(e){
    log.textContent = `Failed: ${e.message}. Did you set GMAIL_TOPIC in .env?`;
  }
}

async function stopWatch(){
  const log = document.getElementById('watch-log');
  log.textContent = 'Stopping watch…';
  try{
    const res = await fetch('/watch/stop', { method:'POST' });
    if(!res.ok) throw new Error(`${res.status}`);
    log.textContent = 'Stopped.';
  }catch(e){
    log.textContent = `Failed: ${e.message}`;
  }
}

async function fetchLatest(){
  const log = document.getElementById('fetch-log');
  log.textContent = 'Fetching latest unread…';
  try{
    const res = await fetch('/fetch');
    const text = await res.text();
    log.textContent = `${res.status} ${text}`;
  }catch(e){
    log.textContent = `Failed: ${e.message}`;
  }
}

const btnRefresh = document.getElementById('refresh-status');
if(btnRefresh) btnRefresh.addEventListener('click', refreshStatus);
const btnStart = document.getElementById('watch-start');
if(btnStart) btnStart.addEventListener('click', startWatch);
const btnStop = document.getElementById('watch-stop');
if(btnStop) btnStop.addEventListener('click', stopWatch);
const btnFetch = document.getElementById('fetch-latest');
if(btnFetch) btnFetch.addEventListener('click', fetchLatest);

refreshStatus();

// Live updates via SSE
(function initSSE(){
  const pill = document.getElementById('sse-pill');
  let es;
  function set(state, text){
    if(!pill) return;
    pill.classList.remove('ok','err');
    pill.textContent = text || state;
    if(state==='ok') pill.classList.add('ok');
    if(state==='err') pill.classList.add('err');
  }
  function updateNotifyCard(data){
    const subjectEl = document.getElementById('notify-subject');
    const fromEl = document.getElementById('notify-from');
    const toEl = document.getElementById('notify-to');
    const bodyEl = document.getElementById('notify-body');
    const statusEl = document.getElementById('notify-status');
    if(subjectEl) subjectEl.textContent = data.subject || '—';
    if(fromEl) fromEl.textContent = data.from || '—';
    if(toEl) toEl.textContent = data.to || '—';
    const text = data.textBody || data.body || '';
    if(bodyEl) bodyEl.textContent = text;
    if(statusEl) statusEl.textContent = 'Sent to Cloudflare Sandbox for research. You will receive an email after we are done researching.';
  }
  try{
    es = new EventSource('/events');
    es.addEventListener('ready', ()=> set('ok','connected'));
    es.onerror = ()=> set('err','disconnected');
    function renderEmail(evt){
      try{
        const data = JSON.parse(evt.data);
        // Dev live preview
        const meta = document.getElementById('latest-meta');
        const body = document.getElementById('latest-body');
        if(meta && body){
          const lines = [];
          if(data.subject) lines.push(`<div><strong>Subject:</strong> ${escapeHtml(data.subject)}</div>`);
          if(data.from) lines.push(`<div><strong>From:</strong> ${escapeHtml(data.from)}</div>`);
          if(data.to) lines.push(`<div><strong>To:</strong> ${escapeHtml(data.to)}</div>`);
          if(data.source) lines.push(`<div><strong>Source:</strong> ${escapeHtml(data.source)}</div>`);
          meta.innerHTML = lines.join('');
          const text = data.textBody || data.body || '';
          body.textContent = text;
        }
        // Standard notification card
        updateNotifyCard(data);
      }catch(e){/* ignore */}
    }
    es.addEventListener('email', renderEmail);
    es.addEventListener('incoming', (e)=>{
      // Accept both shapes; prefer htmlBody/textBody/body if present
      try{
        const data = JSON.parse(e.data);
        const normalized = {
          subject: data.subject,
          from: data.from,
          to: data.to,
          body: data.textBody || (data.htmlBody ? stripHtmlClient(data.htmlBody) : data.body)
        };
        renderEmail({ data: JSON.stringify(normalized) });
      }catch(_){/* ignore */}
    });
  }catch(e){ set('err','unsupported'); }
})();

function escapeHtml(s){
  return (s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function stripHtmlClient(html){
  return (html||'')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(?=\s*<)/gi, '\n')
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<li>/gi, ' • ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Dev mode toggle
(function devToggle(){
  const btn = document.getElementById('dev-toggle');
  if(!btn) return;
  const key = 'intern.devMode';
  const current = localStorage.getItem(key) === '1';
  if(current) document.body.classList.add('dev-mode');
  btn.textContent = document.body.classList.contains('dev-mode') ? 'dev on' : 'dev';
  btn.addEventListener('click', ()=>{
    document.body.classList.toggle('dev-mode');
    const on = document.body.classList.contains('dev-mode');
    btn.textContent = on ? 'dev on' : 'dev';
    localStorage.setItem(key, on ? '1':'0');
  });
})();
