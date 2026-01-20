import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

/**
 * 北国密令 - 联机服务器（裁判制）
 * - 房间号系统生成
 * - Host 默认裁判，可移交 Host（移交即失去房主权限）
 * - 裁判/观众上帝视角；玩家仅见自己视图
 * - 不做聊天
 */

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const app = express();
app.use(express.static('public'));

// Render/平台健康检查
app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

const server = http.createServer(app);
// WebSocket 固定在 /ws，便于前端在 https 下使用 wss://<host>/ws
const wss = new WebSocketServer({ server, path: '/ws' });

/** @typedef {'HOST'|'REF'|'A'|'B'|'SPECTATOR'} Role */

function randCode(len = 6) {
  // 省事：大写字母+数字，排除易混淆字符
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

function clampNick(raw) {
  const s = String(raw ?? '').trim();
  // 允许中文/英文/数字/空格/下划线/中划线（避免乱七八糟控制字符）
  const cleaned = s.replace(/[^\p{Script=Han}\p{L}\p{N} _\-]/gu, '').slice(0, 16);
  return cleaned || '玩家';
}

function uniqNick(desired, takenSet) {
  if (!takenSet.has(desired)) return desired;
  let i = 2;
  while (takenSet.has(`${desired}#${i}`)) i++;
  return `${desired}#${i}`;
}

function defaultTruthState() {
  return {
    round: 1,
    phase: 'deploy', // 'deploy' | 'hunt'
    started: false,
    over: false,
    gameOver: null,
    // 追捕阶段：双方“确认”后统一结算抓捕，避免先手优势
    pendingCapture: { A: false, B: false },

    // 每阶段每方必须至少移动一次（没被宵禁）
    movesThisPhase: { A: 0, B: 0 },
    cardsUsedThisPhase: { A: false, B: false },
    // 每回合（部署+追捕）每方最多使用 1 次锦囊
    cardsUsedThisRound: { A: false, B: false },

    A: {
      spyPos: null,
      spyPrevPos: null,
      hunterPos: null,
      frozenRounds: 0,
      // 差役成群
      patrolActive: false,
      patrolRoundsLeft: 0,
      patrolVisitedOuter: [],
      // 幽径暗道
      youjingPending: false,
      youjingDiag1: false,
      youjingDiag2: false,
      lastYoujingTeleport: null, // {from,to,round}
      // 追猎犬
      lastDogDirections: [], // 最近两次
      // 手牌：本体包仅 4 种（其余为隐藏效果/状态，不属于手牌）
      cards: {
        '差役成群': 0,
        '幽径暗道': 0,
        '耳目线报': 0,
        '追猎犬': 0
      },
      // 隐藏效果/状态（不计入手牌）
      hidden: {
        // 地下网络：幽径暗道 X 形穿越触发后，敌方进入四角时提示
        undergroundNetwork: false,
        // 猎户直觉：追猎犬连续两次同方向触发
        hunterIntuition: false,
        // 拿钱办事：耳目线报弃牌触发，耳目线报获取整条线路信息
        almsNetwork: false
      }
    },
    B: {
      spyPos: null,
      spyPrevPos: null,
      hunterPos: null,
      frozenRounds: 0,
      patrolActive: false,
      patrolRoundsLeft: 0,
      patrolVisitedOuter: [],
      youjingPending: false,
      youjingDiag1: false,
      youjingDiag2: false,
      lastYoujingTeleport: null,
      lastDogDirections: [],
      cards: {
        '差役成群': 0,
        '幽径暗道': 0,
        '耳目线报': 0,
        '追猎犬': 0
      },
      hidden: {
        undergroundNetwork: false,
        hunterIntuition: false,
        almsNetwork: false
      }
    },

    // 事件日志（带可见性）
    // vis: 'ALL' | 'REF' | 'A' | 'B'
    log: []
  };
}

function nowIso() {
  return new Date().toISOString();
}

function addLog(state, { text, vis = 'ALL' }) {
  state.log.push({ t: nowIso(), vis, text });
}

const BASE_CARDS = ['差役成群', '幽径暗道', '耳目线报', '追猎犬'];

function randomStartingHand() {
  const cards = { '差役成群': 0, '幽径暗道': 0, '耳目线报': 0, '追猎犬': 0 };
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(Math.random() * BASE_CARDS.length);
    cards[BASE_CARDS[idx]] += 1;
  }
  return cards;
}

function formatCardSummary(cards) {
  return Object.entries(cards)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join('，') || '无';
}

function inBounds(r, c) {
  return r >= 0 && r < 3 && c >= 0 && c < 3;
}

// 与最早裁判版一致的地名
const CELL_NAMES = [
  ["池塘", "红树", "马车"],
  ["药店", "塔楼", "浴室"],
  ["小桥", "水井", "米奇不妙屋"]
];

function posName(pos) {
  if (!pos) return "未部署";
  return CELL_NAMES[pos.r][pos.c];
}


function posEq(a, b) {
  return !!(a && b && a.r === b.r && a.c === b.c);
}

function isCorner(pos) {
  return !!(pos && (pos.r === 0 || pos.r === 2) && (pos.c === 0 || pos.c === 2));
}

function isOuterCell(pos) {
  if (!pos) return false;
  return pos.r === 0 || pos.r === 2 || pos.c === 0 || pos.c === 2;
}

function outerKey(pos) {
  return `${pos.r},${pos.c}`;
}

function getAdj4(from, to) {
  const dr = Math.abs(to.r - from.r);
  const dc = Math.abs(to.c - from.c);
  return dr + dc === 1;
}

function getAdj8(from, to) {
  const dr = Math.abs(to.r - from.r);
  const dc = Math.abs(to.c - from.c);
  const cheb = Math.max(dr, dc);
  return cheb === 1 && !(dr === 0 && dc === 0);
}

