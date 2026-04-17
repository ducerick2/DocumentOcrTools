const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const db = new sqlite3.Database(path.join(__dirname, 'data', 'database.db'));

const datasetId = '1775442227104';

db.serialize(() => {
    db.all("SELECT id, absolutePath, filename FROM images WHERE datasetId = ?", [datasetId], (err, rows) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        
        console.log(`Processing ${rows.length} images for dataset TABLE_IN_PAGES...`);
        
        let updatedCount = 0;
        rows.forEach(row => {
            const baseDir = path.dirname(path.dirname(row.absolutePath));
            const imageName = path.parse(row.absolutePath).name;
            const correctAnnPath = path.join(baseDir, 'annotations', `${imageName}.json`);
            
            // Check if file exists (optional, but good for verification)
            const exists = fs.existsSync(correctAnnPath);
            
            db.run("UPDATE images SET annotationPath = ?, isAnnotated = ? WHERE id = ?", 
                [correctAnnPath, exists ? 1 : 0, row.id], (uErr) => {
                    if (uErr) console.error(`Error updating image ${row.id}:`, uErr);
                }
            );
            updatedCount++;
        });
        
        // Update dataset stats
        db.run(`
            UPDATE datasets 
            SET annotatedCount = (SELECT COUNT(*) FROM images WHERE datasetId = ? AND isAnnotated = 1)
            WHERE id = ?
        `, [datasetId, datasetId], (sErr) => {
            if (sErr) console.error("Error updating dataset stats:", sErr);
            console.log(`Successfully updated ${updatedCount} image records and refreshed dataset stats.`);
            db.close();
        });
    });
});
