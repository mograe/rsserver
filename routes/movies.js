const { count } = require('console');
const express = require('express');
const fs = require("fs/promises")
const path = require('path');

const MOVIES_PATH = path.join(process.cwd(), "movies.json")

async function readMovies(params) {
    try {
        const raw = await fs.readFile(MOVIES_PATH, "utf-8");
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        return [];
    }
}

async function writeMovies(movies) {
    await fs.writeFile(MOVIES_PATH, JSON.stringify(movies, null, 2), "utf-8");
}

function normalizeMovie(movie) {
    if (!movie) return null;



    const id = String(movie.id ?? "").trim();
    const title = String(movie.title ?? "").trim();
    const length = Number(movie.length ?? 0);

    if (!id || !title || !Number.isFinite(length) || length <= 0) return null;

    const thumbUri = movie.thumbUri ? String(movie.thumbUri).trim() : undefined;
    const videoUri = movie.videoUri ? String(movie.videoUri).trim() : undefined;

    const normalized = {id, title, length};
    if (thumbUri) normalized.thumbUri = thumbUri;
    if (videoUri) normalized.videoUri = videoUri;

    return normalized;
}

module.exports = function createMoviesRouter() {
    const router = express.Router();

    router.get("/", async (req, res) => {
        const movies = await readMovies();
        res.json(movies);
    });

    router.post("/add", async (req, res) => {
        const normalized = normalizeMovie(req.body);
        console.log(normalized);
        
        if (!normalized) {
            return res.status(400).send("Invalid movie");
        }

        const movies = await readMovies();

        const filtered = movies.filter(m => m.id !== normalized.id);
        filtered.unshift(normalized);

        await writeMovies(filtered);
        res.json({ok: true});
    
    });

    router.post("/", async (req, res) => {
        if (!Array.isArray(req.body)) {
            return res.status(400).send("Body must be an array");
        }

        const normalizedList = req.body
            .map(normalizeMovie)
            .filter(Boolean);

        await writeMovies(normalizedList);
        res.json({ok: true, count: normalizedList.length});
    });

    router.delete("/:id", async (req, res) => {
        const id = String(req.params.id).trim();
        if (!id) return res.status(400).send("Invalid id");

        const movies = await readMovies();
        const next = movies.filter(m => m.id !== id);

        await writeMovies(next);
        res.json({ok: true});
    });
    
    return router;

}