function isDiagTeleport(from, to) {
  if (!from || !to) return false;
  const pairs = [
    { a: { r: 0, c: 0 }, b: { r: 2, c: 2 } },
    { a: { r: 2, c: 2 }, b: { r: 0, c: 0 } },
    { a: { r: 0, c: 2 }, b: { r: 2, c: 0 } },
    { a: { r: 2, c: 0 }, b: { r: 0, c: 2 } }
  ];
  return pairs.some(p => p.a.r === from.r && p.a.c === from.c && p.b.r === to.r && p.b.c === to.c);
}

function checkVictoryImmediate(state) {
  // 完全参照最早裁判版：追捕者落点=敌方间谍位置 -> 立刻结束
  if (state.A.hunterPos && state.B.spyPos && posEq(state.A.hunterPos, state.B.spyPos)) {
    return { winner: 'A', reason: 'capture' };
  }
  if (state.B.hunterPos && state.A.spyPos && posEq(state.B.hunterPos, state.A.spyPos)) {
    return { winner: 'B', reason: 'capture' };
  }
  return null;
}

function endGame(state, victory) {
  state.over = true;
  state.gameOver = victory;
  addLog(state, { text: `R${state.round} · 抓捕成功：${victory.winner} 方抓到敌方间谍，游戏结束。`, vis: 'ALL' });
}

function applyMove(state, side, piece, to) {
  if (!state.started) return { ok: false, err: '请等待裁判开始游戏。' };
  if (state.over) return { ok: false, err: '游戏已结束。' };
  if (side !== 'A' && side !== 'B') return { ok: false, err: '非法阵营。' };
  const p = state[side];
  const oppSide = side === 'A' ? 'B' : 'A';
  const opp = state[oppSide];
  if (p.frozenRounds > 0) return { ok: false, err: '你已被【宵禁令】影响，本回合无法行动。' };

  if (!to || !Number.isInteger(to.r) || !Number.isInteger(to.c) || !inBounds(to.r, to.c)) {
    return { ok: false, err: '目标格子非法。' };
  }

  // 每阶段每方最多行动 1 次（裁判版口径）
  if (state.movesThisPhase[side] >= 1) {
    return { ok: false, err: '本阶段你已经行动过一次。' };
  }

  if (state.phase === 'deploy') {
    if (piece !== 'spy') return { ok: false, err: '部署阶段只能移动间谍。' };

    const from = p.spyPos;
    const first = from == null;

    if (first) {
      p.spyPrevPos = null;
      p.spyPos = { r: to.r, c: to.c };
      state.movesThisPhase[side] += 1;
      addLog(state, { text: `R${state.round} · 部署：你部署了间谍。`, vis: side });
      addLog(state, { text: `R${state.round} · 部署：${side}方将间谍部署到【${posName(to)}】。`, vis: 'REF' });
    } else {
      // 幽径暗道：待穿越 + 角->对角
      if (p.youjingPending && isDiagTeleport(from, to)) {
        p.spyPrevPos = { r: from.r, c: from.c };
        p.spyPos = { r: to.r, c: to.c };
        p.youjingPending = false;
        p.lastYoujingTeleport = { from: { ...p.spyPrevPos }, to: { r: to.r, c: to.c }, round: state.round };

        // X 形穿越记录
        if ((from.r === 0 && from.c === 0 && to.r === 2 && to.c === 2) || (from.r === 2 && from.c === 2 && to.r === 0 && to.c === 0)) {
          p.youjingDiag1 = true;
        }
        if ((from.r === 0 && from.c === 2 && to.r === 2 && to.c === 0) || (from.r === 2 && from.c === 0 && to.r === 0 && to.c === 2)) {
          p.youjingDiag2 = true;
        }
        if (p.youjingDiag1 && p.youjingDiag2 && !p.hidden.undergroundNetwork) {
          p.hidden.undergroundNetwork = true;
          addLog(state, { text: `R${state.round} · 隐藏：你完成 X 形穿越，触发【地下网络】！`, vis: side });
          addLog(state, { text: `R${state.round} · 隐藏：${side}方完成 X 形穿越，触发【地下网络】。`, vis: 'REF' });
        }

        state.movesThisPhase[side] += 1;
        addLog(state, { text: `R${state.round} · 幽径暗道：你完成了一次角到对角穿越。`, vis: side });
        addLog(state, { text: `R${state.round} · 幽径暗道：${side}方间谍从【${posName(from)}】穿越到【${posName(to)}】。`, vis: 'REF' });
      } else {
        if (!getAdj4(from, to)) return { ok: false, err: '部署阶段只能十字相邻移动 1 格（除非本回合使用【幽径暗道】从角到对角）。' };
        p.spyPrevPos = { r: from.r, c: from.c };
        p.spyPos = { r: to.r, c: to.c };
        state.movesThisPhase[side] += 1;
        addLog(state, { text: `R${state.round} · 部署：你移动了间谍。`, vis: side });
        addLog(state, { text: `R${state.round} · 部署：${side}方间谍移动到【${posName(to)}】。`, vis: 'REF' });
      }
    }

    // 差役成群：巡逻状态（持续若干“回合”，回合数在回合结算时递减）
    // 这里在每次“部署阶段移动间谍”后：
    // - 记录外围走格
    // - 判断隐藏触发
    // - 记录“巡逻撞见敌方间谍”的日志
    if (p.patrolActive && p.patrolRoundsLeft > 0) {

      // 不间断外围走遍判定（全自动）
      if (isOuterCell(p.spyPos)) {
        const visited = new Set(p.patrolVisitedOuter);
        visited.add(outerKey(p.spyPos));
        p.patrolVisitedOuter = [...visited];

        // 外围 8 格全部走遍 -> 触发宵禁令
        if (visited.size >= 8) {
          // 撕毁敌方全部锦囊 + 冻结 1 回合
          for (const k of Object.keys(opp.cards)) opp.cards[k] = 0;
          opp.frozenRounds = Math.max(opp.frozenRounds, 1);
          addLog(state, { text: `R${state.round} · 隐藏：你达成【差役成群绕城一圈】，触发【宵禁令】！敌方被冻 1 回合。`, vis: side });
          addLog(state, { text: `R${state.round} · 隐藏：${side}方触发【宵禁令】，清空敌方锦囊并冻结 1 回合。`, vis: 'REF' });
          // 触发后结束巡逻
          p.patrolActive = false;
          p.patrolRoundsLeft = 0;
        }
      }

      // 巡逻撞见敌方间谍（仅日志）
      if (posEq(p.spyPos, opp.spyPos)) {
        addLog(state, { text: `R${state.round} · 差役成群：巡逻中撞见敌方间谍所在格！`, vis: side });
        addLog(state, { text: `R${state.round} · 差役成群：${side}方巡逻中撞见敌方间谍。`, vis: 'REF' });
      }

      // 巡逻自然结束：由回合结算（ADVANCE_PHASE 进入下一回合）统一处理
    }

    // 差役成群 BUG 修复：若对手正处于巡逻状态，而我方间谍后来进入/部署到相同格子，
    // 需要让对手也能“撞见”敌方（否则会因先结算导致漏判）。
    if (!p.patrolActive && opp.patrolActive && opp.patrolRoundsLeft > 0 && posEq(p.spyPos, opp.spyPos)) {
      addLog(state, { text: `R${state.round} · 差役成群：巡逻中撞见敌方间谍所在格！`, vis: oppSide });
      addLog(state, { text: `R${state.round} · 差役成群：${oppSide}方巡逻中撞见敌方间谍（由敌方后进入触发）。`, vis: 'REF' });
    }

    // 地下网络：如果对手拥有地下网络，而我方间谍进入四角 -> 通知对手
    if (opp.hidden.undergroundNetwork && isCorner(p.spyPos)) {
      addLog(state, { text: `R${state.round} · 地下网络：你得知敌方出现在四角之一。`, vis: oppSide });
      addLog(state, { text: `R${state.round} · 地下网络：${oppSide}方得知敌方进入四角。`, vis: 'REF' });
    }

    return { ok: true };
  }

  // hunt phase
  if (piece !== 'hunter') return { ok: false, err: '追捕阶段只能部署/移动追捕者。' };
  if (!p.spyPos) return { ok: false, err: '你尚未部署间谍，无法追捕。' };

  // 追捕阶段：合法落点以【我方间谍】为中心的 1 格米字范围（含本格）
  const dr = Math.abs(to.r - p.spyPos.r);
  const dc = Math.abs(to.c - p.spyPos.c);
  if (Math.max(dr, dc) > 1) return { ok: false, err: '追捕阶段只能选择我方间谍周围 1 格（米字），且可选本格。' };

  p.hunterPos = { r: to.r, c: to.c };
  state.movesThisPhase[side] += 1;

  addLog(state, { text: `R${state.round} · 追捕：你移动了追捕者。`, vis: side });
  addLog(state, { text: `R${state.round} · 追捕：${side}方追捕者移动到【${posName(to)}】。`, vis: 'REF' });

  // 猎户直觉：追捕者走到敌方刚离开的格子
  if (p.hidden.hunterIntuition && opp.spyPrevPos && posEq(p.hunterPos, opp.spyPrevPos)) {
    addLog(state, { text: `R${state.round} · 猎户直觉：你感知到敌方刚刚离开这里！`, vis: side });
    addLog(state, { text: `R${state.round} · 猎户直觉：${side}方触发提示。`, vis: 'REF' });
  }

  // 抓捕命中：记录待结算（双方都确认后再结算，允许平局）
  if (opp.spyPos && posEq(p.hunterPos, opp.spyPos)) {
    state.pendingCapture[side] = true;
    // 不向玩家/对手泄露具体原因，仅裁判可见“命中待结算”信息
    addLog(state, { text: `R${state.round} · 结算待定：${side}方追捕者命中敌方间谍（待双方确认后结算）。`, vis: 'REF' });
  }

  return { ok: true };
}

