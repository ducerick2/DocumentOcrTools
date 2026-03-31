const fs = require('fs');

const diskFiles = fs.readFileSync('/tmp/disk_files.txt', 'utf8').split('\n').filter(Boolean);
const dbImages = JSON.parse(fs.readFileSync('/tmp/db_images.json', 'utf8'));

const matches = [];
const missing = [];

diskFiles.forEach(diskFile => {
    // Try to find a match in the DB
    // Match logic: originalName ends with disksFile name
    const match = dbImages.find(img => {
        if (!img.originalName) return false;
        const origBase = img.originalName.split('/').pop();
        return origBase === diskFile;
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
    totalDiskFiles: diskFiles.length,
    matchCount: matches.length,
    missingCount: missing.length,
    sampleMatches: matches.slice(0, 5),
    missingSample: missing.slice(0, 5),
    statsByDataset: matches.reduce((acc, m) => {
        acc[m.dbDataset] = (acc[m.dbDataset] || 0) + 1;
        return acc;
    }, {})
}, null, 2));

if (matches.length > 0) {
    fs.writeFileSync('/tmp/recovery_matches.json', JSON.stringify(matches));
}
