const fs = require('fs');
const path = require('path');
const { db, run, get } = require('./database');

const DATA_DIR = path.join(__dirname, 'data');
const DATASETS_FILE = path.join(DATA_DIR, 'datasets.json');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const ANNOTATIONS_DIR = path.join(DATA_DIR, 'annotations');

async function migrate() {
    console.log('Starting migration...');

    if (!fs.existsSync(DATASETS_FILE)) {
        console.log('No datasets.json found. Nothing to migrate.');
        return;
    }

    const datasetsData = JSON.parse(fs.readFileSync(DATASETS_FILE, 'utf8'));

    for (const dataset of datasetsData.datasets) {
        console.log(`Migrating dataset: ${dataset.name} (${dataset.id})`);

        // Check if exists
        const existing = await get('SELECT id FROM datasets WHERE id = ?', [dataset.id]);
        if (existing) {
            console.log(`Dataset ${dataset.id} already exists in DB. Skipping.`);
            // We might want to migrate annotations/images even if dataset exists if they are missing?
            // But let's assume if dataset exists, it's done or partial.
            // For now, skip to avoid duplicates or errors, or we can use INSERT OR IGNORE.
            continue;
        }

        // Insert Dataset
        await run(
            `INSERT INTO datasets (id, name, description, annotationType, labels, createdAt, updatedAt, imageCount, annotatedCount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                dataset.id,
                dataset.name,
                dataset.description || '',
                dataset.annotationType || 'bbox',
                JSON.stringify(dataset.labels || []),
                dataset.createdAt || new Date().toISOString(),
                dataset.updatedAt || new Date().toISOString(),
                dataset.imageCount || 0,
                dataset.annotatedCount || 0
            ]
        );

        // Migrate Images
        const imagesFile = path.join(IMAGES_DIR, `${dataset.id}.json`);
        if (fs.existsSync(imagesFile)) {
            const images = JSON.parse(fs.readFileSync(imagesFile, 'utf8'));
            console.log(`  Migrating ${images.length} images...`);

            await new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.run('BEGIN TRANSACTION');
                    const stmt = db.prepare(`INSERT INTO images (id, datasetId, filename, originalName, path, absolutePath, size, uploadedAt, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                    images.forEach(img => {
                        stmt.run(
                            img.id,
                            dataset.id,
                            img.filename,
                            img.originalName,
                            img.path,
                            img.absolutePath,
                            img.size,
                            img.uploadedAt,
                            img.width || 0,
                            img.height || 0
                        );
                    });

                    stmt.finalize();
                    db.run('COMMIT', (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });
        }

        // Migrate Annotations
        const annotationsFile = path.join(ANNOTATIONS_DIR, `${dataset.id}.json`);
        if (fs.existsSync(annotationsFile)) {
            const annotationsData = JSON.parse(fs.readFileSync(annotationsFile, 'utf8'));
            const annotations = annotationsData.annotations || [];
            console.log(`  Migrating ${annotations.length} annotations...`);

            const usedIds = new Set();

            await new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.run('BEGIN TRANSACTION');
                    const stmt = db.prepare(`INSERT INTO annotations (id, imageId, datasetId, label, type, x, y, width, height, points, content, reading_order, sync, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                    annotations.forEach((ann, index) => {
                        // Ensure ID uniqueness
                        let id = ann.id;
                        if (!id || usedIds.has(id)) {
                            // Generate new ID if missing or duplicate
                            id = Date.now().toString() + Math.random().toString(36).substr(2, 5) + index;
                        }
                        usedIds.add(id);

                        const sync = ann.sync ? JSON.stringify(ann.sync) : null;
                        const points = ann.points ? JSON.stringify(ann.points) : null;

                        stmt.run(
                            id,
                            ann.imageId,
                            dataset.id,
                            ann.label,
                            ann.type || 'bbox',
                            ann.x,
                            ann.y,
                            ann.width,
                            ann.height,
                            points,
                            ann.content || '',
                            ann.reading_order || 0,
                            sync,
                            ann.createdAt || new Date().toISOString()
                        );
                    });

                    stmt.finalize();
                    db.run('COMMIT', (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });
        }
    }

    console.log('Migration completed.');
}

migrate().catch(console.error);
