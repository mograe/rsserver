const express = require("express");
const fs = require("fs");
const path = require("path");

function createMoviesRouter(options = {}) {
    const router = express.Router();

    const {
        moviesDbPath = path.join(__dirname, "..", "movies.json")
    } = options;

    function ensureMoviesDbExists() {
        if (!fs.existsSync(moviesDbPath)) {
            fs.writeFileSync(moviesDbPath, JSON.stringify([], null, 2), "utf-8");
        }
    }

    function readMovies() {
        ensureMoviesDbExists();

        try {
            const raw = fs.readFileSync(moviesDbPath, "utf-8");

            if (!raw.trim()) {
                return [];
            }

            const data = JSON.parse(raw);

            if (Array.isArray(data)) {
                return data;
            }

            if (Array.isArray(data.movies)) {
                return data.movies;
            }

            return [];
        } catch (error) {
            console.error("[MOVIES] Failed to read movies DB:", error);
            return [];
        }
    }

    function toPublicMovie(movie) {
        return {
            id: movie.id,
            title: movie.title,

            // Для совместимости со старым UI
            length: movie.length,
            minutes: movie.minutes,

            // Более точная длительность
            durationSec: movie.durationSec,

            // Видео
            videoUri: movie.videoUri,
            type: movie.type || "hls",
            hls: Boolean(movie.hls),

            // Картинка
            thumbUri: movie.thumbUri || null
        };
    }

    // ------------------------------------------------------------
    // GET /api/movies
    // Публичный список фильмов для сайта / клиента / Unity
    // ------------------------------------------------------------

    router.get("/", (req, res) => {
        const movies = readMovies()
            .map(toPublicMovie)
            .filter(movie => movie.id && movie.title);

        res.json(movies);
    });

    // ------------------------------------------------------------
    // GET /api/movies/:movieId
    // Получить один фильм по id
    // ------------------------------------------------------------

    router.get("/:movieId", (req, res) => {
        const { movieId } = req.params;

        const movies = readMovies();
        const movie = movies.find(item => item.id === movieId);

        if (!movie) {
            return res.status(404).json({
                error: "Movie not found"
            });
        }

        res.json(toPublicMovie(movie));
    });

    return router;
}

module.exports = createMoviesRouter;