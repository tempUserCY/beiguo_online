import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

/**
 * 北国密令 - 联机服务器
 * - 房间号系统生成
 * - 房主（Host）始终保留在线列表管理能力，可移交 Host（移交即失去房主权限）
 * - 可选裁判：
 *    - 当在线列表分配了“裁判”席位（REF）时：沿用裁判制流程（裁判开始/推进阶段）。
 *    - 当未分配裁判席位时：进入“自动裁判”模式（房主可开始；阶段按规则自动推进）。
 * - 裁判/观众可上帝视角；玩家仅见自己视图
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
    // 仅用于裁判/观众视角日志第三方展示（不会下发给对方玩家的私密信息）
    seatNicks: { A: '', B: '' },
    round: 1,
    // 回合结构：部署出牌 -> 部署移动 -> 抓捕出牌 -> 抓捕移动 -> 下一回合
    phase: 'deploy_card',
    started: false,
    over: false,
    gameOver: null,
    // 追捕阶段：双方“确认”后统一结算抓捕，避免先手优势
    pendingCapture: { A: false, B: false },

    // 每阶段每方必须至少移动一次（没被宵禁）
    movesThisPhase: { A: 0, B: 0 },
    cardsUsedThisPhase: { A: false, B: false },
    // 每“大回合”（部署出牌 + 抓捕出牌）每方只能用 1 次锦囊
    cardsUsedThisRound: { A: false, B: false },
    // 出牌阶段：每方需要做一次“出牌或跳过”的决策（没被宵禁）
    cardDecisionThisPhase: { A: false, B: false },

    A: {
      spyPos: null,
      spyPrevPos: null,
      hunterPos: null,
      frozenRounds: 0,
      // 差役成群
      patrolActive: false,
      patrolRoundsLeft: 0,
      patrolVisitedOuter: [],
      patrolResolvePending: false,
      // 差役成群：巡逻撞见提示（延迟到“抓捕阶段结束”再显示）
      patrolHitPending: false,
      patrolHitLoc: null,
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
      patrolResolvePending: false,
      // 差役成群：巡逻撞见提示（延迟到“抓捕阶段结束”再显示）
      patrolHitPending: false,
      patrolHitLoc: null,
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

function addLog(state, entry) {
  const { text, vis = 'ALL', kind = 'LOG', ...rest } = entry || {};
  state.log.push({ t: nowIso(), vis, kind, text, ...rest });
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

// 结局剧情（先内置 4 种；未来可扩展到 9 种）
const ENDING_STORIES = {
  '池塘': 'XXX从身后慢慢接近毫无防备的神秘黑影，瞬时间ta扑了上去将那黑影摁到在池塘里，过了不知多久，那黑影没了动作，XXX在人群围上来前偷偷的离开了......',
  '红树': 'XXX在红树上不知呆了多久，正当ta又快打瞌睡时ta等待的目标终于来了，XXX小心翼翼地用吹管瞄准了那马上的神秘黑影，只听到微小的砰的一声，马上的黑影下意识摸了摸后背，忽然浑身颤抖，僵硬的坠下了马，XXX顺势从树上跳到了马背上后扬长而去......',
  '马车': '车夫将马车卸载在了路边，找饭摊吃饭去了，就这样马车似乎在路边无人问津。过了不知多久，一个神秘的人影小心的凑到了马车旁脸色紧张的对暗号，但马车似乎并没有回应。正当黑影准备探头往马车里看时，月影下血光飞溅，银刃从黑影的脖颈处穿梭而过。马车里的XXX冷漠的看了眼尸体，顺着摊位的人群消失了......',
  // 盘面是“药店”，剧情用“药房”文案；做兼容映射
  '药店': '药房里的来了位神秘客人，似乎不断地咳嗽着。他请求到大夫尽快配药，自己的身体似乎极度不适。那大夫没说话，只是眼神示意着不要着急，随后那大夫暗示着想请客人去二楼诊所把脉。那客人晃晃悠悠的准备跟上去时，在阶梯的尽头突然失去了意识，一路从楼梯上滚了下来，似乎是断了气，正当店里的人围着神秘客人看时，那大夫在二楼卸下了伪装，将蒙汗药扔向了煎药炉里，从二楼窗口离开了。',
  '药房': '药房里的来了位神秘客人，似乎不断地咳嗽着。他请求到大夫尽快配药，自己的身体似乎极度不适。那大夫没说话，只是眼神示意着不要着急，随后那大夫暗示着想请客人去二楼诊所把脉。那客人晃晃悠悠的准备跟上去时，在阶梯的尽头突然失去了意识，一路从楼梯上滚了下来，似乎是断了气，正当店里的人围着神秘客人看时，那大夫在二楼卸下了伪装，将蒙汗药扔向了煎药炉里，从二楼窗口离开了。'
};

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

  // 出牌阶段不允许移动
  if (state.phase === 'deploy_card' || state.phase === 'hunt_card') {
    return { ok: false, err: '当前为出牌阶段，不能移动棋子。' };
  }

  if (state.phase === 'deploy_move') {
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
          addLog(state, { text: `R${state.round} · 隐藏：你完成 X 形穿越，触发【地下网络】！`, vis: side, kind: 'HIDDEN_RESULT' });
          addLog(state, { text: `R${state.round} · 隐藏：${side}方完成 X 形穿越，触发【地下网络】。`, vis: 'REF', kind: 'HIDDEN_RESULT' });
        }

        state.movesThisPhase[side] += 1;
        addLog(state, { text: `R${state.round} · 幽径暗道：你完成了一次角到对角穿越。`, vis: side, kind: 'CARD_RESULT' });
        addLog(state, { text: `R${state.round} · 幽径暗道：${side}方间谍从【${posName(from)}】穿越到【${posName(to)}】。`, vis: 'REF', kind: 'CARD_RESULT' });
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

    // 猎户直觉（部署阶段触发）与地下网络（敌入四角提示）
    // 均应在【部署阶段结束】统一判定，确保双方都已更新到“本回合最新位置”，
    // 避免用到对手尚未行动时的旧 spyPrevPos。
    if (p.patrolActive && p.patrolRoundsLeft > 0) {

      // 不间断外围走遍判定（全自动）
      if (isOuterCell(p.spyPos)) {
        const visited = new Set(p.patrolVisitedOuter);
        visited.add(outerKey(p.spyPos));
        p.patrolVisitedOuter = [...visited];

        // 外围 8 格全部走遍（允许跨多张【差役成群】累计） -> 记录“可结算宵禁令”（按新回合结构：在下一次【部署阶段出牌】才结算）
        if (visited.size >= 8 && !p.patrolResolvePending) {
          p.patrolResolvePending = true;
          addLog(state, { text: `R${state.round} · 差役成群：你已完成绕城一圈（宵禁令将于下一次【部署阶段出牌】结算）。`, vis: side, kind: 'CARD_RESULT' });
          addLog(state, { text: `R${state.round} · 差役成群：${side}方完成绕城一圈（宵禁令待结算）。`, vis: 'REF', kind: 'CARD_RESULT' });
        }
      }

      // 巡逻撞见敌方间谍（仅日志）
      if (posEq(p.spyPos, opp.spyPos)) {
        // 注意：提示延迟到“抓捕阶段结束”再显示（避免部署阶段直接暴露）
        p.patrolHitPending = true;
        p.patrolHitLoc = posName(p.spyPos);
      }

      // 巡逻自然结束：由回合结算（ADVANCE_PHASE 进入下一回合）统一处理
    }

    // 差役成群 BUG 修复：若对手正处于巡逻状态，而我方间谍后来进入/部署到相同格子，
    // 需要让对手也能“撞见”敌方（否则会因先结算导致漏判）。
    if (!p.patrolActive && opp.patrolActive && opp.patrolRoundsLeft > 0 && posEq(p.spyPos, opp.spyPos)) {
      // 同样延迟提示到“抓捕阶段结束”
      opp.patrolHitPending = true;
      opp.patrolHitLoc = posName(opp.spyPos);
    }

    // 地下网络提示同上：延后到部署阶段结束统一判定。

    return { ok: true };
  }

  // hunt move phase
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

  // 猎户直觉只与【间谍位置】有关：不在追捕者移动时触发。
  // 统一在「部署阶段结束 → 进入抓捕阶段卡牌」的结算点判定。

  // 抓捕命中：记录待结算（双方都确认后再结算，允许平局）
  if (opp.spyPos && posEq(p.hunterPos, opp.spyPos)) {
    state.pendingCapture[side] = true;
    // 不向玩家/对手泄露具体原因，仅裁判可见“命中待结算”信息
    addLog(state, { text: `R${state.round} · 结算待定：${side}方追捕者命中敌方间谍（待双方确认后结算）。`, vis: 'REF' });
  }

  return { ok: true };
}

// 部署阶段结束统一判定：
// - 地下网络：敌方“本回合部署结束后”若出现在四角之一，则提示 BUFF 持有者
// - 猎户直觉：敌方“本回合离开的格子”(spyPrevPos) 与我方“本回合最终间谍位置”(spyPos) 重合，则提示我方
// 目的：确保双方都已更新到“本回合最新位置”，避免使用对手尚未行动时的旧 spyPrevPos。
function resolveDeployEndHidden(state) {
  if (state.phase !== 'deploy_move') return;
  if (!state.started || state.over) return;

  for (const s of ['A', 'B']) {
    const p = state[s];
    const oppSide = s === 'A' ? 'B' : 'A';
    const opp = state[oppSide];

    // 若对手本回合没有在部署阶段行动（例如被冻结），不要用旧 spyPrevPos/spyPos 做判定
    if (state.movesThisPhase?.[oppSide] !== 1) {
      continue;
    }

    // 地下网络：若我方拥有地下网络，且敌方“本回合部署结束后”出现在四角之一（且确实是本回合进入/部署到该角），提示我方
    if (p.hidden.undergroundNetwork && opp.spyPos && isCorner(opp.spyPos)) {
      const enteredThisTurn = !opp.spyPrevPos || !posEq(opp.spyPrevPos, opp.spyPos);
      if (enteredThisTurn) {
        addLog(state, { text: `R${state.round} · 地下网络：你得知敌方出现在四角之一。`, vis: s, kind: 'HIDDEN_RESULT' });
        addLog(state, { text: `R${state.round} · 地下网络：${s}方得知敌方进入四角。`, vis: 'REF', kind: 'HIDDEN_RESULT' });
      }
    }

    // 猎户直觉（部署阶段结束）：敌方刚离开的格子 == 我方最终间谍位置
    if (p.hidden.hunterIntuition && opp.spyPrevPos && p.spyPos && posEq(p.spyPos, opp.spyPrevPos)) {
      addLog(state, { text: `R${state.round} · 猎户直觉：你感知到敌方刚刚离开这里！`, vis: s, kind: 'HIDDEN_RESULT' });
      addLog(state, { text: `R${state.round} · 猎户直觉：${s}方触发提示。`, vis: 'REF', kind: 'HIDDEN_RESULT' });
    }
  }
}

function canAdvancePhase(state) {
  if (!state.started) return { ok: false, err: '请等待裁判开始游戏。' };
  if (state.over) return { ok: false, err: '游戏已结束。' };

  const needA = state.A.frozenRounds <= 0;
  const needB = state.B.frozenRounds <= 0;

  // 出牌阶段：双方（未被冻结）需要做一次“出牌或跳过”的决策
  if (state.phase === 'deploy_card' || state.phase === 'hunt_card') {
    if ((needA && !state.cardDecisionThisPhase.A) || (needB && !state.cardDecisionThisPhase.B)) {
      return {
        ok: false,
        err: '出牌阶段：所有未被【宵禁令】影响的阵营，都需要选择“出牌”或“跳过出牌”后才能进入下一阶段。'
      };
    }
    return { ok: true };
  }

  // 移动阶段：双方（未被冻结）必须至少行动一次
  if ((needA && state.movesThisPhase.A === 0) || (needB && state.movesThisPhase.B === 0)) {
    return {
      ok: false,
      err: state.phase === 'deploy_move'
        ? '部署阶段：所有未被【宵禁令】影响的阵营，都必须至少移动一次间谍后才能进入下一阶段。'
        : '抓捕阶段：所有未被【宵禁令】影响的阵营，都必须至少部署/移动一次追捕者后才能进入下一阶段。'
    };
  }
  return { ok: true };
}

function advancePhase(state) {
  const ok = canAdvancePhase(state);
  if (!ok.ok) return ok;

  if (state.over) return { ok: true };


  // --- phase transitions ---
  if (state.phase === 'deploy_card') {
    // 进入部署移动：重置移动计数
    state.movesThisPhase.A = 0;
    state.movesThisPhase.B = 0;
    state.phase = 'deploy_move';
    addLog(state, { text: `R${state.round} · 阶段切换：进入【部署阶段】。`, vis: 'ALL' });
    return { ok: true };
  }

  if (state.phase === 'deploy_move') {
    // 部署阶段结束：先统一结算需要“等双方都部署完最新位置”才能判定的隐藏效果
    resolveDeployEndHidden(state);

    // 进入抓捕出牌：重置出牌决策
    state.cardsUsedThisPhase.A = false;
    state.cardsUsedThisPhase.B = false;
    state.cardDecisionThisPhase.A = false;
    state.cardDecisionThisPhase.B = false;
    state.phase = 'hunt_card';
    addLog(state, { text: `R${state.round} · 阶段切换：进入【抓捕阶段出牌】。`, vis: 'ALL' });
    return { ok: true };
  }

  if (state.phase === 'hunt_card') {
    // 进入抓捕移动：清空待结算抓捕标记 & 重置移动计数
    state.pendingCapture = { A: false, B: false };
    state.movesThisPhase.A = 0;
    state.movesThisPhase.B = 0;
    state.phase = 'hunt_move';
    addLog(state, { text: `R${state.round} · 阶段切换：进入【抓捕阶段】。`, vis: 'ALL' });
    return { ok: true };
  }

  // hunt_move -> next round deploy_card
  if (state.phase === 'hunt_move') {
    // 抓捕阶段结束：统一结算抓捕
    const aHit = !!state.pendingCapture.A;
    const bHit = !!state.pendingCapture.B;
    if (aHit || bHit) {
      if (aHit && bHit) {
        state.over = true;
        state.gameOver = { winner: null, reason: 'draw' };
        addLog(state, { text: `R${state.round} · 抓捕结算：双方均抓捕成功，平局。`, vis: 'ALL' });
      } else {
        const winner = aHit ? 'A' : 'B';
        const loser = winner === 'A' ? 'B' : 'A';
        const loc = posName(state[loser].spyPos);
        const story = ENDING_STORIES[loc] || null;
        state.over = true;
        state.gameOver = { winner, reason: 'capture', location: loc, story };
        addLog(state, { text: `R${state.round} · 抓捕结算：${winner} 方抓捕成功，游戏结束。`, vis: 'ALL' });
      }
    }

    if (state.over) return { ok: true };

    // 差役成群：巡逻“撞见敌方间谍”提示应在【抓捕阶段结束】统一显示
    for (const s of ['A', 'B']) {
      const p = state[s];
      if (p.patrolHitPending) {
        const loc = p.patrolHitLoc ? `（地点：${p.patrolHitLoc}）` : '';
        addLog(state, { text: `R${state.round} · 差役成群：巡逻中撞见敌方间谍所在格！${loc}`, vis: s, kind: 'CARD_RESULT' });
        addLog(state, { text: `R${state.round} · 差役成群：${s}方巡逻中撞见敌方间谍。${loc}`, vis: 'REF', kind: 'CARD_RESULT' });
        p.patrolHitPending = false;
        p.patrolHitLoc = null;
      }
    }

    // 回合结束清理
    state.A.hunterPos = null;
    state.B.hunterPos = null;
    state.A.youjingPending = false;
    state.B.youjingPending = false;
    state.pendingCapture = { A: false, B: false };

    // 冻结回合数递减
    if (state.A.frozenRounds > 0) state.A.frozenRounds -= 1;
    if (state.B.frozenRounds > 0) state.B.frozenRounds -= 1;

    // 差役成群：在下一次【部署阶段出牌】结算宵禁令；这里做回合数递减 + 自然到期
    for (const s of ['A', 'B']) {
      const p = state[s];
      if (p.patrolActive && p.patrolRoundsLeft > 0) {
        p.patrolRoundsLeft -= 1;
        if (p.patrolRoundsLeft <= 0) {
          // 巡逻到期：结束“带差役”状态，但外围进度允许跨多张【差役成群】累计，
          // 因此这里不要清空 patrolVisitedOuter / patrolResolvePending。
          p.patrolActive = false;
          addLog(state, { text: `R${state.round} · 差役成群：${s}方巡逻结束（持续回合到期）。`, vis: 'REF', kind: 'CARD_RESULT' });
          addLog(state, { text: `R${state.round} · 差役成群：你的巡逻结束。`, vis: s, kind: 'CARD_RESULT' });
        }
      }
    }

    // 进入下一回合
    state.round += 1;
    state.cardsUsedThisRound.A = false;
    state.cardsUsedThisRound.B = false;

    // 进入部署出牌前，处理“差役成群”的延迟结算（若待结算且仍在持续期内）
    for (const s of ['A', 'B']) {
      const p = state[s];
      const oppSide = s === 'A' ? 'B' : 'A';
      const opp = state[oppSide];
      // 宵禁令：一旦达成“绕城一圈”，允许跨回合/跨多张差役累计；到下一次【部署阶段出牌】统一结算。
      // 注意：即使本次差役刚好到期（patrolActive=false），也应当结算。
      if (p.patrolResolvePending) {
        // 撕毁敌方全部锦囊 + 冻结 1 回合
        for (const k of Object.keys(opp.cards)) opp.cards[k] = 0;
        opp.frozenRounds = Math.max(opp.frozenRounds, 1);
        addLog(state, { text: `R${state.round} · 隐藏：你达成【差役成群绕城一圈】，触发【宵禁令】！敌方被冻 1 回合。`, vis: s, kind: 'HIDDEN_RESULT' });
        // 被冻结方也需要得到明确提示（玩家视角会以弹窗 + 日志呈现）
        addLog(state, { text: `R${state.round} · 隐藏：你遭遇【宵禁令】！你的锦囊被清空并被冻结 1 回合。`, vis: oppSide, kind: 'HIDDEN_RESULT' });
        addLog(state, { text: `R${state.round} · 隐藏：${s}方触发【宵禁令】，清空敌方锦囊并冻结 1 回合。`, vis: 'REF', kind: 'HIDDEN_RESULT' });
        // 触发后清空累计进度（并结束巡逻状态）
        p.patrolActive = false;
        p.patrolRoundsLeft = 0;
        p.patrolVisitedOuter = [];
        p.patrolResolvePending = false;
      }
    }

    // 进入新的部署出牌阶段
    state.cardsUsedThisPhase.A = false;
    state.cardsUsedThisPhase.B = false;
    state.cardDecisionThisPhase.A = false;
    state.cardDecisionThisPhase.B = false;
    state.movesThisPhase.A = 0;
    state.movesThisPhase.B = 0;
    state.phase = 'deploy_card';
    addLog(state, { text: `回合：进入第 ${state.round} 回合（部署阶段出牌）。`, vis: 'ALL' });
    return { ok: true };
  }

  return { ok: true };
}

function applyPlayCard(state, side, cardName, payload) {
  if (!state.started) return { ok: false, err: '请等待裁判开始游戏。' };
  if (state.over) return { ok: false, err: '游戏已结束。' };
  if (side !== 'A' && side !== 'B') return { ok: false, err: '非法阵营。' };
  const p = state[side];
  if (p.frozenRounds > 0) return { ok: false, err: '你已被【宵禁令】冻结，本回合无法行动。' };

  // 跨两个出牌阶段的“大回合”限制：每回合只能用 1 次锦囊
  if (state.cardsUsedThisRound?.[side]) {
    return { ok: false, err: '本回合你已经使用过锦囊。' };
  }

  if (state.cardsUsedThisPhase[side]) {
    return { ok: false, err: '本阶段你已经使用过锦囊。' };
  }

  // 只能在出牌阶段使用锦囊
  if (state.phase !== 'deploy_card' && state.phase !== 'hunt_card') {
    return { ok: false, err: '当前不是出牌阶段，不能使用锦囊。' };
  }

  if (!BASE_CARDS.includes(cardName)) {
    return { ok: false, err: '非法锦囊名称（本体包仅：差役成群 / 幽径暗道 / 耳目线报 / 追猎犬）。' };
  }

  // 阶段限制：部署出牌/抓捕出牌
  const deployCards = new Set(['差役成群', '幽径暗道']);
  const huntCards = new Set(['耳目线报', '追猎犬']);
  if (state.phase === 'deploy_card' && !deployCards.has(cardName)) {
    return { ok: false, err: '当前为【部署阶段出牌】，只能使用【差役成群 / 幽径暗道】。' };
  }
  if (state.phase === 'hunt_card' && !huntCards.has(cardName)) {
    return { ok: false, err: '当前为【抓捕阶段出牌】，只能使用【耳目线报 / 追猎犬】。' };
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
    state.cardDecisionThisPhase[side] = true;

    // 外围巡逻进度允许跨多张【差役成群】累计（用于触发【宵禁令】），因此不在这里清空。
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
    state.cardDecisionThisPhase[side] = true;
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
      } else {
        const have = p.cards[discardName] || 0;
        // 允许弃置“耳目线报”本身，但需要额外持有 1 张（因为本次使用也会消耗 1 张）
        if (discardName === cardName) {
          if (have <= 1) {
            // 张数不足，无法同时“使用+额外弃置”
          } else {
            p.cards[discardName] -= 1;
            p.hidden.almsNetwork = true;
            activatedAlms = true;
            discarded = discardName;
          }
        } else if (have <= 0) {
        // 无此牌
        } else {
          p.cards[discardName] -= 1;
          p.hidden.almsNetwork = true;
          activatedAlms = true;
          discarded = discardName;
        }
      }
    }

    p.cards[cardName] -= 1;
    state.cardsUsedThisPhase[side] = true;
    state.cardsUsedThisRound[side] = true;
    state.cardDecisionThisPhase[side] = true;

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

    // 顺序要求：若发动【拿钱办事】，应先提示“发动隐藏效果”，再提示耳目判定结果（日志与弹窗都要同顺序）
    if (activatedAlms) {
      // 玩家侧不暴露弃置具体牌名（你要求“手牌只给裁判”）
      addLog(state, { text: `R${state.round} · 隐藏：你额外弃置 1 张卡牌发动【拿钱办事】，获得【丐帮情报网络】。`, vis: side, kind: 'HIDDEN_RESULT' });
      addLog(state, { text: `R${state.round} · 隐藏：${side}方弃置【${discarded}】发动【拿钱办事】，获得【丐帮情报网络】。`, vis: 'REF', kind: 'HIDDEN_RESULT' });
    }

    if (p.hidden.almsNetwork) {
      const txt = `R${state.round} · 锦囊：你使用【耳目线报+丐帮情报网络】侦查方向 ${dir} 整条线，结果：${found ? '发现敌方踪迹。' : '未见可疑。'}`;
      addLog(state, { text: txt, vis: side, kind: 'CARD_RESULT' });
      // 裁判/观众也需要看到完整判定结果（第三方口吻由 maskForRole 处理）
      addLog(state, { text: txt, vis: 'REF', kind: 'CARD_RESULT', actor: side });
    } else {
      const txt = `R${state.round} · 锦囊：你使用【耳目线报】侦查方向 ${dir} 前方，结果：${found ? '前方线路存在敌方踪迹。' : '前方未发现敌人。'}`;
      addLog(state, { text: txt, vis: side, kind: 'CARD_RESULT' });
      addLog(state, { text: txt, vis: 'REF', kind: 'CARD_RESULT', actor: side });
    }

    // 旧的调试日志移除（避免重复/泄露实现细节）
    return { ok: true };
  }

  // --- 追猎犬 ---
  if (cardName === '追猎犬') {
    if (!p.spyPos || !opp.spyPos) return { ok: false, err: '需双方都已部署间谍，才能使用【追猎犬】。' };

    p.cards[cardName] -= 1;
    state.cardsUsedThisPhase[side] = true;
    state.cardsUsedThisRound[side] = true;
    state.cardDecisionThisPhase[side] = true;

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
      const txt = `R${state.round} · 锦囊：你使用【追猎犬】，得到两个矛盾方向线索：${d1} 与 ${d2}。`;
      addLog(state, { text: txt, vis: side, kind: 'CARD_RESULT' });
      addLog(state, { text: txt, vis: 'REF', kind: 'CARD_RESULT', actor: side });
    } else {
      const txt = `R${state.round} · 锦囊：你使用【追猎犬】，得到线索：敌方大致在你的 ${base} 方。`;
      addLog(state, { text: txt, vis: side, kind: 'CARD_RESULT' });
      addLog(state, { text: txt, vis: 'REF', kind: 'CARD_RESULT', actor: side });
    }

    p.lastDogDirections.push(base);
    if (p.lastDogDirections.length > 2) p.lastDogDirections.shift();

    if (p.lastDogDirections.length === 2 && p.lastDogDirections[0] === p.lastDogDirections[1]) {
      if (!p.hidden.hunterIntuition) {
        p.hidden.hunterIntuition = true;
        addLog(state, { text: `R${state.round} · 隐藏：你的追猎犬连续两次指向同一方向，触发【猎户直觉】。`, vis: side, kind: 'HIDDEN_RESULT' });
        addLog(state, { text: `R${state.round} · 隐藏：${side}方触发【猎户直觉】。`, vis: 'REF', kind: 'HIDDEN_RESULT' });
      }
    }

    return { ok: true };
  }

  return { ok: false, err: '未实现的锦囊。' };
}

function applyPassCard(state, side) {
  if (!state.started) return { ok: false, err: '请等待裁判开始游戏。' };
  if (state.over) return { ok: false, err: '游戏已结束。' };
  if (side !== 'A' && side !== 'B') return { ok: false, err: '非法阵营。' };
  const p = state[side];
  if (p.frozenRounds > 0) return { ok: false, err: '你已被【宵禁令】冻结，本回合无法行动。' };
  if (state.phase !== 'deploy_card' && state.phase !== 'hunt_card') {
    return { ok: false, err: '当前不是出牌阶段，不能跳过。' };
  }
  if (state.cardDecisionThisPhase[side]) {
    return { ok: false, err: '本阶段你已经做出过出牌决策。' };
  }
  state.cardDecisionThisPhase[side] = true;
  addLog(state, { text: `R${state.round} · 出牌：你选择跳过出牌。`, vis: side });
  addLog(state, { text: `R${state.round} · 出牌：${side}方选择跳过出牌。`, vis: 'REF' });
  return { ok: true };
}

function maskForRole(state, role, seat) {
  // seat: 'A'|'B'|null
  // role: 'REF'|'SPECTATOR'|'A'|'B'
  if (role === 'REF' || role === 'SPECTATOR') {
    const nickA = state?.seatNicks?.A || '';
    const nickB = state?.seatNicks?.B || '';
    const label = (side) => {
      if (side === 'A') return nickA ? `大宋方(${nickA})` : '大宋方';
      if (side === 'B') return nickB ? `契丹方(${nickB})` : '契丹方';
      return '玩家';
    };

    const toSideNamesForRef = (s) => {
      if (!s) return s;
      // 将裁判/观众视角中的 A/B 统一替换为 大宋/契丹，并尽可能带上昵称。
      // 只对 REF/ALL 日志做替换：避免出现玩家私密日志里“你”的口吻。
      return String(s)
        // 先把 A/B 方替换掉
        .replaceAll('A方', label('A'))
        .replaceAll('B方', label('B'))
        .replaceAll('A 方', nickA ? `大宋(${nickA})` : '大宋')
        .replaceAll('B 方', nickB ? `契丹(${nickB})` : '契丹')
        .replaceAll('：A', nickA ? `：大宋(${nickA})` : '：大宋')
        .replaceAll('：B', nickB ? `：契丹(${nickB})` : '：契丹');
    };

    const thirdPersonize = (e) => {
      // e.actor 由服务端在 REF 可见的结果日志中写入，用于把“你”替换成具体阵营(昵称)。
      const actorSide = e?.actor;
      const actorLabel = label(actorSide);
      let text = toSideNamesForRef(e.text);
      if (actorSide === 'A' || actorSide === 'B') {
        text = String(text).replaceAll('你', actorLabel);
      }
      return { ...e, text };
    };

    return {
      kind: 'ref_view',
      truth: state,
      // 裁判/观众：只看 ALL + REF（第三方口吻），并把 A/B 替换成 大宋/契丹。
      log: state.log
        .filter(e => e.vis === 'ALL' || e.vis === 'REF')
        .map(thirdPersonize)
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
    cardDecisionThisPhase: { [side]: state.cardDecisionThisPhase[side] },
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
  // 维护 seat -> nick 映射，供裁判/观众第三方日志展示
  const nickOf = (tok) => {
    if (!tok) return '';
    return room.clients.get(tok)?.nick || '';
  };
  if (room?.state?.seatNicks) {
    room.state.seatNicks.A = nickOf(room.seats?.A);
    room.state.seatNicks.B = nickOf(room.seats?.B);
  }

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
  // 第一个进房间的人自动当 Host。
  // 裁判（REF）由在线列表是否分配决定；创建房间时会默认把房主也设为裁判。
  if (!room.hostToken) room.hostToken = token;
}

function hasJudge(room) {
  return !!(room.seats && room.seats.REF && room.refToken && room.seats.REF === room.refToken);
}

function maybeAutoAdvance(room) {
  // 仅在“未分配裁判席位”时启用自动推进
  if (hasJudge(room)) return;
  if (!room.state || !room.state.started || room.state.over) return;

  // 可能连续推进：部署->追捕->新回合（例如双方冻结等极端情况）
  for (let i = 0; i < 6; i++) {
    const ok = canAdvancePhase(room.state);
    if (!ok.ok) break;
    const res = advancePhase(room.state);
    if (!res.ok) break;
  }
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
      // 默认：创建者为房主；并默认也担任裁判（可在在线列表里取消分配裁判席位）
      ensureHostAndRef(room, clientToken);
      room.refToken = clientToken;
      room.seats.REF = clientToken;
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
      // 如果被移除的是当前裁判，也一并清空裁判权限（可进入自动裁判模式）
      if (room.refToken === targetToken) room.refToken = null;

      if (seat === 'A' || seat === 'B') {
        room.seats[seat] = targetToken;
      } else if (seat === 'REF') {
        room.seats.REF = targetToken;
        room.refToken = targetToken;
      } else {
        // spectator
      }

      // 若当前没有裁判席位，则裁判权限也必须为空
      if (!room.seats.REF) room.refToken = null;

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
      // 有裁判时：裁判开始；无裁判时：房主开始
      if (hasJudge(room)) {
        if (!mustBeRef(room, clientToken)) {
          send(ws, { type: 'ERROR', message: '只有裁判可以开始/重置游戏。' });
          return;
        }
      } else {
        if (!mustBeHost(room, clientToken)) {
          send(ws, { type: 'ERROR', message: '当前未分配裁判：只有房主可以开始/重置游戏。' });
          return;
        }
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
      // 有裁判时：裁判推进；无裁判时：默认自动推进（保留房主手动推进以便调试）
      if (hasJudge(room)) {
        if (!mustBeRef(room, clientToken)) {
          send(ws, { type: 'ERROR', message: '只有裁判可以推进阶段。' });
          return;
        }
      } else {
        if (!mustBeHost(room, clientToken)) {
          send(ws, { type: 'ERROR', message: '当前未分配裁判：只有房主可以手动推进阶段。' });
          return;
        }
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
        send(ws, { type: 'ERROR', message: hasJudge(room) ? '请等待裁判开始游戏。' : '请等待房主开始游戏。' });
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
      // 自动裁判：若满足推进条件则自动推进（并再次广播）
      const before = room.state.round + '|' + room.state.phase;
      maybeAutoAdvance(room);
      const after = room.state.round + '|' + room.state.phase;
      if (before !== after || room.state.over) broadcastRoom(room);
      return;
    }

    if (type === 'PLAY_CARD') {
      const cardName = String(msg?.cardName ?? '').trim();
      const payload = msg?.payload;

      if (!room.state.started) {
        send(ws, { type: 'ERROR', message: hasJudge(room) ? '请等待裁判开始游戏。' : '请等待房主开始游戏。' });
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
      const before = room.state.round + '|' + room.state.phase;
      maybeAutoAdvance(room);
      const after = room.state.round + '|' + room.state.phase;
      if (before !== after || room.state.over) broadcastRoom(room);
      return;
    }

    if (type === 'PASS_CARD') {
      if (!room.state.started) {
        send(ws, { type: 'ERROR', message: hasJudge(room) ? '请等待裁判开始游戏。' : '请等待房主开始游戏。' });
        return;
      }
      if (client.role !== 'A' && client.role !== 'B') {
        send(ws, { type: 'ERROR', message: '只有玩家可以跳过出牌。' });
        return;
      }
      const side = client.role;
      const res = applyPassCard(room.state, side);
      if (!res.ok) {
        send(ws, { type: 'ERROR', message: res.err });
        return;
      }
      broadcastRoom(room);
      const before = room.state.round + '|' + room.state.phase;
      maybeAutoAdvance(room);
      const after = room.state.round + '|' + room.state.phase;
      if (before !== after || room.state.over) broadcastRoom(room);
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

        // 从在线列表移除
        room.clients.delete(token);
        removedAny = true;
        addLog(room.state, { text: `${c.nick} 离开了房间。`, vis: 'ALL' });

        // --- 裁判掉线/退出：自动切换为“无裁判模式（电脑接管）” ---
        // 规则：只要 REF token 不在房间里，就认为未分配裁判，从而启用自动推进。
        const judgeLeft = (room.refToken === token) || (room.seats && room.seats.REF === token);
        if (room.seats && room.seats.REF === token) room.seats.REF = null;
        if (room.refToken === token) room.refToken = null;
        // 给所有人一个明确提示（第三方可见，玩家也可见）
        if (judgeLeft) {
          addLog(room.state, { text: `裁判不在线，系统已切换为自动裁判模式。`, vis: 'ALL' });
        }

        // --- 房主掉线：自动转移给当前房间第一位在线用户 ---
        if (room.hostToken === token) {
          const next = room.clients.keys().next();
          const nextTok = next && !next.done ? next.value : null;
          room.hostToken = nextTok;
          if (nextTok) {
            const nn = room.clients.get(nextTok)?.nick || '（未知）';
            addLog(room.state, { text: `房主已离线，房主权限自动转移给 ${nn}。`, vis: 'ALL' });
          }
        }
      }
      if (removedAny) {
        // 重新计算 role（seat 仍在，但人暂时不在 roster）
        for (const [t, cc] of room.clients.entries()) {
          const rr = assignRoleFromSeats(room, t);
          cc.role = rr.role;
          cc.seat = rr.seat;
        }

        // 如果游戏正在进行且现在是无裁判模式，尝试自动推进一次（避免卡在需要裁判推进的阶段）
        const before = room.state.round + '|' + room.state.phase;
        maybeAutoAdvance(room);
        const after = room.state.round + '|' + room.state.phase;
        // broadcastRoom 下面会再发一次，如果阶段推进发生变化也无所谓
        broadcastRoom(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`beiguo-online listening on http://localhost:${PORT}`);
});
