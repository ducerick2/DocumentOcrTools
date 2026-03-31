const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'database.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run('PRAGMA foreign_keys = ON');
        initSchema();
    }
});

function initSchema() {
    db.serialize(() => {
        // Datasets Table
        db.run(`CREATE TABLE IF NOT EXISTS datasets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            annotationType TEXT DEFAULT 'bbox',
            labels TEXT,
            createdAt TEXT,
            updatedAt TEXT,
            imageCount INTEGER DEFAULT 0,
            annotatedCount INTEGER DEFAULT 0
        )`);

        // Images Table
        db.run(`CREATE TABLE IF NOT EXISTS images (
            id TEXT PRIMARY KEY,
            datasetId TEXT,
            filename TEXT,
            originalName TEXT,
            path TEXT,
            absolutePath TEXT,
            size INTEGER,
            uploadedAt TEXT,
            width INTEGER,
            height INTEGER,
            annotationPath TEXT,
            isAnnotated INTEGER DEFAULT 0,
            sync TEXT,
            FOREIGN KEY (datasetId) REFERENCES datasets (id) ON DELETE CASCADE
        )`, (err) => {
            if (!err) {
                // Check if we need to add columns to existing table
                db.all("PRAGMA table_info(images)", (pErr, columns) => {
                    if (!pErr) {
                        const hasAnnotationPath = columns.some(c => c.name === 'annotationPath');
                        const hasIsAnnotated = columns.some(c => c.name === 'isAnnotated');
                        const hasSync = columns.some(c => c.name === 'sync');

                        if (!hasAnnotationPath) db.run("ALTER TABLE images ADD COLUMN annotationPath TEXT");
                        if (!hasIsAnnotated) db.run("ALTER TABLE images ADD COLUMN isAnnotated INTEGER DEFAULT 0");
                        if (!hasSync) db.run("ALTER TABLE images ADD COLUMN sync TEXT");
                    }
                });
            }
        });

        // Annotations Table - We keep it for schema structure but will stop using it for bulk data
        db.run(`CREATE TABLE IF NOT EXISTS annotations (
            id TEXT PRIMARY KEY,
            imageId TEXT,
            datasetId TEXT,
            label TEXT,
            type TEXT DEFAULT 'bbox',
            x REAL,
            y REAL,
            width REAL,
            height REAL,
            points TEXT,
            content TEXT,
            reading_order INTEGER DEFAULT 0,
            sync TEXT,
            createdAt TEXT,
            FOREIGN KEY (imageId) REFERENCES images (id) ON DELETE CASCADE,
            FOREIGN KEY (datasetId) REFERENCES datasets (id) ON DELETE CASCADE
        )`);

        // Indexes for performance
        db.run(`CREATE INDEX IF NOT EXISTS idx_images_datasetId ON images(datasetId)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_annotations_datasetId ON annotations(datasetId)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_annotations_imageId ON annotations(imageId)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_annotations_composite ON annotations(datasetId, imageId)`);

        console.log('Database schema initialized.');
    });
}

// Promisified Helpers
const run = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

const get = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const all = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

module.exports = {
    db,
    run,
    get,
    all
};