function canAdvancePhase(state) {
  if (!state.started) return { ok: false, err: '请等待裁判开始游戏。' };
  if (state.over) return { ok: false, err: '游戏已结束。' };

  const needA = state.A.frozenRounds <= 0;
  const needB = state.B.frozenRounds <= 0;

  if ((needA && state.movesThisPhase.A === 0) || (needB && state.movesThisPhase.B === 0)) {
    return {
      ok: false,
      err: state.phase === 'deploy'
        ? '部署阶段：所有未被【宵禁令】影响的阵营，都必须至少移动一次间谍后才能进入下一阶段。'
        : '追捕阶段：所有未被【宵禁令】影响的阵营，都必须至少部署/移动一次追捕者后才能进入下一阶段。'
    };
  }
  return { ok: true };
}

function advancePhase(state) {
  const ok = canAdvancePhase(state);
  if (!ok.ok) return ok;

  if (state.over) return { ok: true };

  // 清理阶段计数
  state.cardsUsedThisPhase.A = false;
  state.cardsUsedThisPhase.B = false;
  state.movesThisPhase.A = 0;
  state.movesThisPhase.B = 0;

  if (state.phase === 'deploy') {
    state.phase = 'hunt';
    // 进入追捕阶段时清空待结算抓捕标记
    state.pendingCapture = { A: false, B: false };
    addLog(state, { text: `R${state.round} · 阶段切换：从部署阶段进入追捕阶段。`, vis: 'ALL' });
  } else {
    // 追捕阶段结束：统一结算抓捕（双方都已“确认/行动”后）
    const aHit = !!state.pendingCapture.A;
    const bHit = !!state.pendingCapture.B;
    if (aHit || bHit) {
      if (aHit && bHit) {
        state.over = true;
        state.gameOver = { winner: null, reason: 'draw' };
        addLog(state, { text: `R${state.round} · 抓捕结算：双方均抓捕成功，平局。`, vis: 'ALL' });
      } else {
        const winner = aHit ? 'A' : 'B';
        state.over = true;
        state.gameOver = { winner, reason: 'capture' };
        addLog(state, { text: `R${state.round} · 抓捕结算：${winner} 方抓捕成功，游戏结束。`, vis: 'ALL' });
      }
    }

    // 若已结束，直接返回（不再进入下一回合）
    if (state.over) return { ok: true };

    // 回合结束：追捕者清空、幽径待穿越清空、冻结回合数递减
    state.A.hunterPos = null;
    state.B.hunterPos = null;
    state.A.youjingPending = false;
    state.B.youjingPending = false;

    // 清空待结算抓捕标记（进入下一回合）
    state.pendingCapture = { A: false, B: false };

    if (state.A.frozenRounds > 0) state.A.frozenRounds -= 1;
    if (state.B.frozenRounds > 0) state.B.frozenRounds -= 1;

    // 差役成群：巡逻回合数递减（回合结束时统一结算）
    for (const s of ['A', 'B']) {
      const p = state[s];
      if (p.patrolActive && p.patrolRoundsLeft > 0) {
        p.patrolRoundsLeft -= 1;
        if (p.patrolRoundsLeft <= 0) {
          p.patrolActive = false;
          p.patrolVisitedOuter = [];
          addLog(state, { text: `R${state.round} · 差役成群：${s}方巡逻结束（持续回合到期）。`, vis: 'REF' });
          addLog(state, { text: `R${state.round} · 差役成群：你的巡逻结束。`, vis: s });
        }
      }
    }

    state.round += 1;
    // 进入新回合时，清空“本回合已用锦囊”标记（部署+追捕共用）
    state.cardsUsedThisRound.A = false;
    state.cardsUsedThisRound.B = false;
    state.phase = 'deploy';
    addLog(state, { text: `回合：进入第 ${state.round} 回合（部署阶段）。`, vis: 'ALL' });
  }

  return { ok: true };
}

