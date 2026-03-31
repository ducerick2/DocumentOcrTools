const { all } = require('./database');

async function findImages() {
    try {
        const sql = `
            SELECT i.id, i.filename, i.originalName, d.name as datasetName, MAX(a.createdAt) as lastEdit
            FROM images i
            JOIN annotations a ON i.id = a.imageId
            JOIN datasets d ON i.datasetId = d.id
            WHERE a.createdAt < '2026-03-12'
            GROUP BY i.id
        `;
        const rows = await all(sql);

        const numericRows = rows.filter(r => {
            const baseFile = r.filename.split('.')[0];
            const baseOrig = r.originalName.split('/').pop().split('.')[0];
            return /^\d+$/.test(baseFile) || /^\d+$/.test(baseOrig);
        });

        const stats = {};
        numericRows.forEach(r => {
            stats[r.datasetName] = (stats[r.datasetName] || 0) + 1;
        });

        console.log(JSON.stringify({
            totalBeforeMar12: rows.length,
            numericCount: numericRows.length,
            statsByDataset: stats,
            sample: numericRows.slice(0, 5)
        }, null, 2));
    } catch (err) {
        console.error(err);
    }
}

findImages();
