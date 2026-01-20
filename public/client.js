// public/client.js

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  kicked: false,
  roomCode: null,
  clientToken: localStorage.getItem('beiguo_clientToken') || null,
  nick: localStorage.getItem('beiguo_nick') || '',
  snapshot: null,
  pendingMove: null,

  // i18n
  lang: localStorage.getItem('beiguo_lang') || 'zh-CN'
  ,
  showGodView: (localStorage.getItem('beiguo_show_god') ?? '1') === '1'
};

function setShowGodView(v) {
  state.showGodView = !!v;
  localStorage.setItem('beiguo_show_god', state.showGodView ? '1' : '0');
}

function roomHasJudge(room) {
  return !!(room && room.seats && room.seats.REF && room.refToken && room.seats.REF === room.refToken);
}

// --- 简体/繁体切换（基于 OpenCC-JS）---
const i18n = {
  converter: null,
  textNodeOriginal: new WeakMap(),
  trackedTextNodes: new Set(),
  trackedAttrs: new Set() // elements with placeholder/title/data-i18n-* originals
};

function ensureOpenCC() {
  if (!window.OpenCC) return null;
  if (!i18n.converter) {
    // 简体（大陆） -> 繁体（台湾）
    i18n.converter = OpenCC.Converter({ from: 'cn', to: 'tw' });
  }
  return i18n.converter;
}

function applyLanguage() {
  const lang = state.lang || 'zh-CN';
  document.documentElement.lang = lang;

  const toTrad = (lang === 'zh-TW' || lang === 'zh-Hant');
  const converter = toTrad ? ensureOpenCC() : null;

  // 1) Text nodes
  //    - 转繁：保存原文 -> 转换
  //    - 转简：恢复原文
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node || !node.parentElement) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'INPUT') return NodeFilter.FILTER_REJECT;
        const v = node.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    },
    false
  );

  let n;
  while ((n = walker.nextNode())) {
    // 只处理包含中文的节点（避免无意义处理）
    const cur = n.nodeValue;
    if (!/[\u4e00-\u9fff]/.test(cur)) continue;

    if (toTrad) {
      if (!converter) continue;
      if (!i18n.textNodeOriginal.has(n)) {
        i18n.textNodeOriginal.set(n, cur);
        i18n.trackedTextNodes.add(n);
      }
      const orig = i18n.textNodeOriginal.get(n) || cur;
      try {
        n.nodeValue = converter(orig);
      } catch {
        // 如果 OpenCC 不可用/报错，就不转换
      }
    } else {
      if (i18n.textNodeOriginal.has(n)) {
        n.nodeValue = i18n.textNodeOriginal.get(n);
      }
    }
  }

  // 2) Common attrs: placeholder / title
  const els = document.querySelectorAll('[placeholder],[title]');
  els.forEach(el => {
    if (!el || !el.getAttribute) return;

    // placeholder
    if (el.hasAttribute('placeholder')) {
      const cur = el.getAttribute('placeholder') || '';
      if (toTrad) {
        if (!el.dataset.origPlaceholder) el.dataset.origPlaceholder = cur;
        i18n.trackedAttrs.add(el);
        if (converter && /[\u4e00-\u9fff]/.test(el.dataset.origPlaceholder || '')) {
          try { el.setAttribute('placeholder', converter(el.dataset.origPlaceholder)); } catch {}
        }
      } else if (el.dataset.origPlaceholder) {
        el.setAttribute('placeholder', el.dataset.origPlaceholder);
      }
    }

    // title
    if (el.hasAttribute('title')) {
      const cur = el.getAttribute('title') || '';
      if (toTrad) {
        if (!el.dataset.origTitle) el.dataset.origTitle = cur;
        i18n.trackedAttrs.add(el);
        if (converter && /[\u4e00-\u9fff]/.test(el.dataset.origTitle || '')) {
          try { el.setAttribute('title', converter(el.dataset.origTitle)); } catch {}
        }
      } else if (el.dataset.origTitle) {
        el.setAttribute('title', el.dataset.origTitle);
      }
    }
  });

  // 3) Page title
  if (toTrad && converter) {
    if (!document.documentElement.dataset.origDocTitle) {
      document.documentElement.dataset.origDocTitle = document.title;
    }
    try { document.title = converter(document.documentElement.dataset.origDocTitle); } catch {}
  } else if (document.documentElement.dataset.origDocTitle) {
    document.title = document.documentElement.dataset.origDocTitle;
  }
}

function sideName(side) {
  if (side === 'A') return '大宋';
  if (side === 'B') return '契丹';
  return String(side);
}

function roleName(role) {
  if (role === 'A') return '大宋';
  if (role === 'B') return '契丹';
  if (role === 'REF') return '裁判';
  if (role === 'SPECTATOR') return '观众';
  return String(role);
}

function toast(msg) {
  const el = $('toast');
  el.textContent = String(msg);
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, 2600);

  // toast 是独立浮层，确保语言切换后也正确显示
  applyLanguage();
}

function getOverFromView(view) {
  if (!view) return false;
  if (view.kind === 'ref_view') return !!(view.truth && view.truth.over);
  return !!view.over;
}

function getGameOverFromView(view) {
  if (!view) return null;
  if (view.kind === 'ref_view') return (view.truth && view.truth.gameOver) ? view.truth.gameOver : null;
  return view.gameOver || null;
}

