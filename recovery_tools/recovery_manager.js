const { all } = require('../database');
const fs = require('fs');
const path = require('path');

/**
 * RecoveryManager consolidates data recovery tasks for train_part3.
 */
class RecoveryManager {
    constructor(config) {
        this.config = config;
        this.dbImages = [];
        this.matches = [];
        this.missing = [];
    }

    async init() {
        console.log("Initializing RecoveryManager...");
        const sql = `
            SELECT i.id, i.datasetId, i.filename, i.originalName, i.absolutePath, i.size, d.name as datasetName
            FROM images i
            JOIN datasets d ON i.datasetId = d.id
        `;
        this.dbImages = await all(sql);
        console.log(`Loaded ${this.dbImages.length} image records from database.`);
    }

    async matchFiles(diskFolder) {
        console.log(`Matching files in ${diskFolder}...`);
        const files = fs.readdirSync(diskFolder).filter(f => /\.(jpg|png|jpeg)$/i.test(f));
        console.log(`Found ${files.length} images on disk.`);

        for (const file of files) {
            const fullPath = path.join(diskFolder, file);
            const stats = fs.statSync(fullPath);
            const size = stats.size;
            const base = file.split('.')[0];

            let match = this.dbImages.find(img => {
                // Match by originalName
                if (img.originalName) {
                    const origBase = img.originalName.split('/').pop().split('.')[0];
                    if (origBase === base) return true;
                }
                // Match by filename
                if (img.filename) {
                    const fileBase = img.filename.split('.')[0];
                    if (fileBase === base || fileBase.endsWith('-' + base)) return true;
                }
                // Match by size as fallback
                if (img.size === size) return true;

                return false;
            });

            if (match) {
                this.matches.push({
                    diskFile: file,
                    diskPath: fullPath,
                    dbId: match.id,
                    dbDataset: match.datasetName,
                    dbFilename: match.filename
                });
            } else {
                this.missing.push(file);
            }
        }

        console.log(`Matches: ${this.matches.length}, Missing: ${this.missing.length}`);
        return { matches: this.matches, missing: this.missing };
    }

    async recover(outputBaseDir) {
        console.log(`Starting recovery to ${outputBaseDir}...`);
        const subdirs = ['images', 'annotations', 'layout_detections', 'markdowns', 'texts'];
        const autopassDir = path.join(outputBaseDir, 'autopass');

        for (const sub of subdirs) {
            fs.mkdirSync(path.join(autopassDir, sub), { recursive: true });
        }

        let recoveredCount = 0;
        for (const m of this.matches) {
            try {
                // Copy Image
                const destImgPath = path.join(autopassDir, 'images', m.diskFile);
                fs.copyFileSync(m.diskPath, destImgPath);

                // Fetch Annotations
                const annotations = await all('SELECT * FROM annotations WHERE imageId = ? ORDER BY reading_order ASC', [m.dbId]);

                const baseName = m.diskFile.split('.')[0];

                // 1. JSON Annotation (Standard Layout Format)
                const layout = {
                    image_id: baseName,
                    image_path: m.diskFile,
                    layouts: annotations.map(a => ({
                        class: a.label,
                        bbox: [a.x, a.y, a.x + a.width, a.y + a.height],
                        content: a.content,
                        reading_order: a.reading_order
                    }))
                };
                fs.writeFileSync(path.join(autopassDir, 'annotations', `${baseName}.json`), JSON.stringify(layout, null, 2));

                // 2. Layout Detection TXT (One per line: label x1 y1 x2 y2 content)
                const layoutTxt = annotations.map(a => `${a.label} ${a.x} ${a.y} ${a.x + a.width} ${a.y + a.height} ${a.content}`).join('\n');
                fs.writeFileSync(path.join(autopassDir, 'layout_detections', `${baseName}.txt`), layoutTxt);

                // 3. Markdowns (Simplified)
                const markdown = annotations.map(a => {
                    if (a.label === 'title') return `# ${a.content}`;
                    if (a.label === 'header') return `## ${a.content}`;
                    return a.content;
                }).join('\n\n');
                fs.writeFileSync(path.join(autopassDir, 'markdowns', `${baseName}.md`), markdown);

                // 4. Texts
                const plainText = annotations.map(a => a.content).join('\n');
                fs.writeFileSync(path.join(autopassDir, 'texts', `${baseName}.txt`), plainText);

                recoveredCount++;
                if (recoveredCount % 100 === 0) console.log(`Recovered ${recoveredCount} files...`);
            } catch (err) {
                console.error(`Failed to recover ${m.diskFile}: ${err.message}`);
            }
        }
        console.log(`Recovery completed. Total recovered: ${recoveredCount}`);
    }
}

// Execution logic
if (require.main === module) {
    const manager = new RecoveryManager();
    const diskFolder = '/data/ducbm3/keypoints/data/SuperLayout/train_part3';
    const outputDir = '/data/ducbm3/DocumentOCR/dataset_public/train_part3_recovery';

    manager.init().then(() => {
        return manager.matchFiles(diskFolder);
    }).then(() => {
        return manager.recover(outputDir);
    }).catch(err => {
        console.error(err);
    });
}

module.exports = RecoveryManager;
