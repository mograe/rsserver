const express = require('express');
const http = require("http");
const cors = require("cors");
const path = require("path");

const createMoviesRouter = require("./routes/movies");
const initSockets = require("./socket");

const app = express();

app.use(cors());
app.use(express.json({limit: "1mb"}));
app.use(express.static("static"));

// app.get("/", (req, res, next) => {
//     if (req.path.startsWith("/api/")) return next();
//     return res.sendFile(path.join(process.cwd(), "static", "index.html"));
// });

app.use("/api/movies", createMoviesRouter());

const server = http.createServer(app);

const io = initSockets(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));