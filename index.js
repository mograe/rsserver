const express = require('express');
const app = express();
const http = require('http');
const { Server } = require("socket.io");
const cors = require("cors");
const timer = require("./timer.js")

app.use(cors());
app.use(express.static('static'))

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});


timer.startStopwatch();

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
    console.log(src.video);
    console.log(timer.getElapsedTime());
    io.emit('src', src.video, timer.getElapsedTime()/1000);
  })

  socket.on('send-info', (current, duration) => {
    videoInfo = {currentTime: current, duration: duration};
    io.emit('get-info', videoInfo);
  })

  socket.on('iamuser', () => {
    console.log('iamuser');
    io.emit('user-is-connected');
  })

  socket.on('reset', () => {
    console.log('reset');
    timer.resetStopwatch();
  })

  socket.on('disconnect', () => {
    console.log('user disconnected');
  })
});



server.listen(3001, () => {
  console.log('listening on *:3001');
});