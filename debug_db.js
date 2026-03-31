const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = '/data/ducbm3/DocumentOCR/data/database.db';
const db = new sqlite3.Database(DB_PATH);

const datasetId = '1774451131089';

db.all('SELECT * FROM images WHERE datasetId = ? LIMIT 5', [datasetId], (err, rows) => {
    if (err) {
        console.error('Query Error:', err);
    } else {
        console.log(`Found ${rows.length} images for dataset ${datasetId}`);
        rows.forEach(row => {
            console.log(`ID: ${row.id}, Filename: ${row.filename}, AnnPath: ${row.annotationPath}`);
        });
    }
    db.close();
});
