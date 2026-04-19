const { Server } = require("socket.io");
const timer = require("./timer.js");

module.exports = function initSockets(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  let lastSrc = null;
  let videoInfo = { currentTime: 0, duration: 0 };

  const TICK_MS = 250;
  const AFK_THRESHOLD = 0.4;

  const timerInterval = setInterval(() => {
    const elapsedSec = timer.getElapsedTime() / 1000;
    io.emit("timer", elapsedSec);
  }, TICK_MS);

  const clientStates = new Map();
  const movieHistory = [];

  /**
   * Активная сессия фильма.
   * Начинается на src_js и завершается на следующем src_js или stop.
   */
  let currentMovieSession = null;

  function now() {
    return Date.now();
  }

  function getActiveViewerCount() {
    let count = 0;

    for (const state of clientStates.values()) {
      if (state.isUser && !state.isAfk) {
        count++;
      }
    }

    return count;
  }

  function broadcastViewerCount() {
    const count = getActiveViewerCount();
    io.emit("viewerCount", count);
    console.log("Active viewers:", count);
  }

  function openMovieSessionForViewer(state, startedAt = now()) {
    if (!currentMovieSession) return;
    if (!state.isUser) return;

    state.movieSessionStartedAt = startedAt;
    state.movieSessionAfkMs = 0;
    state.movieSessionAfkStartedAt = state.isAfk ? startedAt : null;
  }

  function closeMovieSessionForViewer(state, endedAt = now()) {
    if (!state) return null;
    if (!state.isUser) return null;
    if (state.movieSessionStartedAt == null) return null;

    let afkMs = state.movieSessionAfkMs || 0;

    if (state.isAfk && state.movieSessionAfkStartedAt != null) {
      afkMs += endedAt - state.movieSessionAfkStartedAt;
    }

    const totalMs = Math.max(0, endedAt - state.movieSessionStartedAt);
    const afkRatio = totalMs > 0 ? afkMs / totalMs : 0;
    const counted = totalMs > 0 && afkRatio < AFK_THRESHOLD;

    const result = {
      socketId: state.socketId,
      totalMs,
      afkMs,
      afkRatio,
      counted,
    };

    state.movieSessionStartedAt = null;
    state.movieSessionAfkMs = 0;
    state.movieSessionAfkStartedAt = null;

    return result;
  }

  function finalizeCurrentMovieSession(endedAt = now(), reason = "unknown") {
    if (!currentMovieSession) return null;

    for (const state of clientStates.values()) {
      const result = closeMovieSessionForViewer(state, endedAt);
      if (result) {
        currentMovieSession.participants.push(result);
      }
    }

    const participants = currentMovieSession.participants;
    const countedViewers = participants.filter((p) => p.counted).length;
    const droppedByAfk = participants.filter((p) => !p.counted).length;

    const summary = {
      moviePath: currentMovieSession.moviePath,
      startedAt: currentMovieSession.startedAt,
      endedAt,
      reason, // "next_movie" | "stop" | ...
      totalParticipants: participants.length,
      countedViewers,
      droppedByAfk,
      participants,
    };

    movieHistory.push(summary);

    console.log("Movie session finalized:", {
      moviePath: summary.moviePath,
      reason: summary.reason,
      totalParticipants: summary.totalParticipants,
      countedViewers: summary.countedViewers,
      droppedByAfk: summary.droppedByAfk,
    });

    io.emit("movieStats", summary);

    currentMovieSession = null;
    return summary;
  }

  function startNewMovieSession(moviePath) {
    const startedAt = now();

    finalizeCurrentMovieSession(startedAt, "next_movie");

    currentMovieSession = {
      moviePath,
      startedAt,
      participants: [],
    };

    for (const state of clientStates.values()) {
      if (state.isUser) {
        openMovieSessionForViewer(state, startedAt);
      }
    }

    console.log("New movie session started:", moviePath);
  }

  function enterAfk(state, startedAt = now()) {
    if (!state) return;
    if (!state.isUser) return;
    if (state.isAfk) return;

    state.isAfk = true;

    if (state.movieSessionStartedAt != null && state.movieSessionAfkStartedAt == null) {
      state.movieSessionAfkStartedAt = startedAt;
    }
  }

  function exitAfk(state, endedAt = now()) {
    if (!state) return;
    if (!state.isUser) return;
    if (!state.isAfk) return;

    if (state.movieSessionStartedAt != null && state.movieSessionAfkStartedAt != null) {
      state.movieSessionAfkMs += endedAt - state.movieSessionAfkStartedAt;
      state.movieSessionAfkStartedAt = null;
    }

    state.isAfk = false;
  }

  io.on("connection", (socket) => {
    console.log("a user connected");

    clientStates.set(socket.id, {
      socketId: socket.id,
      isUser: false,
      isAfk: false,
      movieSessionStartedAt: null,
      movieSessionAfkMs: 0,
      movieSessionAfkStartedAt: null,
    });

    socket.on("play", () => {
      console.log("play");
      timer.startStopwatch();
      io.emit("play");
    });

    socket.on("pause", () => {
      console.log("pause");
      timer.stopStopwatch();
      io.emit("pause");
    });

    socket.on("src_js", (src) => {
      console.log("src_js:", src);
      console.log("elapsed:", timer.getElapsedTime());

      startNewMovieSession(src);

      lastSrc = src;
      io.emit("src", src, timer.getElapsedTime() / 1000);
    });

    socket.on("send-info", (current, duration) => {
      videoInfo = { currentTime: current, duration: duration };
      io.emit("get-info", videoInfo);
    });

    socket.on("iamuser", () => {
      const state = clientStates.get(socket.id);
      if (!state) return;

      state.isUser = true;
      state.isAfk = false;

      if (currentMovieSession && state.movieSessionStartedAt == null) {
        openMovieSessionForViewer(state);
      }

      console.log(`iamuser: ${socket.id}`);
      io.emit("user-is-connected");

      if (lastSrc) {
        socket.emit("src", lastSrc, timer.getElapsedTime() / 1000);
      }

      broadcastViewerCount();
    });

    socket.on("EnterAfk", () => {
      const state = clientStates.get(socket.id);
      if (!state) return;

      if (state.isUser && !state.isAfk) {
        enterAfk(state);
        console.log(`EnterAfk: ${socket.id}`);
        broadcastViewerCount();
      }
    });

    socket.on("ExitAfk", () => {
      const state = clientStates.get(socket.id);
      if (!state) return;

      if (state.isUser && state.isAfk) {
        exitAfk(state);
        console.log(`ExitAfk: ${socket.id}`);
        broadcastViewerCount();
      }
    });

    socket.on("reset", () => {
      console.log("reset");
      timer.resetStopwatch();
      timer.startStopwatch();
    });

    socket.on("stop", () => {
      console.log("stop");

      // Финализируем текущий показ и отправляем movieStats
      finalizeCurrentMovieSession(now(), "stop");

      timer.resetStopwatch();
      timer.startStopwatch();

      if (lastSrc) {
        io.emit("src", lastSrc, 0);
      }
    });

    socket.on("disconnect", () => {
      console.log("user disconnected");

      const state = clientStates.get(socket.id);

      if (state && currentMovieSession) {
        const result = closeMovieSessionForViewer(state, now());
        if (result) {
          currentMovieSession.participants.push(result);
        }
      }

      clientStates.delete(socket.id);
      broadcastViewerCount();
    });
  });

  return io;
};   