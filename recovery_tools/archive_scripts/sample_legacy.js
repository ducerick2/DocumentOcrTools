const { all } = require('./database');

async function sampleLegacy() {
    try {
        const sql = `
            SELECT i.id, i.filename, i.originalName, i.absolutePath, d.name as datasetName, a.createdAt
            FROM images i
            JOIN annotations a ON i.id = a.imageId
            JOIN datasets d ON i.datasetId = d.id
            WHERE a.createdAt < '2026-03-12'
            LIMIT 100
        `;
        const rows = await all(sql);
        console.log(JSON.stringify(rows, null, 2));
    } catch (err) {
        console.error(err);
    }
}

sampleLegacy();
