const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'data', 'database.db'));

db.all("SELECT id, name FROM datasets WHERE name LIKE '%TABLE_IN_PAG%'", [], (err, rows) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log("Datasets found:", rows);
    if (rows.length > 0) {
        const datasetId = rows[0].id;
        db.all("SELECT id, filename, annotationPath FROM images WHERE datasetId = ? ORDER BY id DESC LIMIT 5", [datasetId], (err, imgs) => {
            if (err) {
                console.error(err);
                process.exit(1);
            }
            console.log("\nLast 5 images for dataset ID:", datasetId);
            imgs.forEach(img => {
                console.log(`- Image ID: ${img.id}`);
                console.log(`  Filename: ${img.filename}`);
                console.log(`  Annotation Path: ${img.annotationPath}`);
            });
            db.close();
        });
    } else {
        console.log("No dataset found with name containing 'TABLE_IN_PAGE'");
        db.close();
    }
});