function applyPlayCard(state, side, cardName, payload) {
  if (!state.started) return { ok: false, err: '请等待裁判开始游戏。' };
  if (state.over) return { ok: false, err: '游戏已结束。' };
  if (side !== 'A' && side !== 'B') return { ok: false, err: '非法阵营。' };
  const p = state[side];
  if (p.frozenRounds > 0) return { ok: false, err: '你已被【宵禁令】冻结，本回合无法行动。' };

  // 一回合=部署+追捕：同一回合内只能使用一次锦囊
  if (state.cardsUsedThisRound[side]) {
    return { ok: false, err: '本回合你已经使用过锦囊（部署+追捕合计一次）。' };
  }

  if (state.cardsUsedThisPhase[side]) {
    return { ok: false, err: '本阶段你已经使用过锦囊。' };
  }

  if (!BASE_CARDS.includes(cardName)) {
    return { ok: false, err: '非法锦囊名称（本体包仅：差役成群 / 幽径暗道 / 耳目线报 / 追猎犬）。' };
  }

  // 阶段限制：部署卡/追捕卡只能在对应阶段使用
  const deployCards = new Set(['差役成群', '幽径暗道']);
  const huntCards = new Set(['耳目线报', '追猎犬']);
  if (state.phase === 'deploy' && !deployCards.has(cardName)) {
    return { ok: false, err: '当前为部署阶段，只能使用【差役成群 / 幽径暗道】。' };
  }
  if (state.phase === 'hunt' && !huntCards.has(cardName)) {
    return { ok: false, err: '当前为追捕阶段，只能使用【耳目线报 / 追猎犬】。' };
  }

  if (!p.cards[cardName] || p.cards[cardName] <= 0) {
    return { ok: false, err: '你没有这张牌。' };
  }

  const oppSide = side === 'A' ? 'B' : 'A';
  const opp = state[oppSide];
  const pl = payload ?? {};

  // 上面已经做过阶段校验，这里只做分发

  // --- 差役成群 ---
  if (cardName === '差役成群') {
    // 若巡逻效果未结束，禁止再次使用（避免叠加/刷新）
    if (p.patrolActive && p.patrolRoundsLeft > 0) {
      return { ok: false, err: '【差役成群】效果尚未结束，不能再次使用。' };
    }

    p.cards[cardName] -= 1;
    state.cardsUsedThisPhase[side] = true;
    state.cardsUsedThisRound[side] = true;

    // 若之前巡逻已断（patrolActive=false），则从头记录外围走格（不间断要求）
    if (!p.patrolActive) p.patrolVisitedOuter = [];
    p.patrolActive = true;
    p.patrolRoundsLeft = 3;

    addLog(state, { text: `R${state.round} · 锦囊：你使用【差役成群】，效果持续 3 回合（期间每回合部署移动将记录外围巡逻）。`, vis: side });
    addLog(state, { text: `R${state.round} · 锦囊：${side}方使用【差役成群】（持续 3 回合）。`, vis: 'REF' });
    return { ok: true };
  }

  // --- 幽径暗道 ---
  if (cardName === '幽径暗道') {
    if (!p.spyPos) return { ok: false, err: '你还没有部署间谍，不能发动【幽径暗道】。' };
    if (!isCorner(p.spyPos)) return { ok: false, err: '【幽径暗道】只能在间谍位于四角时发动。' };

    p.cards[cardName] -= 1;
    state.cardsUsedThisPhase[side] = true;
    state.cardsUsedThisRound[side] = true;
    p.youjingPending = true;

    addLog(state, { text: `R${state.round} · 锦囊：你在角上发动【幽径暗道】，本回合下一次间谍移动可从当前角穿越到对角角。`, vis: side });
    addLog(state, { text: `R${state.round} · 锦囊：${side}方发动【幽径暗道】（待穿越）。`, vis: 'REF' });
    return { ok: true };
  }

  // --- 耳目线报 ---
  if (cardName === '耳目线报') {
    if (!p.spyPos) return { ok: false, err: '请先部署/移动间谍再使用【耳目线报】。' };
    if (!opp.spyPos) return { ok: false, err: '对手尚未部署间谍，【耳目线报】无可侦查目标。' };

    const dir = String(pl.dir ?? '').toUpperCase();
    const dirMap = {
      N: { dr: -1, dc: 0 }, S: { dr: 1, dc: 0 }, W: { dr: 0, dc: -1 }, E: { dr: 0, dc: 1 },
      NW: { dr: -1, dc: -1 }, NE: { dr: -1, dc: 1 }, SW: { dr: 1, dc: -1 }, SE: { dr: 1, dc: 1 }
    };
    if (!dirMap[dir]) return { ok: false, err: '方向输入有误（N/S/E/W/NE/NW/SE/SW）。' };

    // 隐藏效果：拿钱办事 -> 丐帮情报网络（一次性永久）
    let activatedAlms = false;
    let discarded = null;
    if (!p.hidden.almsNetwork && pl.wantAlms) {
      const discardName = String(pl.discardCard ?? '').trim();
      if (!discardName) {
        // 不强制失败：只是不发动隐藏效果
      } else if (discardName === '耳目线报') {
        // 不允许弃本次使用的牌
      } else if ((p.cards[discardName] || 0) <= 0) {
        // 无此牌
      } else {
        p.cards[discardName] -= 1;
        p.hidden.almsNetwork = true;
        activatedAlms = true;
        discarded = discardName;
      }
    }

    p.cards[cardName] -= 1;
    state.cardsUsedThisPhase[side] = true;
    state.cardsUsedThisRound[side] = true;

    const v = dirMap[dir];
    const origin = p.spyPos;
    /** @type {{r:number,c:number}[]} */
    const cells = [];

    if (p.hidden.almsNetwork) {
      // 整条线：含原点 + 两侧
      cells.push({ r: origin.r, c: origin.c });
      let rr = origin.r + v.dr, cc = origin.c + v.dc;
      while (inBounds(rr, cc)) {
        cells.push({ r: rr, c: cc });
        rr += v.dr; cc += v.dc;
      }
      rr = origin.r - v.dr; cc = origin.c - v.dc;
      while (inBounds(rr, cc)) {
        cells.push({ r: rr, c: cc });
        rr -= v.dr; cc -= v.dc;
      }
    } else {
      // 前方线：不含原点
      let rr = origin.r + v.dr, cc = origin.c + v.dc;
      while (inBounds(rr, cc)) {
        cells.push({ r: rr, c: cc });
        rr += v.dr; cc += v.dc;
      }
    }

    const found = cells.some(pos => posEq(pos, opp.spyPos));

    if (p.hidden.almsNetwork) {
      addLog(state, { text: `R${state.round} · 锦囊：你使用【耳目线报+丐帮情报网络】侦查方向 ${dir} 整条线，结果：${found ? '发现敌方踪迹。' : '未见可疑。'}`, vis: side });
    } else {
      addLog(state, { text: `R${state.round} · 锦囊：你使用【耳目线报】侦查方向 ${dir} 前方，结果：${found ? '前方线路存在敌方踪迹。' : '前方未发现敌人。'}`, vis: side });
    }

    if (activatedAlms) {
      // 玩家侧不暴露弃置具体牌名（你要求“手牌只给裁判”）
      addLog(state, { text: `R${state.round} · 隐藏：你额外弃置 1 张卡牌发动【拿钱办事】，获得【丐帮情报网络】。`, vis: side });
      addLog(state, { text: `R${state.round} · 隐藏：${side}方弃置【${discarded}】发动【拿钱办事】，获得【丐帮情报网络】。`, vis: 'REF' });
    }

    addLog(state, { text: `R${state.round} · 锦囊：${side}方使用【耳目线报】 dir=${dir} alms=${p.hidden.almsNetwork} found=${found} payload=${JSON.stringify(pl)}`, vis: 'REF' });
    return { ok: true };
  }

  // --- 追猎犬 ---
  if (cardName === '追猎犬') {
    if (!p.spyPos || !opp.spyPos) return { ok: false, err: '需双方都已部署间谍，才能使用【追猎犬】。' };

    p.cards[cardName] -= 1;
    state.cardsUsedThisPhase[side] = true;
    state.cardsUsedThisRound[side] = true;

    const o = p.spyPos;
    const t = opp.spyPos;
    const dirMain = (from, to) => {
      const dr = to.r - from.r;
      const dc = to.c - from.c;
      if (dr === 0 && dc === 0) return '脚下';
      if (Math.abs(dr) >= Math.abs(dc)) return dr > 0 ? '南' : '北';
      return dc > 0 ? '东' : '西';
    };

    const base = dirMain(o, t);

    if (opp.lastYoujingTeleport && opp.lastYoujingTeleport.round === state.round) {
      const d1 = dirMain(o, opp.lastYoujingTeleport.from);
      const d2 = dirMain(o, opp.lastYoujingTeleport.to);
      // 玩家侧不透露“对手用了什么牌”，只给出结算结果（两个矛盾方向）
      addLog(state, { text: `R${state.round} · 锦囊：你使用【追猎犬】，得到两个矛盾方向线索：${d1} 与 ${d2}。`, vis: side });
      addLog(state, { text: `R${state.round} · 锦囊：${side}方追猎犬受幽径影响，输出 ${d1}/${d2}。`, vis: 'REF' });
    } else {
      addLog(state, { text: `R${state.round} · 锦囊：你使用【追猎犬】，得到线索：敌方大致在你的 ${base} 方。`, vis: side });
      addLog(state, { text: `R${state.round} · 锦囊：${side}方使用追猎犬，base=${base}。`, vis: 'REF' });
    }

    p.lastDogDirections.push(base);
    if (p.lastDogDirections.length > 2) p.lastDogDirections.shift();

    if (p.lastDogDirections.length === 2 && p.lastDogDirections[0] === p.lastDogDirections[1]) {
      if (!p.hidden.hunterIntuition) {
        p.hidden.hunterIntuition = true;
        addLog(state, { text: `R${state.round} · 隐藏：你的追猎犬连续两次指向同一方向，触发【猎户直觉】。`, vis: side });
        addLog(state, { text: `R${state.round} · 隐藏：${side}方触发【猎户直觉】。`, vis: 'REF' });
      }
    }

    return { ok: true };
  }

  return { ok: false, err: '未实现的锦囊。' };
}

