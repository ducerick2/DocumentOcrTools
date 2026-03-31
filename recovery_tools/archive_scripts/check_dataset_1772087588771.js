const { all } = require('./database');
const datasetId = '1772087588771';

async function findImages() {
    try {
        const sql = `
            SELECT i.id, i.filename, i.originalName, i.absolutePath
            FROM images i
            WHERE i.datasetId = ?
            LIMIT 20
        `;
        const rows = await all(sql, [datasetId]);
        console.log(JSON.stringify(rows, null, 2));
    } catch (err) {
        console.error(err);
    }
}

findImages();
