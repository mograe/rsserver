const { Server } = require("socket.io");
const timer = require("./timer.js")

module.exports= function initSockets(server) { 
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });


  let lastSrc = null;

  const TICK_MS = 250;
  const timerInterval = setInterval(() => {
    const elapsedSec = timer.getElapsedTime() / 1000;
    io.emit('timer', elapsedSec);
  }, TICK_MS);


  // Храним состояние клиентов
const clientStates = new Map();

/**
 * Сколько сейчас активных просмотров:
 * пользователь подключён как viewer и не в AFK
 */
  function getActiveViewerCount() {
    let count = 0;

    for (const state of clientStates.values()) {
      if (state.isUser && !state.isAfk) {
        count++;
      }
    }

    return count;
  }

  /**
   * Отправить всем актуальное число просмотров
   */
  function broadcastViewerCount() {
    const count = getActiveViewerCount();
    io.emit("viewerCount", count);
    console.log("Active viewers:", count);
  }

  io.on('connection', (socket) => {
    console.log('a user connected');
    socket.on('play', () => {
      console.log('play');
      timer.startStopwatch();
      io.emit('play');
    })

    socket.on('pause', () => {
      console.log('pause');
      timer.stopStopwatch();
      io.emit('pause');
    })

    socket.on('src_js', (src) => {
      console.log(src);
      console.log(timer.getElapsedTime());
      lastSrc = src;
      io.emit('src', src, timer.getElapsedTime()/1000);
    })

    socket.on('send-info', (current, duration) => {
      videoInfo = {currentTime: current, duration: duration};
      io.emit('get-info', videoInfo);
    })

    socket.on('iamuser', () => {
      console.log('iamuser');
      io.emit('user-is-connected');

      if (lastSrc) {
        socket.emit('src', lastSrc, timer.getElapsedTime()/1000);
      }
    })

    socket.on('reset', () => {
      console.log('reset');
      timer.resetStopwatch();
      timer.startStopwatch();
    })

    socket.on('stop', () => {
      console.log('stop')
      timer.resetStopwatch();
      timer.startStopwatch();
      io.emit('src', lastSrc, 0);
    })

      // начальное состояние сокета
    clientStates.set(socket.id, {
      isUser: false,
      isAfk: false,
    });

    socket.on("iamuser", () => {
      const state = clientStates.get(socket.id);
      if (!state) return;

      // пользователь стал viewer
      state.isUser = true;
      state.isAfk = false;

      clientStates.set(socket.id, state);

      console.log(`iamuser: ${socket.id}`);
      broadcastViewerCount();
    });

    socket.on("EnterAfk", () => {
      const state = clientStates.get(socket.id);
      if (!state) return;

      // если это viewer, переводим в afk
      if (state.isUser && !state.isAfk) {
        state.isAfk = true;
        clientStates.set(socket.id, state);

        console.log(`EnterAfk: ${socket.id}`);
        broadcastViewerCount();
      }
    });

  socket.on("ExitAfk", () => {
    const state = clientStates.get(socket.id);
    if (!state) return;

    // если это viewer и он был afk, возвращаем в active
    if (state.isUser && state.isAfk) {
      state.isAfk = false;
      clientStates.set(socket.id, state);

      console.log(`ExitAfk: ${socket.id}`);
      broadcastViewerCount();
    }
  });

    socket.on('disconnect', () => {
      console.log('user disconnected');
      clientStates.delete(socket.id);
      broadcastViewerCount();
    })
  });

  return io;
  };