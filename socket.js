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
      io.emit('src', lastSrc, 0);

      
    })

    socket.on('disconnect', () => {
      console.log('user disconnected');
    })
  });

  return io;
  };