function maskForRole(state, role, seat) {
  // seat: 'A'|'B'|null
  // role: 'REF'|'SPECTATOR'|'A'|'B'
  if (role === 'REF' || role === 'SPECTATOR') {
    return {
      kind: 'ref_view',
      truth: state,
      log: state.log
    };
  }

  const side = seat; // 'A' or 'B'
  const opp = side === 'A' ? 'B' : 'A';

  // 玩家视图：对方位置/手牌不下发
  return {
    kind: 'player_view',
    side,
    started: state.started,
    round: state.round,
    phase: state.phase,
    over: state.over,
    gameOver: state.gameOver,
    movesThisPhase: { [side]: state.movesThisPhase[side] },
    cardsUsedThisPhase: { [side]: state.cardsUsedThisPhase[side] },
    cardsUsedThisRound: { [side]: state.cardsUsedThisRound[side] },
    self: {
      spyPos: state[side].spyPos,
      hunterPos: state[side].hunterPos,
      frozenRounds: state[side].frozenRounds,
      cards: state[side].cards,
      // 自己的隐藏效果/状态自己当然知道
      hidden: state[side].hidden,
      patrolActive: state[side].patrolActive,
      patrolRoundsLeft: state[side].patrolRoundsLeft,
      patrolVisitedOuter: state[side].patrolVisitedOuter,
      youjingPending: state[side].youjingPending
    },
    // 为了 UI 提示“对方是否被冻结”等也不下发（避免侧信道）
    // 你若未来想让玩家知道“对方被冻结”，可以改成只在规则允许时透出。

    log: state.log.filter(e => e.vis === 'ALL' || e.vis === side)
  };
}