function updateGameOverUI(view) {
  const modal = document.getElementById('gameOverModal');
  const win = document.getElementById('gameOverModalWin');
  const titleEl = document.getElementById('gameOverModalTitle');
  const bodyEl = document.getElementById('gameOverModalBody');
  if (!modal || !win || !titleEl || !bodyEl) return;

  const over = getOverFromView(view);
  const go = getGameOverFromView(view);

  if (!over || !go) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    titleEl.textContent = '游戏结束';
    bodyEl.textContent = '';
    win.classList.remove('win', 'lose', 'draw');
    state.gameOverShownKey = null;
    state.gameOverDismissedKey = null;
    return;
  }

  // prevent re-opening if user dismissed this exact ending
  const key = JSON.stringify({ w: go.winner || null, r: go.reason || null, l: go.location || null, s: go.story ? String(go.story).slice(0, 80) : null });
  if (state.gameOverDismissedKey && state.gameOverDismissedKey === key) return;

  // 平局
  if (!go.winner || go.reason === 'draw') {
    win.classList.remove('win', 'lose');
    win.classList.add('draw');
    titleEl.textContent = '🤝 游戏结束';
    bodyEl.textContent = '双方抓捕成功，平局';
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    state.gameOverShownKey = key;
    applyLanguage();
    return;
  }

  // winner display name
  let winnerName = sideName(go.winner);
  try {
    const snap = state.snapshot;
    const seatToken = snap && snap.room && snap.room.seats ? snap.room.seats[go.winner] : null;
    const r = snap && snap.roster ? snap.roster.find(x => x.token === seatToken) : null;
    if (r && r.nick) winnerName = `${r.nick}（${sideName(go.winner)}）`;
  } catch {}

  const location = go.location ? ` · 地点：${go.location}` : '';

  // 个人胜负判断：玩家视角有 seat；裁判/观众直接展示 winner
  let headline;
  if (state.self && state.self.seat && (state.self.role === 'A' || state.self.role === 'B')) {
    const iWin = go.winner === state.self.seat;
    win.classList.remove('win', 'lose', 'draw');
    win.classList.add(iWin ? 'win' : 'lose');
    headline = iWin ? `🎉 你成功抓捕敌方间谍，游戏结束${location}` : `💀 你的间谍被捕，游戏结束${location}`;
    // 替换剧情里的 XXX
    if (go.story) {
      const who = iWin ? '你' : winnerName;
      const story = String(go.story).replaceAll('XXX', who);
      titleEl.textContent = headline;
      bodyEl.textContent = story;
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
      state.gameOverShownKey = key;
      applyLanguage();
      return;
    }
    titleEl.textContent = headline;
    bodyEl.textContent = '';
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    state.gameOverShownKey = key;
    applyLanguage();
    return;
  }

  win.classList.remove('win', 'lose', 'draw');
  win.classList.add('win');
  headline = `🏁 游戏结束：${winnerName} 胜利（抓捕成功）${location}`;
  if (go.story) {
    const story = String(go.story).replaceAll('XXX', winnerName);
    titleEl.textContent = headline;
    bodyEl.textContent = story;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    state.gameOverShownKey = key;
    applyLanguage();
    return;
  }
  titleEl.textContent = headline;
  bodyEl.textContent = '';
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  state.gameOverShownKey = key;
  applyLanguage();
}

