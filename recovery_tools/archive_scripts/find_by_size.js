const { all } = require('./database');

const sizes = [278512, 252584, 229605, 253776];

async function findBySize() {
    try {
        for (const size of sizes) {
            const sql = `
                SELECT i.id, i.filename, i.originalName, i.size, d.name as datasetName
                FROM images i
                JOIN datasets d ON i.datasetId = d.id
                WHERE i.size = ?
            `;
            const rows = await all(sql, [size]);
            console.log(`Results for size ${size}:`, JSON.stringify(rows, null, 2));
        }
    } catch (err) {
        console.error(err);
    }
}

findBySize();
