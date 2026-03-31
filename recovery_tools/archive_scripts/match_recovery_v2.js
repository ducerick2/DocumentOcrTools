const fs = require('fs');

const diskFiles = fs.readFileSync('/tmp/disk_files.txt', 'utf8').split('\n').filter(Boolean);
const dbImages = JSON.parse(fs.readFileSync('/tmp/db_images.json', 'utf8'));

const matches = [];
const missing = [];

diskFiles.forEach(diskFile => {
    const diskBase = diskFile.split('.')[0];

    // Try to find a match in the DB
    const match = dbImages.find(img => {
        if (img.originalName) {
            const origBase = img.originalName.split('/').pop().split('.')[0];
            if (origBase === diskBase) return true;
        }
        if (img.filename) {
            const fileBase = img.filename.split('.')[0];
            // Check if it's the hashed format ending with our name
            if (fileBase === diskBase || fileBase.endsWith('-' + diskBase)) return true;
        }
        return false;
    });

    if (match) {
        matches.push({
            diskFile: diskFile,
            dbId: match.id,
            dbDataset: match.datasetName,
            dbPath: match.absolutePath
        });
    } else {
        missing.push(diskFile);
    }
});

console.log(JSON.stringify({
    matchCount: matches.length,
    missingCount: missing.length,
    statsByDataset: matches.reduce((acc, m) => {
        acc[m.dbDataset] = (acc[m.dbDataset] || 0) + 1;
        return acc;
    }, {}),
    sampleMatches: matches.slice(0, 3),
    sampleMissing: missing.slice(0, 10)
}, null, 2));

if (matches.length > 0) {
    fs.writeFileSync('/tmp/recovery_matches.json', JSON.stringify(matches));
}
