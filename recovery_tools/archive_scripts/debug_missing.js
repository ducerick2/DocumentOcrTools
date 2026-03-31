const { all } = require('./database');
const fs = require('fs');

const missing = ["100.png", "1000.jpg", "1001.jpg", "1002.jpg", "1003.jpg"];

async function findMissing() {
    try {
        for (const file of missing) {
            const base = file.split('.')[0];
            const sql = `
                SELECT i.id, i.filename, i.originalName, d.name as datasetName
                FROM images i
                JOIN datasets d ON i.datasetId = d.id
                WHERE i.originalName LIKE ? OR i.filename LIKE ?
            `;
            const rows = await all(sql, [`%/${base}.%`, `%-${base}.%`]);
            console.log(`Results for ${file}:`, JSON.stringify(rows, null, 2));
        }
    } catch (err) {
        console.error(err);
    }
}

findMissing();
