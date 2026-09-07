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
      presenterId: null,
      correctLetter: null,
      actualValue: null,
    },
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
    const playerId = crypto.randomUUID();
    room.players[playerId] = { nickname, score: 0, joinedAt: Date.now() };
    addLog(room, nickname + " joined");
    await s.setJSON(code, room);
    return json({ playerId, room: pub(room) });
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

  if (action === "host-action") {
    const room = await loadRoom(s, code);
    if (!room) return json({ error: "Room not found" }, 404);
    if (body.hostToken !== room.hostToken) return json({ error: "Invalid host token" }, 403);

    const sub = body.sub;
    const payload = body.payload || {};

    switch (sub) {
      case "set-round": {
        room.round = payload.round;
        room.active = { kind: "idle", questionIndex: null, presenterId: null, correctLetter: null, actualValue: null };
        room.submissions = {};
        addLog(room, "Host moved to round " + payload.round);
        break;
      }

      case "open-question": {
        room.active = {
          kind: "open",
          questionIndex: payload.questionIndex,
          presenterId: room.active.presenterId,
          correctLetter: null,
          actualValue: null,
        };
        room.submissions = {};
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

      case "set-presenter": {
        room.active.presenterId = payload.playerId;
        break;
      }

      case "reveal-bluff": {
        room.active.kind = "revealed";
        room.active.correctLetter = payload.correctLetter;
        const presenterId = room.active.presenterId;
        for (const pid of Object.keys(room.submissions)) {
          const sVal = room.submissions[pid];
          if (pid === presenterId) continue;
          if (!room.players[pid]) continue;
          if (sVal.value === payload.correctLetter) {
            room.players[pid].score += 1;
          } else if (presenterId && room.players[presenterId]) {
            room.players[presenterId].score += 1;
          }
        }
        addLog(room, "Bluff revealed: " + payload.correctLetter);
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

      case "kick": {
        delete room.players[payload.playerId];
        delete room.submissions[payload.playerId];
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