function lockControlsIfOver(view) {
  const over = getOverFromView(view);
  if (!over) return;

  // 游戏结束后：禁止推进阶段。裁判仍可“开始/重置”
  const isRef = state.self && state.self.token && state.snapshot && state.snapshot.room && (state.snapshot.room.refToken === state.self.token);
  const btnAdvance = document.getElementById('btnAdvance');
  if (btnAdvance) btnAdvance.disabled = true;

  // 玩家端：额外禁用可点击区域（渲染时也会禁用 clickMode）
  // 这里不强制禁用所有按钮，避免把复制链接之类也锁死。
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

// --- WebSocket 连接（含自动重连）---
let reconnectAttempt = 0;
let reconnectTimer = null;

// 等待 WebSocket 进入 OPEN：用于「创建/加入房间」时确保连接已就绪。
// 场景：房主踢人后，用户不刷新页面直接再次加入/创建。
// 如果 WS 已被关闭/正在重连，需要在发送 JOIN/CREATE 前等待连接完成。
async function connectWs(timeoutMs = 5000) {
  // 已连接
  if (state.ws && state.ws.readyState === 1) return;

  // 如果不存在连接或已关闭，则发起连接
  if (!state.ws || state.ws.readyState === 3) {
    startWs();
  }

  // 等待 OPEN / ERROR / CLOSE / 超时
  await new Promise((resolve, reject) => {
    const ws = state.ws;
    if (!ws) return reject(new Error('ws not initialized'));

    if (ws.readyState === 1) return resolve();

    const t = setTimeout(() => {
      cleanup();
      reject(new Error('ws connect timeout'));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      // 关闭后交给自动重连，但这里仍然拒绝，让调用方提示用户再试
      reject(new Error('ws closed'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('ws error'));
    };

    function cleanup() {
      clearTimeout(t);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
    }

    ws.addEventListener('open', onOpen);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // 指数退避：0.5s, 1s, 2s, 4s ... 上限 10s
  const delay = Math.min(10000, 500 * Math.pow(2, reconnectAttempt));
  reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWs();
  }, delay);
}

function startWs() {
  try {
    const ws = new WebSocket(wsUrl());
    state.ws = ws;

    ws.onopen = () => {
      reconnectAttempt = 0;
      const el = document.getElementById('connStatus');
      if (el) el.textContent = '已连接';

      // 若之前已经在房间里（断线重连），自动重新 JOIN
      if (state.roomCode && state.nick && state.clientToken) {
        ws.send(JSON.stringify({
          type: 'JOIN_ROOM',
          roomCode: state.roomCode,
          nick: state.nick,
          clientToken: state.clientToken
        }));
      }
    };

    ws.onerror = () => {
      // 交给 onclose 统一处理
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'HELLO') {
        // ignore
        return;
      }

      if (msg.type === 'ERROR') {
        toast(msg.message || '发生错误');
        return;
      }

      if (msg.type === 'KICKED') {
        toast(msg.message || '你已被移出房间');
        // 回到加入界面（保留昵称/本地 token，允许再次加入）
        state.kicked = true;
        state.snapshot = null;
        state.roomCode = null;
        setMode('join');
        return;
      }

      if (msg.type === 'ROOM_CREATED' || msg.type === 'ROOM_JOINED') {
        state.roomCode = msg.roomCode;
        state.clientToken = msg.clientToken;
        localStorage.setItem('beiguo_clientToken', state.clientToken);
        setMode('room');
        // top room badge
        $('roomCode').textContent = state.roomCode;
        return;
      }

      if (msg.type === 'ROOM_SNAPSHOT') {
        state.snapshot = msg;
        renderRoom();
        return;
      }
    };

    ws.onclose = () => {
      const el = document.getElementById('connStatus');
      if (el) el.textContent = '未连接';
      if (state.kicked) {
        state.kicked = false;
        return;
      }
      toast('连接已断开，正在尝试重连…');
      scheduleReconnect();
    };
  } catch {
    scheduleReconnect();
  }
}

function send(type, payload = {}) {
  if (!state.ws || state.ws.readyState !== 1) {
    toast('未连接到服务器。');
    return;
  }
  state.ws.send(JSON.stringify({
    type,
    roomCode: state.roomCode,
    clientToken: state.clientToken,
    ...payload
  }));
}

function setMode(mode) {
  // index.html uses joinCard/roomCard and toggles visibility via display
  $('joinCard').style.display = (mode === 'join') ? '' : 'none';
  $('roomCard').style.display = (mode === 'room') ? '' : 'none';
}

function sanitizeRoomCode(s) {
  return String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

// --- UI: Join/Create ---
$('nickInput').value = state.nick;
$('btnCreate').onclick = async () => {
  const nick = $('nickInput').value.trim();
  if (!nick) return toast('请先输入昵称');
  state.nick = nick;
  localStorage.setItem('beiguo_nick', nick);

  if (!state.ws || state.ws.readyState !== 1) await connectWs();
  state.ws.send(JSON.stringify({ type: 'CREATE_ROOM', nick, clientToken: state.clientToken }));
};

$('btnJoin').onclick = async () => {
  const nick = $('nickInput').value.trim();
  const roomCode = sanitizeRoomCode($('roomInput').value);
  if (!nick) return toast('请先输入昵称');
  if (!roomCode) return toast('请输入房间号');

  state.nick = nick;
  localStorage.setItem('beiguo_nick', nick);

  if (!state.ws || state.ws.readyState !== 1) await connectWs();
  state.ws.send(JSON.stringify({ type: 'JOIN_ROOM', nick, roomCode, clientToken: state.clientToken }));
};

$('btnCopy').onclick = async () => {
  if (!state.roomCode) return;
  try {
    await navigator.clipboard.writeText(state.roomCode);
    toast('房间号已复制');
  } catch {
    toast('复制失败（浏览器不支持）');
  }
};

$('btnStart').onclick = () => send('START_GAME');
$('btnAdvance').onclick = () => send('ADVANCE_PHASE');

// --- Game over modal interactions ---
function initGameOverModal() {
  const modal = document.getElementById('gameOverModal');
  const win = document.getElementById('gameOverModalWin');
  const closeBtn = document.getElementById('gameOverModalClose');
  if (!modal || !win || !closeBtn) return;

  const close = () => {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    // mark dismissed so re-renders won't re-open this exact ending
    if (state.gameOverShownKey) state.gameOverDismissedKey = state.gameOverShownKey;
  };

  closeBtn.onclick = close;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

initGameOverModal();

// --- Roster rendering (host controls) ---
function isHost() {
  const snap = state.snapshot;
  return snap && snap.room && snap.self && snap.room.hostToken === snap.self.token;
}

function renderRoster(roster) {
  const tbody = $('rosterTable').querySelector('tbody');
  tbody.innerHTML = '';

  for (const row of roster) {
    const tr = document.createElement('tr');

    const tdNick = document.createElement('td');
    tdNick.textContent = row.nick;

    const tdRole = document.createElement('td');
    tdRole.textContent = roleName(row.role);

    const tdOps = document.createElement('td');

    if (isHost()) {
      // Compact host controls: one dropdown + apply button (+ optional transfer)
      const opsWrap = document.createElement('div');
      opsWrap.className = 'rosterOps';

      const sel = document.createElement('select');
      sel.className = 'rosterSelect';
      const options = [
        { v: 'A', label: '设为大宋' },
        { v: 'B', label: '设为契丹' },
        { v: 'REF', label: '设为裁判' },
        { v: 'SPECTATOR', label: '设为观众' },
      ];
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.v;
        o.textContent = opt.label;
        sel.appendChild(o);
      }
      // default select based on current seat
      sel.value = row.seat ? row.seat : 'SPECTATOR';

      const applyBtn = document.createElement('button');
      applyBtn.className = 'smallBtn';
      applyBtn.textContent = '应用';
      applyBtn.onclick = () => send('HOST_ASSIGN_SEAT', { targetToken: row.token, seat: sel.value });

      opsWrap.appendChild(sel);
      opsWrap.appendChild(applyBtn);

      // Transfer host is rare; keep it compact and only show for other users
      if (row.token !== state.clientToken) {
        const transferBtn = document.createElement('button');
        transferBtn.className = 'danger smallBtn';
        transferBtn.textContent = '转移房主';
        transferBtn.onclick = () => {
          if (!confirm('确定转移房主？你将失去房主权限。')) return;
          send('HOST_TRANSFER', { targetToken: row.token });
        };
        opsWrap.appendChild(transferBtn);

        const kickBtn = document.createElement('button');
        kickBtn.className = 'danger smallBtn';
        kickBtn.textContent = '踢出';
        kickBtn.onclick = () => {
          if (!confirm(`确定踢出 ${row.nick}？`)) return;
          send('KICK_MEMBER', { targetToken: row.token });
        };
        opsWrap.appendChild(kickBtn);
      }

      tdOps.appendChild(opsWrap);
    } else {
      tdOps.innerHTML = '<span class="muted">仅房主可操作</span>';
    }

    tr.appendChild(tdNick);
    tr.appendChild(tdRole);
    tr.appendChild(tdOps);
    tbody.appendChild(tr);
  }
}

// --- Board utilities ---
function cellName(r, c) {
  // 与你最早的裁判版一致：格子内部显示地名
  const CELL_NAMES = [
    ['池塘', '红树', '马车'],
    ['药店', '塔楼', '浴室'],
    ['小桥', '水井', '米奇不妙屋']
  ];
  return CELL_NAMES[r][c];
}

function renderBoard(root, boardId, view, sideForThisBoard, clickMode) {
  // clickMode: { enabled, piece: 'spy'|'hunter' }
  const wrap = document.createElement('div');
  wrap.className = 'boardWrap';

  const mkDir = (cls, text) => {
    const d = document.createElement('div');
    d.className = `dirLabel ${cls}`;
    d.textContent = text;
    return d;
  };

  // 方位写在棋盘周围（格子内保留地名）
  wrap.appendChild(mkDir('dirNW', 'NW'));
  wrap.appendChild(mkDir('dirN',  'N'));
  wrap.appendChild(mkDir('dirNE', 'NE'));
  wrap.appendChild(mkDir('dirW',  'W'));
  wrap.appendChild(mkDir('dirE',  'E'));
  wrap.appendChild(mkDir('dirSW', 'SW'));
  wrap.appendChild(mkDir('dirS',  'S'));
  wrap.appendChild(mkDir('dirSE', 'SE'));

  const board = document.createElement('div');
  board.className = 'grid';

  const truth = view.truth;

  const getPos = (s, key) => {
    if (view.kind === 'ref_view') {
      return truth[s][key];
    }
    // player_view
    if (view.side === s) return view.self[key];
    return null;
  };

  const getVisitedOuter = (s) => {
    if (view.kind === "ref_view") {
      return new Set((truth[s].patrolVisitedOuter || []));
    }
    if (view.kind === "player_view" && view.side === s) {
      return new Set((view.self.patrolVisitedOuter || []));
    }
    return new Set();
  };

  // 用于差役成群“绕城一圈”的可视化：
  // - 裁判视角：两边都可见
  // - 玩家视角：只显示自己走过的外围格
  const visitedOuter = getVisitedOuter(sideForThisBoard);


  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);

      const small = document.createElement('small');
      small.textContent = cellName(r, c);

      const piece = document.createElement('div');
      piece.className = 'piece';

      const spy = getPos(sideForThisBoard, 'spyPos');
      const hunter = getPos(sideForThisBoard, 'hunterPos');

      const hereSpy = spy && spy.r === r && spy.c === c;
      const hereHunter = hunter && hunter.r === r && hunter.c === c;

      let label = '';
      if (hereSpy) label += '间';
      if (hereHunter) label += (label ? ' / ' : '') + '捕';
      piece.textContent = label;

      cell.appendChild(piece);
      cell.appendChild(small);
      const key = `${r},${c}`;
      if (visitedOuter.has(key)) {
        cell.classList.add('outerVisited');
      }

      if (clickMode?.enabled) {
        const isLegal = !clickMode.legal || clickMode.legal.has(key);
        if (isLegal) {
          cell.classList.add('legal');
          cell.onclick = () => { clickMode.onSelect && clickMode.onSelect({ r, c }); };
        } else {
          cell.style.cursor = 'default';
        }
        const p = clickMode.pending;
        if (p && p.r === r && p.c === c) {
          cell.classList.add('pending');
        }
      } else {
        cell.style.cursor = 'default';
      }

      board.appendChild(cell);
    }
  }

  root.innerHTML = '';
  wrap.appendChild(board);
  root.appendChild(wrap);
}