/**
 * Room structure:
 * {
 *   code,
 *   createdAt,
 *   hostToken,
 *   refToken,
 *   seats: { A: token|null, B: token|null, REF: token|null },
 *   clients: Map<token, { ws, nick, role, seat }>,
 *   state: truthState
 * }
 */

const rooms = new Map();

function getRoom(code) {
  return rooms.get(code);
}

function broadcastRoom(room) {
  for (const [token, c] of room.clients.entries()) {
    if (c.ws.readyState !== 1) continue;

    const view = maskForRole(room.state, c.role, c.seat);
    const roster = [...room.clients.entries()].map(([t, cc]) => ({
      token: t,
      nick: cc.nick,
      role: cc.role,
      seat: cc.seat
    }));

    c.ws.send(JSON.stringify({
      type: 'ROOM_SNAPSHOT',
      room: {
        code: room.code,
        hostToken: room.hostToken,
        refToken: room.refToken,
        seats: room.seats
      },
      self: { token, nick: c.nick, role: c.role, seat: c.seat },
      roster,
      view
    }));
  }
}

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

function makeRoom() {
  let code = randCode(6);
  while (rooms.has(code)) code = randCode(6);

  const room = {
    code,
    createdAt: Date.now(),
    hostToken: null,
    refToken: null,
    seats: { A: null, B: null, REF: null },
    clients: new Map(),
    state: defaultTruthState(),
    emptySince: null
  };
  rooms.set(code, room);
  return room;
}

function cleanupRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.clients.size > 0) {
      room.emptySince = null;
      continue;
    }
    if (room.emptySince == null) room.emptySince = now;
    // 空房间 10 分钟销毁
    if (now - room.emptySince > 10 * 60 * 1000) rooms.delete(code);
  }
}
setInterval(cleanupRooms, 30 * 1000);

function ensureHostAndRef(room, token) {
  // 第一个进房间的人自动当 Host + Ref
  if (!room.hostToken) room.hostToken = token;
  if (!room.refToken) room.refToken = token;
  if (!room.seats.REF) room.seats.REF = token;
}

function assignRoleFromSeats(room, token) {
  const seatA = room.seats.A === token;
  const seatB = room.seats.B === token;
  const seatR = room.seats.REF === token;

  if (seatR) return { role: 'REF', seat: null };
  if (seatA) return { role: 'A', seat: 'A' };
  if (seatB) return { role: 'B', seat: 'B' };
  return { role: 'SPECTATOR', seat: null };
}

function mustBeHost(room, token) {
  return room.hostToken === token;
}

function mustBeRef(room, token) {
  return room.refToken === token;
}

