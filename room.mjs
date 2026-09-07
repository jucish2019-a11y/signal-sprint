import { getStore } from "@netlify/blobs";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genCode(len = 5) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function store() {
  return getStore({ name: "signal-sprint-rooms", consistency: "strong" });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function freshBluff() {
  return { phase: "idle", entries: {}, guesses: {} };
}

function newRoom(code, hostToken) {
  return {
    code,
    createdAt: Date.now(),
    hostToken,
    round: 0,
    timer: { endsAt: null, remaining: 60, totalSeconds: 60, running: false },
    active: {
      kind: "idle",
      questionIndex: null,
      correctLetter: null,
      actualValue: null,
    },
    usedQuestions: { "1": [], "3": [], "4": [] },
    bluff: freshBluff(),
    plan: null,
    gameStartedAt: null,
    gameOver: false,
    players: {},
    submissions: {},
    log: [],
  };
}

function addLog(room, msg) {
  room.log = room.log || [];
  room.log.unshift({ t: Date.now(), msg });
  room.log = room.log.slice(0, 20);
}

function pub(room) {
  const { hostToken, ...rest } = room;
  if (rest.bluff && rest.bluff.phase !== "revealed") {
    const entries = {};
    for (const pid of Object.keys(rest.bluff.entries)) {
      const e = rest.bluff.entries[pid];
      entries[pid] = { statements: e.statements, submittedAt: e.submittedAt };
    }
    rest.bluff = { ...rest.bluff, entries };
  }
  return rest;
}

async function loadRoom(s, code) {
  return await s.get(code, { type: "json" });
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { action } = body;
  const s = store();

  if (action === "create-room") {
    let code = genCode();
    for (let i = 0; i < 6; i++) {
      const existing = await loadRoom(s, code);
      if (!existing) break;
      code = genCode();
    }
    const hostToken = crypto.randomUUID();
    const room = newRoom(code, hostToken);
    await s.setJSON(code, room);
    return json({ code, hostToken, room: pub(room) });
  }

  const code = (body.code || "").toUpperCase().trim();
  if (!code) return json({ error: "Missing room code" }, 400);

  if (action === "join") {
    const room = await loadRoom(s, code);
    if (!room) return json({ error: "Room not found" }, 404);
    const nickname = (body.nickname || "").trim().slice(0, 24);
    if (!nickname) return json({ error: "Nickname required" }, 400);

    const existingId = Object.keys(room.players).find(
      (pid) => room.players[pid].nickname.toLowerCase() === nickname.toLowerCase()
    );
    if (existingId) {
      addLog(room, nickname + " reconnected");
      await s.setJSON(code, room);
      return json({ playerId: existingId, room: pub(room), rejoined: true });
    }

    const playerId = crypto.randomUUID();
    room.players[playerId] = { nickname, score: 0, joinedAt: Date.now() };
    addLog(room, nickname + " joined");
    await s.setJSON(code, room);
    return json({ playerId, room: pub(room), rejoined: false });
  }

  if (action === "state") {
    const room = await loadRoom(s, code);
    if (!room) return json({ error: "Room not found" }, 404);
    return json({ room: pub(room) });
  }

  if (action === "submit") {
    const room = await loadRoom(s, code);
    if (!room) return json({ error: "Room not found" }, 404);
    const { playerId, value } = body;
    if (!room.players[playerId]) return json({ error: "Unknown player" }, 400);
    if (room.active.kind !== "open") return json({ error: "Submissions are closed" }, 400);
    room.submissions[playerId] = { value, submittedAt: Date.now() };
    await s.setJSON(code, room);
    return json({ room: pub(room) });
  }

  if (action === "bluff-submit") {
    const room = await loadRoom(s, code);
    if (!room) return json({ error: "Room not found" }, 404);
    const { playerId, statements, lieIndex } = body;
    if (!room.players[playerId]) return json({ error: "Unknown player" }, 400);
    if (!room.bluff || room.bluff.phase !== "collecting") return json({ error: "Not accepting statements right now" }, 400);
    if (!Array.isArray(statements) || statements.length !== 3 || statements.some((t) => !String(t || "").trim())) {
      return json({ error: "Enter all three statements" }, 400);
    }
    if (![0, 1, 2].includes(lieIndex)) return json({ error: "Pick which statement is the lie" }, 400);
    room.bluff.entries[playerId] = {
      statements: statements.map((t) => String(t).trim().slice(0, 200)),
      lieIndex,
      submittedAt: Date.now(),
    };
    await s.setJSON(code, room);
    return json({ room: pub(room) });
  }

  if (action === "bluff-guess") {
    const room = await loadRoom(s, code);
    if (!room) return json({ error: "Room not found" }, 404);
    const { playerId, targetId, guessIndex } = body;
    if (!room.players[playerId]) return json({ error: "Unknown player" }, 400);
    if (!room.bluff || room.bluff.phase !== "guessing") return json({ error: "Not guessing right now" }, 400);
    if (playerId === targetId) return json({ error: "Can't guess your own statements" }, 400);
    if (!room.bluff.entries[targetId]) return json({ error: "That player has no statements" }, 400);
    if (![0, 1, 2].includes(guessIndex)) return json({ error: "Invalid guess" }, 400);
    if (!room.bluff.guesses[playerId]) room.bluff.guesses[playerId] = {};
    room.bluff.guesses[playerId][targetId] = guessIndex;
    await s.setJSON(code, room);
    return json({ room: pub(room) });
  }

  if (action === "host-action") {
    const room = await loadRoom(s, code);
    if (!room) return json({ error: "Room not found" }, 404);
    if (body.hostToken !== room.hostToken) return json({ error: "Invalid host token" }, 403);

    const sub = body.sub;
    const payload = body.payload || {};
    if (!room.usedQuestions) room.usedQuestions = { "1": [], "3": [], "4": [] };
    if (!room.bluff) room.bluff = freshBluff();

    switch (sub) {
      case "set-round": {
        room.round = payload.round;
        room.active = { kind: "idle", questionIndex: null, correctLetter: null, actualValue: null };
        room.submissions = {};
        if (payload.round === 2) room.bluff = freshBluff();
        if (payload.round >= 1 && !room.gameStartedAt) room.gameStartedAt = Date.now();
        if (room.plan && room.plan[String(payload.round)] && room.plan[String(payload.round)].minutes > 0) {
          const secs = Math.round(room.plan[String(payload.round)].minutes * 60);
          room.timer = { totalSeconds: secs, remaining: secs, running: true, endsAt: Date.now() + secs * 1000 };
        }
        addLog(room, "Host moved to round " + payload.round);
        break;
      }

      case "save-plan": {
        room.plan = payload.plan || null;
        addLog(room, "Game plan updated");
        break;
      }

      case "open-question": {
        room.active = {
          kind: "open",
          questionIndex: payload.questionIndex,
          correctLetter: null,
          actualValue: null,
        };
        room.submissions = {};
        if (payload.questionIndex != null && (room.round === 1 || room.round === 3 || room.round === 4)) {
          const key = String(room.round);
          if (!room.usedQuestions[key].includes(payload.questionIndex)) {
            room.usedQuestions[key].push(payload.questionIndex);
          }
        }
        addLog(room, "Question opened");
        break;
      }

      case "close-submissions": {
        room.active.kind = "closed";
        break;
      }

      case "mark-revealed": {
        room.active.kind = "revealed";
        addLog(room, "Answer revealed");
        break;
      }

      case "reset-used": {
        const key = String(payload.round);
        if (room.usedQuestions[key]) room.usedQuestions[key] = [];
        addLog(room, "Reset used list for round " + payload.round);
        break;
      }

      case "bluff-open-collect": {
        room.bluff = freshBluff();
        room.bluff.phase = "collecting";
        addLog(room, "Bluff Call: collecting statements");
        break;
      }

      case "bluff-start-guessing": {
        if (!room.bluff || room.bluff.phase !== "collecting") return json({ error: "Not in collecting phase" }, 400);
        room.bluff.phase = "guessing";
        addLog(room, "Bluff Call: guessing started");
        break;
      }

      case "bluff-reveal": {
        if (!room.bluff) return json({ error: "No bluff round to reveal" }, 400);
        room.bluff.phase = "revealed";
        for (const guesserId of Object.keys(room.bluff.guesses)) {
          if (!room.players[guesserId]) continue;
          const myGuesses = room.bluff.guesses[guesserId];
          for (const targetId of Object.keys(myGuesses)) {
            const entry = room.bluff.entries[targetId];
            if (entry && myGuesses[targetId] === entry.lieIndex) {
              room.players[guesserId].score += 1;
            }
          }
        }
        addLog(room, "Bluff Call revealed and scored");
        break;
      }

      case "grade-submission": {
        const { playerId, correct, points } = payload;
        if (room.players[playerId]) {
          room.players[playerId].score += correct ? Math.abs(points) : -Math.abs(points);
        }
        if (room.submissions[playerId]) {
          room.submissions[playerId].graded = true;
          room.submissions[playerId].correct = correct;
        }
        break;
      }

      case "reveal-wager": {
        room.active.kind = "revealed";
        room.active.actualValue = payload.actualValue;
        let bestPid = null;
        let bestDiff = Infinity;
        for (const pid of Object.keys(room.submissions)) {
          const sVal = room.submissions[pid];
          const diff = Math.abs((sVal.value && sVal.value.guess != null ? sVal.value.guess : 0) - payload.actualValue);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestPid = pid;
          }
        }
        for (const pid of Object.keys(room.submissions)) {
          if (!room.players[pid]) continue;
          const sVal = room.submissions[pid];
          const wager = (sVal.value && sVal.value.wager) || 1;
          if (pid === bestPid) {
            room.players[pid].score += wager;
          } else {
            room.players[pid].score -= wager;
          }
        }
        addLog(room, "Wager revealed: " + payload.actualValue);
        break;
      }

      case "adjust-score": {
        if (room.players[payload.playerId]) {
          room.players[payload.playerId].score += payload.delta;
        }
        break;
      }

      case "reset-scores": {
        for (const pid of Object.keys(room.players)) room.players[pid].score = 0;
        addLog(room, "Scores reset");
        break;
      }

      case "finish-game": {
        room.gameOver = true;
        addLog(room, "Game finished");
        break;
      }

      case "reopen-game": {
        room.gameOver = false;
        addLog(room, "Back to the game");
        break;
      }

      case "new-game": {
        room.gameOver = false;
        room.round = 0;
        room.active = { kind: "idle", questionIndex: null, correctLetter: null, actualValue: null };
        room.submissions = {};
        room.bluff = freshBluff();
        room.usedQuestions = { "1": [], "3": [], "4": [] };
        room.gameStartedAt = null;
        for (const pid of Object.keys(room.players)) room.players[pid].score = 0;
        addLog(room, "New game started");
        break;
      }

      case "kick": {
        delete room.players[payload.playerId];
        delete room.submissions[payload.playerId];
        if (room.bluff) {
          delete room.bluff.entries[payload.playerId];
          delete room.bluff.guesses[payload.playerId];
        }
        break;
      }

      case "timer-start": {
        room.timer.running = true;
        room.timer.endsAt = Date.now() + (room.timer.remaining != null ? room.timer.remaining : room.timer.totalSeconds) * 1000;
        break;
      }

      case "timer-pause": {
        if (room.timer.running && room.timer.endsAt) {
          room.timer.remaining = Math.max(0, Math.round((room.timer.endsAt - Date.now()) / 1000));
        }
        room.timer.running = false;
        room.timer.endsAt = null;
        break;
      }

      case "timer-reset": {
        room.timer.running = false;
        room.timer.endsAt = null;
        room.timer.remaining = room.timer.totalSeconds;
        break;
      }

      case "timer-adjust": {
        const delta = payload.delta || 0;
        room.timer.totalSeconds = Math.max(15, room.timer.totalSeconds + delta);
        if (room.timer.running && room.timer.endsAt) {
          room.timer.endsAt += delta * 1000;
        } else {
          room.timer.remaining = Math.max(0, (room.timer.remaining || 0) + delta);
        }
        break;
      }

      default:
        return json({ error: "Unknown host action" }, 400);
    }

    await s.setJSON(code, room);
    return json({ room: pub(room) });
  }

  return json({ error: "Unknown action" }, 400);
};

export const config = {
  path: "/api/room",
};
