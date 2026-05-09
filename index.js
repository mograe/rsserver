require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");

const createMoviesRouter = require("./routes/movies");
const createHlsUploadRouter = require("./routes/hlsUpload");
const createProtectedHlsRouter = require("./routes/protectedHlsDb");
const initSockets = require("./socket");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use(express.static(path.join(__dirname, "static")));
app.use("/test-video", express.static(path.join(__dirname, "test-video")));

const MOVIES_DB_PATH = path.join(__dirname, "movies.json");

app.use("/api/movies", createMoviesRouter());

// Админ-загрузка HLS, ключей, картинок + список/удаление фильмов
app.use(createHlsUploadRouter({
    hlsDir: path.join(__dirname, "hls"),
    keysDir: path.join(__dirname, "keys_private"),
    imagesDir: path.join(__dirname, "static", "movie-thumbs"),
    imageUrlPrefix: "/movie-thumbs",
    moviesDbPath: MOVIES_DB_PATH,
    uploadToken: process.env.HLS_UPLOAD_TOKEN
}));

// Защищённая раздача HLS и AES-ключей
app.use(createProtectedHlsRouter({
    hlsDir: path.join(__dirname, "hls"),
    keysDir: path.join(__dirname, "keys_private"),
    moviesDbPath: MOVIES_DB_PATH,

    // Пока тестируешь — true.
    // Потом лучше false.
    devMode: true,

    playerSharedSecret: process.env.PLAYER_SHARED_SECRET || "CHANGE_THIS_PLAYER_SECRET"
}));

app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) return res.sendStatus(404);
    res.sendFile(path.join(__dirname, "static", "index.html"));
});

const server = http.createServer(app);

const io = initSockets(server);

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
    console.log(`HLS health: http://localhost:${PORT}/api/hls/health`);
});