wss.on('connection', (ws) => {
  const sessionToken = newToken();

  // 先给客户端一个 sessionToken；客户端也会提供自己的 clientToken（用于重连）
  send(ws, { type: 'HELLO', sessionToken });

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf-8'));
    } catch {
      send(ws, { type: 'ERROR', message: '消息格式错误（非 JSON）。' });
      return;
    }

    const type = msg?.type;

    // --- 连接/加入/创建 ---
    if (type === 'CREATE_ROOM') {
      const nickRaw = msg?.nick;
      const clientToken = msg?.clientToken || newToken();

      const room = makeRoom();
      const nick = clampNick(nickRaw);

      // 记录 client
      room.clients.set(clientToken, { ws, nick, role: 'SPECTATOR', seat: null });
      ensureHostAndRef(room, clientToken);
      const rr = assignRoleFromSeats(room, clientToken);
      room.clients.get(clientToken).role = rr.role;
      room.clients.get(clientToken).seat = rr.seat;

      // 初始化日志
      addLog(room.state, { text: `房间创建成功。房间号：${room.code}`, vis: 'ALL' });

      send(ws, { type: 'ROOM_CREATED', roomCode: room.code, clientToken });
      broadcastRoom(room);
      return;
    }

    if (type === 'JOIN_ROOM') {
      const roomCode = String(msg?.roomCode ?? '').trim().toUpperCase();
      const nickRaw = msg?.nick;
      const clientToken = msg?.clientToken || newToken();

      const room = getRoom(roomCode);
      if (!room) {
        send(ws, { type: 'ERROR', message: '房间不存在或已关闭。' });
        return;
      }

      // 昵称去重
      const taken = new Set([...room.clients.values()].map(c => c.nick));
      const desired = clampNick(nickRaw);
      const nick = uniqNick(desired, taken);

      room.clients.set(clientToken, { ws, nick, role: 'SPECTATOR', seat: null });
      ensureHostAndRef(room, clientToken);

      const rr = assignRoleFromSeats(room, clientToken);
      room.clients.get(clientToken).role = rr.role;
      room.clients.get(clientToken).seat = rr.seat;

      addLog(room.state, { text: `${nick} 加入了房间。`, vis: 'ALL' });

      send(ws, { type: 'ROOM_JOINED', roomCode: room.code, clientToken });
      broadcastRoom(room);
      return;
    }

    // 之后的消息都需要 roomCode + clientToken
    const roomCode = String(msg?.roomCode ?? '').trim().toUpperCase();
    const clientToken = String(msg?.clientToken ?? '').trim();
    const room = getRoom(roomCode);
    if (!room || !room.clients.has(clientToken)) {
      send(ws, { type: 'ERROR', message: '未加入房间或房间不存在。' });
      return;
    }

    const client = room.clients.get(clientToken);
    client.ws = ws; // 允许重连后复用 token

    // --- Host 管理 ---
    if (type === 'HOST_ASSIGN_SEAT') {
      if (!mustBeHost(room, clientToken)) {
        send(ws, { type: 'ERROR', message: '只有房主可以分配席位。' });
        return;
      }
      const targetToken = String(msg?.targetToken ?? '').trim();
      const seat = msg?.seat; // 'A'|'B'|'REF'|'SPECTATOR'
      if (!room.clients.has(targetToken)) {
        send(ws, { type: 'ERROR', message: '目标玩家不在房间里。' });
        return;
      }

      // 清理旧占座
      if (seat === 'A' || seat === 'B' || seat === 'REF') {
        // seat 被别人占用则挤掉（变观众）
        const current = room.seats[seat];
        if (current && room.clients.has(current)) {
          const cc = room.clients.get(current);
          cc.role = 'SPECTATOR';
          cc.seat = null;
        }
      }

      // 先把 target 从所有 seat 移除
      for (const k of ['A', 'B', 'REF']) {
        if (room.seats[k] === targetToken) room.seats[k] = null;
      }

      if (seat === 'A' || seat === 'B') {
        room.seats[seat] = targetToken;
      } else if (seat === 'REF') {
        room.seats.REF = targetToken;
        room.refToken = targetToken;
      } else {
        // spectator
      }

      // 重新计算所有人 role
      for (const [t, cc] of room.clients.entries()) {
        const rr = assignRoleFromSeats(room, t);
        cc.role = rr.role;
        cc.seat = rr.seat;
      }

      addLog(room.state, { text: `房主调整席位分配。`, vis: 'ALL' });
      broadcastRoom(room);
      return;
    }

    if (type === 'HOST_TRANSFER') {
      if (!mustBeHost(room, clientToken)) {
        send(ws, { type: 'ERROR', message: '只有房主可以转移房主权限。' });
        return;
      }
      const targetToken = String(msg?.targetToken ?? '').trim();
      if (!room.clients.has(targetToken)) {
        send(ws, { type: 'ERROR', message: '目标玩家不在房间里。' });
        return;
      }
      // 你要求：转移房主 = 指定对方为裁判，并且自己失权
      room.hostToken = targetToken;
      room.refToken = targetToken;
      room.seats.REF = targetToken;

      // 把原 host 从 REF seat 挤出（如果他是 REF）
      // 同时不强制他必须离开 A/B seat（但一般你会让他当观众）
      const prev = clientToken;
      if (room.seats.A === targetToken || room.seats.B === targetToken) {
        // ok
      }
      // 如果 target 原来在 A/B seat，也允许他继续在 A/B 的同时担任裁判？
      // 为避免混乱：当 REF 时默认取消 A/B seat。
      if (room.seats.A === targetToken) room.seats.A = null;
      if (room.seats.B === targetToken) room.seats.B = null;

      for (const [t, cc] of room.clients.entries()) {
        const rr = assignRoleFromSeats(room, t);
        cc.role = rr.role;
        cc.seat = rr.seat;
      }

      addLog(room.state, { text: `房主已转移。新的裁判/房主已接管。`, vis: 'ALL' });
      broadcastRoom(room);
      return;
    }

    if (type === 'KICK_MEMBER') {
      if (!mustBeHost(room, clientToken)) {
        send(ws, { type: 'ERROR', message: '只有房主可以踢人。' });
        return;
      }
      const targetToken = String(msg?.targetToken ?? '').trim();
      if (!targetToken || !room.clients.has(targetToken)) {
        send(ws, { type: 'ERROR', message: '目标玩家不在房间里。' });
        return;
      }
      if (targetToken === room.hostToken) {
        send(ws, { type: 'ERROR', message: '不能踢出房主。' });
        return;
      }

      const target = room.clients.get(targetToken);
      const targetNick = target?.nick || '玩家';

      // 清空席位（如果占座）
      for (const k of ['A', 'B', 'REF']) {
        if (room.seats[k] === targetToken) room.seats[k] = null;
      }

      // 如果踢掉的是裁判，则把裁判权限回收给房主（房主默认裁判）
      if (room.refToken === targetToken) {
        room.refToken = room.hostToken;
        room.seats.REF = room.hostToken;
      }

      // 先通知并断开目标连接
      try {
        send(target.ws, { type: 'KICKED', message: '你已被房主移出房间。' });
      } catch {}
      try {
        target.ws.close();
      } catch {}

      // 从 roster 移除（允许其稍后重新加入：不做 ban）
      room.clients.delete(targetToken);

      // 重新计算所有人 role
      for (const [t, cc] of room.clients.entries()) {
        const rr = assignRoleFromSeats(room, t);
        cc.role = rr.role;
        cc.seat = rr.seat;
      }

      addLog(room.state, { text: `房主将 ${targetNick} 移出了房间。`, vis: 'ALL' });
      broadcastRoom(room);
      return;
    }

    // --- 游戏控制 ---
    if (type === 'START_GAME') {
      if (!mustBeRef(room, clientToken)) {
        send(ws, { type: 'ERROR', message: '只有裁判可以开始/重置游戏。' });
        return;
      }
      room.state = defaultTruthState();
      room.state.started = true;
      // 开局：双方各获得 4 张随机本体卡（两方独立随机）
      room.state.A.cards = randomStartingHand();
      room.state.B.cards = randomStartingHand();

      addLog(room.state, { text: '游戏已开始/重置。', vis: 'ALL' });
      // 起手牌只对裁判与各自玩家可见（对对方不可见）
      addLog(room.state, { text: `A 起手牌：${formatCardSummary(room.state.A.cards)}`, vis: 'REF' });
      addLog(room.state, { text: `B 起手牌：${formatCardSummary(room.state.B.cards)}`, vis: 'REF' });
      addLog(room.state, { text: `你获得了 4 张随机锦囊：${formatCardSummary(room.state.A.cards)}`, vis: 'A' });
      addLog(room.state, { text: `你获得了 4 张随机锦囊：${formatCardSummary(room.state.B.cards)}`, vis: 'B' });
      broadcastRoom(room);
      return;
    }

    if (type === 'ADVANCE_PHASE') {
      if (!mustBeRef(room, clientToken)) {
        send(ws, { type: 'ERROR', message: '只有裁判可以推进阶段。' });
        return;
      }
      if (!room.state.started) {
        send(ws, { type: 'ERROR', message: '请先开始游戏。' });
        return;
      }
      const res = advancePhase(room.state);
      if (!res.ok) {
        send(ws, { type: 'ERROR', message: res.err });
        return;
      }
      broadcastRoom(room);
      return;
    }

    // --- 玩家动作 ---
    if (type === 'MOVE') {
      const piece = msg?.piece; // 'spy'|'hunter'
      const to = msg?.to;

      if (!room.state.started) {
        send(ws, { type: 'ERROR', message: '请等待裁判开始游戏。' });
        return;
      }

      if (client.role !== 'A' && client.role !== 'B') {
        send(ws, { type: 'ERROR', message: '只有玩家可以移动。' });
        return;
      }
      const side = client.role;
      const res = applyMove(room.state, side, piece, to);
      if (!res.ok) {
        send(ws, { type: 'ERROR', message: res.err });
        return;
      }
      broadcastRoom(room);
      return;
    }

    if (type === 'PLAY_CARD') {
      const cardName = String(msg?.cardName ?? '').trim();
      const payload = msg?.payload;

      if (!room.state.started) {
        send(ws, { type: 'ERROR', message: '请等待裁判开始游戏。' });
        return;
      }

      if (client.role !== 'A' && client.role !== 'B') {
        send(ws, { type: 'ERROR', message: '只有玩家可以使用锦囊。' });
        return;
      }
      const side = client.role;
      const res = applyPlayCard(room.state, side, cardName, payload);
      if (!res.ok) {
        send(ws, { type: 'ERROR', message: res.err });
        return;
      }
      broadcastRoom(room);
      return;
    }

    send(ws, { type: 'ERROR', message: `未知消息类型：${type}` });
  });

  ws.on('close', () => {
    // 断线：从 roster 移除该连接对应的 client。
    for (const room of rooms.values()) {
      let removedAny = false;
      for (const [token, c] of room.clients.entries()) {
        if (c.ws !== ws) continue;

        room.clients.delete(token);
        removedAny = true;
        addLog(room.state, { text: `${c.nick} 离开了房间。`, vis: 'ALL' });
      }
      if (removedAny) {
        // 重新计算 role（seat 仍在，但人暂时不在 roster）
        for (const [t, cc] of room.clients.entries()) {
          const rr = assignRoleFromSeats(room, t);
          cc.role = rr.role;
          cc.seat = rr.seat;
        }
        broadcastRoom(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`beiguo-online listening on http://localhost:${PORT}`);
});
