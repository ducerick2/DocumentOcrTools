const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const db = new sqlite3.Database(path.join(__dirname, 'data', 'database.db'));

const datasetId = '1775442227104';

db.all("SELECT annotationPath FROM images WHERE datasetId = ? AND isAnnotated = 1", [datasetId], (err, rows) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    
    const labels = new Set();
    rows.forEach(row => {
        if (row.annotationPath && fs.existsSync(row.annotationPath)) {
            try {
                const content = JSON.parse(fs.readFileSync(row.annotationPath, 'utf8'));
                const items = content.layouts || content.shapes || [];
                items.forEach(item => {
                    const l = item.class || item.label;
                    if (l) labels.add(l);
                });
            } catch (e) {}
        }
    });
    
    const labelArray = Array.from(labels).sort();
    console.log("Actual labels found in annotations:", labelArray);
    
    db.run("UPDATE datasets SET labels = ? WHERE id = ?", [JSON.stringify(labelArray), datasetId], (uErr) => {
        if (uErr) {
            console.error(uErr);
            process.exit(1);
        }
        console.log("Updated dataset labels schema successfully.");
        db.close();
    });
});
