const { all } = require('./database');
const fs = require('fs');

async function dumpImages() {
    try {
        const sql = `
            SELECT i.id, i.datasetId, i.filename, i.originalName, i.absolutePath, d.name as datasetName
            FROM images i
            JOIN datasets d ON i.datasetId = d.id
        `;
        const rows = await all(sql);
        fs.writeFileSync('/tmp/db_images.json', JSON.stringify(rows));
        console.log(`Dumped ${rows.length} images to /tmp/db_images.json`);
    } catch (err) {
        console.error(err);
    }
}

dumpImages();
