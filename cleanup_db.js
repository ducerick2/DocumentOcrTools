const { all, run } = require('./database');
const fs = require('fs');

async function cleanup() {
    try {
        const images = await all('SELECT id, absolutePath FROM images');
        let deleted = 0;
        for (const img of images) {
            if (!fs.existsSync(img.absolutePath) || fs.statSync(img.absolutePath).isDirectory()) {
                console.log('Deleting bad image entry:', img.absolutePath);
                await run('DELETE FROM images WHERE id = ?', [img.id]);
                deleted++;
            }
        }

        if (deleted > 0) {
            // Update dataset counts
            const datasets = await all('SELECT id FROM datasets');
            for (const d of datasets) {
                const imgCount = await all('SELECT COUNT(*) as count FROM images WHERE datasetId = ?', [d.id]);
                await run('UPDATE datasets SET imageCount = ? WHERE id = ?', [imgCount[0].count, d.id]);

                const annCount = await all('SELECT COUNT(DISTINCT imageId) as count FROM annotations WHERE datasetId = ?', [d.id]);
                await run('UPDATE datasets SET annotatedCount = ? WHERE id = ?', [annCount[0].count, d.id]);
            }
        }

        console.log(`Cleaned up ${deleted} bad entries.`);
    } catch (err) {
        console.error(err);
    }
}

cleanup();
