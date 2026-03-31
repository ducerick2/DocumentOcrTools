const { all } = require('./database');
const datasetId = '1773417750532';

async function checkPaths() {
    try {
        const sql = `
            SELECT i.id, i.filename, i.originalName, i.absolutePath
            FROM images i
            WHERE i.datasetId = ?
            LIMIT 10
        `;
        const rows = await all(sql, [datasetId]);
        console.log(JSON.stringify(rows, null, 2));
    } catch (err) {
        console.error(err);
    }
}

checkPaths();
