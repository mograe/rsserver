const express = require('express');
const http = require("http");
const cors = require("cors");
const path = require("path");

const createMoviesRouter = require("./routes/movies");
const initSockets = require("./socket");

const app = express();

app.use(cors());
app.use(express.json({limit: "1mb"}));
app.use(express.static(path.join(__dirname, "static")));


app.use("/api/movies", createMoviesRouter());

app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) return res.sendStatus(404);
    res.sendFile(path.join(__dirname, "static", "index.html"));
})

const server = http.createServer(app);

const io = initSockets(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));