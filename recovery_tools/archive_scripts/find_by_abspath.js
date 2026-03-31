const { all } = require('./database');

async function findImages() {
    try {
        const sql = `
            SELECT i.id, i.filename, i.originalName, i.absolutePath, d.name as datasetName
            FROM images i
            JOIN datasets d ON i.datasetId = d.id
            WHERE i.absolutePath LIKE '%/data/ducbm3/keypoints/data/SuperLayout/train_part3/%'
        `;
        const rows = await all(sql);
        console.log(JSON.stringify({
            count: rows.length,
            datasets: [...new Set(rows.map(r => r.datasetName))],
            sample: rows.slice(0, 5)
        }, null, 2));
    } catch (err) {
        console.error(err);
    }
}

findImages();