function renderLog(container, entries) {
  const div = document.createElement('div');
  div.className = 'log';
  for (const e of entries) {
    const line = document.createElement('div');
    line.className = 'logLine';

    // 解析日志类型标签（用于颜色区分）
    let tag = 'log';
    if (e.text.includes('· 部署')) tag = 'deploy';
    else if (e.text.includes('· 追捕')) tag = 'chase';
    else if (e.text.includes('· 锦囊')) tag = 'card';
    else if (e.text.includes('· 隐藏')) tag = 'hidden';
    else if (e.text.includes('游戏结束') || e.text.includes('抓捕成功')) tag = 'win';

    const badge = document.createElement('span');
    badge.className = `logTag ${tag}`;
    badge.textContent = tag === 'deploy' ? '部署' :
      tag === 'chase' ? '追捕' :
      tag === 'card' ? '锦囊' :
      tag === 'hidden' ? '隐藏' :
      tag === 'win' ? '胜负' : '日志';

    const text = document.createElement('div');
    text.textContent = e.text;
    line.appendChild(badge);
    line.appendChild(text);
    div.appendChild(line);
  }
  container.innerHTML = '';
  container.appendChild(div);
}

function renderPlayerView(view) {
  const isOver = !!view.over;

  const root = document.createElement('div');

  const banner = document.createElement('div');
  const phaseName = view.phase === 'deploy' ? '部署阶段' : '追捕阶段';
  banner.className = `phaseBanner ${view.phase === 'deploy' ? 'deploy' : 'chase'}`;
  banner.innerHTML = `
    <div class="big">回合 ${view.round} · ${phaseName}</div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <span class="pill ${view.side === 'A' ? 'a' : 'b'}">${sideName(view.side)}</span>
      <span class="pill ${view.phase === 'deploy' ? 'phaseDeploy' : 'phaseChase'}">${view.phase === 'deploy' ? '间谍行动' : '追捕行动'}</span>
    </div>
  `;
  root.appendChild(banner);

  const hint = document.createElement('div');
  hint.style.marginTop = '6px';
  hint.innerHTML = `<span class="pill">操作说明</span> 先点绿色合法格子进行<strong>预选</strong>（不入日志），再点<strong>确认落点</strong>提交。`;
  root.appendChild(hint);

  // --- Buff 栏（玩家视角：只看自己的）---
  const buffCard = document.createElement('div');
  buffCard.className = 'card';
  buffCard.style.marginTop = '10px';

  const buffs = [];
  if (view.self?.patrolActive && (view.self.patrolRoundsLeft || 0) > 0) {
    buffs.push({ name: '差役成群', detail: `剩 ${view.self.patrolRoundsLeft} 回合` });
  }
  if ((view.self?.frozenRounds || 0) > 0) {
    buffs.push({ name: '宵禁令', detail: `冻结 ${view.self.frozenRounds} 回合` });
  }
  if (view.self?.youjingPending) {
    buffs.push({ name: '幽径暗道', detail: '待穿越（本回合）' });
  }
  if (view.self?.hidden?.almsNetwork) {
    buffs.push({ name: '丐帮情报网络', detail: '永久' });
  }
  if (view.self?.hidden?.undergroundNetwork) {
    buffs.push({ name: '地下网络', detail: '永久' });
  }
  if (view.self?.hidden?.hunterIntuition) {
    buffs.push({ name: '猎户直觉', detail: '永久' });
  }

  buffCard.innerHTML = `<strong>你的 Buff</strong>`;
  if (!buffs.length) {
    const none = document.createElement('div');
    none.className = 'muted';
    none.style.marginTop = '6px';
    none.textContent = '暂无持续效果';
    buffCard.appendChild(none);
  } else {
    const bar = document.createElement('div');
    bar.style.display = 'flex';
    bar.style.flexWrap = 'wrap';
    bar.style.gap = '6px';
    bar.style.marginTop = '8px';

    for (const b of buffs) {
      const p = document.createElement('span');
      p.className = 'pill';
      p.textContent = `${b.name} · ${b.detail}`;
      bar.appendChild(p);
    }
    buffCard.appendChild(bar);
  }
  root.appendChild(buffCard);

  const boardBox = document.createElement('div');
  boardBox.className = 'boardBox';
  boardBox.style.marginTop = '10px';

  const title = document.createElement('div');
  title.className = 'boardTitle';
  title.innerHTML = `<strong>你的棋盘（${sideName(view.side)}）</strong><span class="pill">${view.phase === 'deploy' ? '点格子移动间' : '点格子移动捕'}</span>`;
  boardBox.appendChild(title);

  const boardRoot = document.createElement('div');
  boardBox.appendChild(boardRoot);

  const side = view.side;
  const phase = view.phase;
  const piece = (phase === 'deploy') ? 'spy' : 'hunter';
  const moved = (view.movesThisPhase && view.movesThisPhase[side]) ? view.movesThisPhase[side] : 0;
  const frozen = (view.self && view.self.frozenRounds) ? view.self.frozenRounds : 0;
  const started = !!view.started;
  let canAct = started && (!isOver) && (moved < 1) && (frozen <= 0);
  if (canAct && piece === 'hunter' && !view.self.spyPos) canAct = false;

  const legal = new Set();
  const addAll = () => {
    for (let rr = 0; rr < 3; rr++) for (let cc = 0; cc < 3; cc++) legal.add(`${rr},${cc}`);
  };
  const addAdj4 = (from) => {
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dr,dc] of dirs) {
      const rr = from.r + dr, cc = from.c + dc;
      if (rr >= 0 && rr < 3 && cc >= 0 && cc < 3) legal.add(`${rr},${cc}`);
    }
  };
  const addAdj8 = (from) => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = from.r + dr, cc = from.c + dc;
      if (rr >= 0 && rr < 3 && cc >= 0 && cc < 3) legal.add(`${rr},${cc}`);
    }
  };
  const addAdj9 = (from) => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = from.r + dr, cc = from.c + dc;
      if (rr >= 0 && rr < 3 && cc >= 0 && cc < 3) legal.add(`${rr},${cc}`);
    }
  };
  const isCorner = (p) => !!(p && (p.r === 0 || p.r === 2) && (p.c === 0 || p.c === 2));
  const isDiagTeleport = (from, to) => {
    const pairs = [
      [{ r: 0, c: 0 }, { r: 2, c: 2 }],
      [{ r: 2, c: 2 }, { r: 0, c: 0 }],
      [{ r: 0, c: 2 }, { r: 2, c: 0 }],
      [{ r: 2, c: 0 }, { r: 0, c: 2 }]
    ];
    return pairs.some(([a, b]) => a.r === from.r && a.c === from.c && b.r === to.r && b.c === to.c);
  };

  if (canAct) {
    if (piece === 'spy') {
      if (!view.self.spyPos) {
        addAll();
      } else if (view.self.youjingPending && isCorner(view.self.spyPos)) {
        for (let rr = 0; rr < 3; rr++) for (let cc = 0; cc < 3; cc++) {
          const to = { r: rr, c: cc };
          if (isDiagTeleport(view.self.spyPos, to)) legal.add(`${rr},${cc}`);
        }
      } else {
        addAdj4(view.self.spyPos);
      }
    } else {
      // 追捕阶段：合法落点以【我方间谍】为中心的 1 格米字范围（含本格）
      if (!view.self.spyPos) {
        // 尚未部署间谍则无法追捕
      } else {
        addAdj9(view.self.spyPos);
      }
    }
  }

  // pending 仅在本阶段本棋子有效
  let pending = null;
  if (state.pendingMove && state.pendingMove.piece === piece) {
    pending = state.pendingMove.to;
  }
  if (!canAct) {
    state.pendingMove = null;
    pending = null;
  }

  renderBoard(boardRoot, 'self', view, view.side, {
    enabled: canAct,
    piece,
    legal,
    pending,
    onSelect: (to) => {
      state.pendingMove = { piece, to };
      renderRoom();
    }
  });

  // 确认/取消（未进入下一阶段前可反复调整，不写日志）
  const bar = document.createElement('div');
  bar.style.display = 'flex';
  bar.style.gap = '8px';
  bar.style.alignItems = 'center';
  bar.style.marginTop = '8px';

  const label = document.createElement('div');
  label.className = 'muted';
  label.style.flex = '1';
  if (pending) {
    label.textContent = `已选择：${cellName(pending.r, pending.c)}（点击其他合法格可更改）`;
  } else {
    if (!started) label.textContent = '等待裁判点击开始游戏…';
    else label.textContent = canAct ? '未选择落点：请点击高亮格子' : (frozen > 0 ? '你被【宵禁令】影响，本回合无法行动' : (piece === 'hunter' && !view.self.spyPos ? '你尚未部署间谍，无法追捕' : '你本阶段已行动'));
  }

  const btnOk = document.createElement('button');
  btnOk.textContent = '确认落点';
  btnOk.className = 'primary';
  btnOk.disabled = !(canAct && pending);
  btnOk.onclick = () => {
    if (!(canAct && pending)) return;
    send('MOVE', { piece, to: pending });
    state.pendingMove = null;
    renderRoom();
  };

  const btnCancel = document.createElement('button');
  btnCancel.textContent = '取消选择';
  btnCancel.disabled = !(canAct && pending);
  btnCancel.onclick = () => {
    state.pendingMove = null;
    renderRoom();
  };

  bar.appendChild(label);
  bar.appendChild(btnOk);
  bar.appendChild(btnCancel);
  boardBox.appendChild(bar);

  root.appendChild(boardBox);

  // cards
  const cards = document.createElement('div');
  cards.className = 'card';
  cards.style.marginTop = '10px';
  const baseCardOrder = ['差役成群','幽径暗道','耳目线报','追猎犬'];
  const lines = baseCardOrder
    .map(name => ({ name, n: (view.self.cards?.[name] || 0) }))
    .filter(it => it.n > 0);

  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.alignItems = 'center';
  head.style.justifyContent = 'space-between';
  head.innerHTML = `<strong>你的锦囊</strong><span class="muted">本阶段已用锦囊：${view.cardsUsedThisPhase[view.side] ? '是' : '否'}</span>`;
  cards.appendChild(head);

  if (!lines.length) {
    const none = document.createElement('div');
    none.className = 'muted';
    none.style.marginTop = '6px';
    none.textContent = '无可用锦囊';
    cards.appendChild(none);
  } else {
    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexWrap = 'wrap';
    list.style.gap = '8px';
    list.style.marginTop = '8px';

    for (const it of lines) {
      const b = document.createElement('button');
      b.textContent = `${it.name} × ${it.n}`;
      // 阶段限制：部署卡/追捕卡
      const isDeployCard = (it.name === '差役成群' || it.name === '幽径暗道');
      const phaseOk = (view.phase === 'deploy') ? isDeployCard : !isDeployCard;
      b.disabled = view.cardsUsedThisPhase[view.side] || !phaseOk;

      b.onclick = () => {
        // 参照最早裁判版：耳目线报需要方向输入，并可选发动隐藏效果【拿钱办事】
        if (it.name === '耳目线报') {
          const dirStr = prompt('【耳目线报】请输入侦查方向（N,S,E,W,NE,NW,SE,SW）：');
          if (!dirStr) return;
          const dir = dirStr.trim().toUpperCase();
          const payload = { dir };

          const hasAlms = !!(view.self.hidden && view.self.hidden.almsNetwork);
          if (!hasAlms) {
            const want = confirm('是否发动隐藏效果【拿钱办事】？\n确定：额外弃置 1 张其它卡牌，获得【丐帮情报网络】（后续耳目可侦查整条线）。');
            if (want) {
              // 可弃置候选：除“耳目线报”外且数量>0
              const candidates = baseCardOrder
                .filter(n => n !== '耳目线报')
                .map(n => ({ name: n, n: (view.self.cards?.[n] || 0) }))
                .filter(x => x.n > 0);

              if (candidates.length) {
                let tip = '选择要弃置的卡牌（输入序号或卡名）：\n';
                candidates.forEach((x, idx) => { tip += `${idx + 1}. ${x.name} × ${x.n}\n`; });
                const ans = prompt(tip);
                if (ans) {
                  const raw = ans.trim();
                  let pick = null;
                  const m = raw.match(/^(\d+)/);
                  if (m) {
                    const num = parseInt(m[1], 10);
                    if (num >= 1 && num <= candidates.length) pick = candidates[num - 1].name;
                  }
                  if (!pick) {
                    for (const x of candidates) {
                      if (raw === x.name || x.name.includes(raw) || raw.includes(x.name)) {
                        pick = x.name; break;
                      }
                    }
                  }
                  if (pick) {
                    payload.wantAlms = true;
                    payload.discardCard = pick;
                  }
                }
              } else {
                toast('你没有其它卡牌可弃置，无法发动【拿钱办事】。');
              }
            }
          }

          send('PLAY_CARD', { cardName: it.name, payload });
          return;
        }

        send('PLAY_CARD', { cardName: it.name, payload: {} });
      };

      list.appendChild(b);
    }

    cards.appendChild(list);
  }

  root.appendChild(cards);

  return root;
}

function renderRefView(view) {
  const isOver = !!(view.truth && view.truth.over);

  const root = document.createElement('div');

  const banner = document.createElement('div');
  const phaseName = view.truth.phase === 'deploy' ? '部署阶段' : '追捕阶段';
  banner.className = `phaseBanner ${view.truth.phase === 'deploy' ? 'deploy' : 'chase'}`;
  banner.innerHTML = `
    <div class="big">上帝视角 · 回合 ${view.truth.round} · ${phaseName}</div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <span class="pill">裁判/观众</span>
      <span class="pill ${view.truth.phase === 'deploy' ? 'phaseDeploy' : 'phaseChase'}">${view.truth.phase === 'deploy' ? '间谍行动' : '追捕行动'}</span>
      <span class="pill" title="差役成群外围走过的格子会高亮">外围已巡逻：蓝色内框</span>
    </div>
  `;
  root.appendChild(banner);

  const boards = document.createElement('div');
  boards.className = 'boards refGrid';
  boards.style.marginTop = '10px';

  const mkBoard = (side) => {
    const box = document.createElement('div');
    box.className = 'boardBox';
    const title = document.createElement('div');
    title.className = 'boardTitle';
    title.innerHTML = `<strong>${sideName(side)} 方棋盘</strong><span class="pill">间/捕全可见</span>`;
    box.appendChild(title);
    const root = document.createElement('div');
    box.appendChild(root);
    renderBoard(root, `ref-${side}`, view, side, { enabled: false });
    return box;
  };

  boards.appendChild(mkBoard('A'));
  boards.appendChild(mkBoard('B'));
  root.appendChild(boards);

  const stat = document.createElement('div');
  stat.className = 'card';
  stat.style.marginTop = '10px';
  const truth = view.truth;
  const cardSummary = (s) => {
    const cards = truth[s].cards;
    const list = Object.entries(cards).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`);
    return list.join('，') || '无';
  };
  stat.innerHTML = `
    <div><strong>状态</strong></div>
    <div class="muted" style="margin-top:6px">${sideName('A')} 冻结回合：${truth.A.frozenRounds}；${sideName('B')} 冻结回合：${truth.B.frozenRounds}</div>
    <div class="muted">${sideName('A')} 本阶段移动次数：${truth.movesThisPhase.A}；${sideName('B')} 本阶段移动次数：${truth.movesThisPhase.B}</div>
    <div class="muted">${sideName('A')} 本阶段已用锦囊：${truth.cardsUsedThisPhase.A ? '是' : '否'}；${sideName('B')}：${truth.cardsUsedThisPhase.B ? '是' : '否'}</div>
    <div style="margin-top:8px"><span class="pill">${sideName('A')} 手牌</span> <span class="muted">${cardSummary('A')}</span></div>
    <div style="margin-top:6px"><span class="pill">${sideName('B')} 手牌</span> <span class="muted">${cardSummary('B')}</span></div>
  `;

  // --- Buff 栏（上帝视角：两边都可见）---
  const mkBuffLine = (side) => {
    const p = truth[side];
    const buffs = [];
    if (p.patrolActive && (p.patrolRoundsLeft || 0) > 0) buffs.push(`差役成群 · 剩 ${p.patrolRoundsLeft} 回合`);
    if ((p.frozenRounds || 0) > 0) buffs.push(`宵禁令 · 冻结 ${p.frozenRounds} 回合`);
    if (p.youjingPending) buffs.push('幽径暗道 · 待穿越（本回合）');
    if (p.hidden?.almsNetwork) buffs.push('丐帮情报网络 · 永久');
    if (p.hidden?.undergroundNetwork) buffs.push('地下网络 · 永久');
    if (p.hidden?.hunterIntuition) buffs.push('猎户直觉 · 永久');

    const wrap = document.createElement('div');
    wrap.style.marginTop = '8px';

    const head = document.createElement('div');
    head.innerHTML = `<span class="pill">${sideName(side)} Buff</span>`;
    wrap.appendChild(head);

    if (!buffs.length) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.style.marginTop = '6px';
      none.textContent = '暂无持续效果';
      wrap.appendChild(none);
      return wrap;
    }

    const bar = document.createElement('div');
    bar.style.display = 'flex';
    bar.style.flexWrap = 'wrap';
    bar.style.gap = '6px';
    bar.style.marginTop = '6px';
    for (const text of buffs) {
      const p = document.createElement('span');
      p.className = 'pill';
      p.textContent = text;
      bar.appendChild(p);
    }
    wrap.appendChild(bar);
    return wrap;
  };

  stat.appendChild(mkBuffLine('A'));
  stat.appendChild(mkBuffLine('B'));
  root.appendChild(stat);

  return root;
}

function renderRoom() {
  const snap = state.snapshot;
  if (!snap) return;

  const me = snap.self;
  state.self = me;
  const room = snap.room;
  const roster = snap.roster;

  // top controls
  $('selfTag').textContent = roleName(me.role);
  const hasJudge = roomHasJudge(room);
  // START：有裁判 -> 裁判；无裁判 -> 房主
  $('btnStart').disabled = !(hasJudge ? (room.refToken === me.token) : isHost());
  // ADVANCE：仅裁判制允许手动推进（自动裁判模式默认自动推进）
  $('btnAdvance').disabled = !(hasJudge && room.refToken === me.token);

  // header god-view toggle（本地开关：只影响本机显示）
  const wrap = document.getElementById('godToggleWrap');
  if (wrap) {
    wrap.innerHTML = '';
    if (snap.view && snap.view.kind === 'ref_view') {
      const lbl = document.createElement('label');
      lbl.style.display = 'flex';
      lbl.style.alignItems = 'center';
      lbl.style.gap = '6px';
      lbl.style.margin = '0 0 0 6px';
      lbl.style.fontSize = '12px';
      lbl.style.color = '#555';
      const ck = document.createElement('input');
      ck.type = 'checkbox';
      ck.checked = !!state.showGodView;
      ck.onchange = () => {
        setShowGodView(ck.checked);
        renderRoom();
      };
      const span = document.createElement('span');
      span.textContent = state.showGodView ? '显示上帝视角' : '隐藏上帝视角';
      lbl.appendChild(ck);
      lbl.appendChild(span);
      wrap.appendChild(lbl);
      applyLanguage();
    }
  }

  updateGameOverUI(snap.view);
  lockControlsIfOver(snap.view);


  renderRoster(roster);

  // logs (moved to left sidebar to reduce scrolling)
  const logTitle = $('logTitle');
  const logPanel = $('logPanel');
  logPanel.innerHTML = '';
  if (snap.view.kind === 'player_view') {
    logTitle.textContent = '你的可见日志';
  } else {
    logTitle.textContent = '全量日志（裁判/观众可见）';
  }
  renderLog(logPanel, snap.view.log);

  // view
  const viewRoot = $('viewRoot');
  const view = snap.view;
  if (view.kind === 'player_view') {
    viewRoot.innerHTML = '';
    viewRoot.appendChild(renderPlayerView(view));
  } else {
    viewRoot.innerHTML = '';
    if (state.showGodView) {
      viewRoot.appendChild(renderRefView(view));
    } else {
      const card = document.createElement('div');
      card.className = 'card';
      const hasJudge = roomHasJudge(room);
      card.innerHTML = `
        <div style="font-weight:800">已隐藏上帝视角</div>
        <div class="muted" style="margin-top:6px">你仍可作为房主管理在线列表${hasJudge ? '，并可在需要时勾选显示上帝视角' : '。当前未分配裁判：处于自动裁判模式'}。</div>
      `;
      viewRoot.appendChild(card);
    }
  }

  // DOM 更新后：应用语言（对新增节点也生效）
  applyLanguage();
}

function initLanguageToggle() {
  const sel = document.getElementById('langSelect');
  if (!sel) return;

  // 默认值
  sel.value = state.lang || 'zh-CN';

  sel.addEventListener('change', () => {
    state.lang = sel.value || 'zh-CN';
    localStorage.setItem('beiguo_lang', state.lang);
    applyLanguage();
  });

  // 首次应用
  applyLanguage();
}

// init
setMode('join');
initLanguageToggle();
startWs();
