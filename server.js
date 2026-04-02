const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sizeOf = require('image-size').imageSize || require('image-size');
const ffmpeg = require('fluent-ffmpeg');
const { execSync, exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { run, get, all } = require('./database');

// Concurrency limit helper for async tasks
const pLimit = async (concurrency, tasks) => {
    const results = [];
    const executing = new Set();
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        results.push(p);
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean).catch(clean);
        if (executing.size >= concurrency) await Promise.race(executing);
    }
    return Promise.all(results);
};

function getDimensionsSync(pathOrBuffer) {
    if (typeof pathOrBuffer === 'string') {
        try {
            const output = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${pathOrBuffer}"`, { encoding: 'utf8', timeout: 2000 }).trim();
            const [width, height] = output.split('x').map(Number);
            if (width && height) return { width, height };
        } catch (e) { }
    }
    try {
        // Fallback to image-size (works for both path and buffer)
        const sizeOf = require('image-size').imageSize || require('image-size');
        const dims = sizeOf(pathOrBuffer);
        return { width: dims.width || 0, height: dims.height || 0 };
    } catch (e) {
        return { width: 0, height: 0 };
    }
}

async function getDimensionsAsync(pathOrBuffer) {
    if (typeof pathOrBuffer === 'string') {
        try {
            const { stdout } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${pathOrBuffer}"`, { timeout: 5000 });
            const output = stdout.trim();
            const [width, height] = output.split('x').map(Number);
            if (width && height) return { width, height };
        } catch (e) { }
    }
    try {
        const sizeOf = require('image-size').imageSize || require('image-size');
        const dims = sizeOf(pathOrBuffer);
        return { width: dims.width || 0, height: dims.height || 0 };
    } catch (e) {
        return { width: 0, height: 0 };
    }
}

function getActualAnnotationPath(image) {
    if (image.annotationPath && fs.existsSync(image.annotationPath)) {
        return image.annotationPath;
    }
    // Fallback: Check relative to image (handle legacy data)
    if (image.absolutePath) {
        const baseDir = path.dirname(path.dirname(image.absolutePath));
        const imageName = path.parse(image.absolutePath).name;
        const potentialPath = path.join(baseDir, 'annotations', `${imageName}.json`);
        if (fs.existsSync(potentialPath)) {
            return potentialPath;
        }
    }
    return null;
}

async function isAlmostWhite(imagePath, x1, y1, x2, y2) {
    try {
        const w = Math.max(1, Math.round(x2 - x1));
        const h = Math.max(1, Math.round(y2 - y1));
        const x = Math.max(0, Math.round(x1));
        const y = Math.max(0, Math.round(y1));
        
        // Scale to 1x1 and output raw grayscale byte
        const { stdout } = await execAsync(`ffmpeg -v error -i "${imagePath}" -vf "crop=${w}:${h}:${x}:${y},scale=1:1" -f image2pipe -vcodec rawvideo -pix_fmt gray -`, { encoding: 'buffer', timeout: 3000 });
        if (stdout && stdout.length > 0) {
            return stdout[0] > 252; // Threshold: ~99% white (updated from 98% per user request)
        }
    } catch (e) { console.error(`[Whiteness Error] ${e.message}`); }
    return false;
}

function getIoU(boxA, boxB) {
    const xA = Math.max(boxA[0], boxB[0]);
    const yA = Math.max(boxA[1], boxB[1]);
    const xB = Math.min(boxA[2], boxB[2]);
    const yB = Math.min(boxA[3], boxB[3]);
    const interHeight = Math.max(0, yB - yA);
    const interWidth = Math.max(0, xB - xA);
    const interArea = interHeight * interWidth;
    if (interArea <= 0) return 0;
    
    const boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
    const boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);
    const iou = interArea / (boxAArea + boxBArea - interArea);
    return iou;
}

function isContained(boxA, boxB) {
    // Check if boxB is inside boxA
    return boxB[0] >= boxA[0] && boxB[1] >= boxA[1] && boxB[2] <= boxA[2] && boxB[3] <= boxA[3];
}

async function getAnnotationsForImage(image) {
    let annPath = image.annotationPath;

    // If annotationPath is missing, try to locate it relative to image (handle legacy data)
    if (!annPath && image.absolutePath) {
        const baseDir = path.dirname(path.dirname(image.absolutePath));
        const imageName = path.parse(image.absolutePath).name;
        const potentialPath = path.join(baseDir, 'annotations', `${imageName}.json`);
        if (fs.existsSync(potentialPath)) {
            annPath = potentialPath;
            run('UPDATE images SET annotationPath = ? WHERE id = ?', [annPath, image.id]);
        }
    }

    if (annPath && fs.existsSync(annPath)) {
        try {
            const content = JSON.parse(await fs.promises.readFile(annPath, 'utf8'));
            if (content.layouts) {
                const width = image.width || 1000;
                const height = image.height || 1000;

                const denormX = (val) => (val * width) / 1000;
                const denormY = (val) => (val * height) / 1000;

                return content.layouts.map(l => {
                    const ann = {
                        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                        label: l.class || l.label,
                        content: l.content || '',
                        reading_order: l.reading_order || 0
                    };

                    if (l.bbox && l.bbox.length === 4) {
                        ann.type = 'bbox';
                        const x1 = denormX(l.bbox[0]);
                        const y1 = denormY(l.bbox[1]);
                        const x2 = denormX(l.bbox[2]);
                        const y2 = denormY(l.bbox[3]);
                        ann.x = x1; ann.y = y1; ann.width = x2 - x1; ann.height = y2 - y1;
                    } else if (l.poly && Array.isArray(l.poly)) {
                        ann.type = 'polygon';
                        ann.points = l.poly.map(p => ({ x: denormX(p[0]), y: denormY(p[1]) }));
                        const xs = ann.points.map(p => p.x);
                        const ys = ann.points.map(p => p.y);
                        ann.x = Math.min(...xs); ann.y = Math.min(...ys);
                        ann.width = Math.max(...xs) - ann.x; ann.height = Math.max(...ys) - ann.y;
                    }

                    return ann;
                });
            }
        } catch (e) {
            console.error(`Error reading annotations from ${annPath}:`, e);
        }
    }
    return [];
}

const app = express();
const PORT = 3006;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));
// Also allow serving images from the wider data directory for server-side imports
app.use('/api/files', express.static('/data/ducbm3'));

// Storage Configuration
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// --- Dataset Endpoints ---

app.get('/api/datasets', async (req, res) => {
    try {
        const datasets = await all('SELECT * FROM datasets ORDER BY createdAt DESC');
        res.json(datasets.map(d => ({ ...d, labels: JSON.parse(d.labels || '[]') })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/datasets', async (req, res) => {
    const { name, description, annotationType, labels } = req.body;
    const id = Date.now().toString();
    const now = new Date().toISOString();
    try {
        await run(
            'INSERT INTO datasets (id, name, description, annotationType, labels, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, name, description, annotationType, JSON.stringify(labels || []), now, now]
        );
        res.json({ id, name, description, annotationType, labels, createdAt: now });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/datasets/:id', async (req, res) => {
    try {
        const dataset = await get('SELECT * FROM datasets WHERE id = ?', [req.params.id]);
        if (!dataset) return res.status(404).json({ error: 'Dataset not found' });
        dataset.labels = JSON.parse(dataset.labels || '[]');
        res.json(dataset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/datasets/:id', async (req, res) => {
    const { name, description, labels } = req.body;
    try {
        await run(
            'UPDATE datasets SET name = ?, description = ?, labels = ?, updatedAt = ? WHERE id = ?',
            [name, description, JSON.stringify(labels), new Date().toISOString(), req.params.id]
        );
        const updated = await get('SELECT * FROM datasets WHERE id = ?', [req.params.id]);
        updated.labels = JSON.parse(updated.labels);
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/datasets/:id', async (req, res) => {
    try {
        await run('DELETE FROM datasets WHERE id = ?', [req.params.id]);
        res.json({ message: 'Dataset deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Image Endpoints ---

app.get('/api/datasets/:id/images', async (req, res) => {
    try {
        const images = await all('SELECT * FROM images WHERE datasetId = ? ORDER BY uploadedAt ASC', [req.params.id]);
        res.json(images);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/datasets/:id/images', upload.array('images'), async (req, res) => {
    const datasetId = req.params.id;
    const now = new Date().toISOString();
    const results = [];

    try {
        for (const file of req.files) {
            const id = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5);
            const relativePath = `/data/uploads/${file.filename}`;
            const absolutePath = file.path;

            let width = 0, height = 0;
            try {
                const dims = getDimensionsSync(absolutePath);
                width = dims.width;
                height = dims.height;
            } catch (e) {
                console.error(`Size error for upload ${file.filename}:`, e.message);
            }

            await run(
                'INSERT INTO images (id, datasetId, filename, originalName, path, absolutePath, size, uploadedAt, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [id, datasetId, file.filename, file.originalname, relativePath, absolutePath, file.size, now, width, height]
            );
            results.push({ id, filename: file.filename, path: relativePath });
        }

        // Update counts
        const count = await get('SELECT COUNT(*) as count FROM images WHERE datasetId = ?', [datasetId]);
        await run('UPDATE datasets SET imageCount = ? WHERE id = ?', [count.count, datasetId]);

        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Image data (e.g. for lazy dimension updates)
app.patch('/api/images/:id', async (req, res) => {
    const { width, height } = req.body;
    try {
        await run('UPDATE images SET width = ?, height = ? WHERE id = ?', [width, height, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Basic rate limiting / in-memory progress tracking
const importProgress = {};

app.get('/api/datasets/:id/import-progress', (req, res) => {
    const progress = importProgress[req.params.id] || { state: 'idle', current: 0, total: 0 };
    res.json(progress);
});

app.post('/api/datasets/:id/import', async (req, res) => {
    const { sourcePath, fileNames } = req.body;
    const datasetId = req.params.id;
    const now = new Date().toISOString();
    const results = [];

    // Initialize progress
    importProgress[datasetId] = { state: 'scanning', current: 0, total: 0 };

    try {
        console.log(`Pre-scanning for annotations in ${sourcePath}...`);
        const annMap = new Map();
        function scanForAnnsSync(dir) {
            if (!fs.existsSync(dir)) return;
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                if (fs.statSync(fullPath).isDirectory()) scanForAnnsSync(fullPath);
                else if (item.toLowerCase().endsWith('.json')) annMap.set(item.toLowerCase(), fullPath);
            }
        }
        scanForAnnsSync(sourcePath);
        console.log(`Found ${annMap.size} potential annotation files.`);

        const imagesToInsert = [];
        const finalResults = [];

        importProgress[datasetId] = { state: 'scanning', current: 0, total: 0 };

        async function processFile(currentPath, item) {
            const fullPath = path.join(currentPath, item);
            const stats = await fs.promises.stat(fullPath);

            if (stats.isDirectory()) {
                const items = await fs.promises.readdir(fullPath);
                await Promise.all(items.map(i => processFile(fullPath, i)));
            } else if (/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(item)) {
                const imgId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5);
                const annPath = annMap.get(path.parse(item).name.toLowerCase() + '.json');

                let width = 0, height = 0;
                try {
                    const dims = await getDimensionsAsync(fullPath);
                    width = dims.width;
                    height = dims.height;
                } catch (e) {
                    console.error(`Failed to get dimensions for ${fullPath}:`, e.message);
                }

                let isAnnotated = 0;
                if (annPath) {
                    try {
                        const content = JSON.parse(await fs.promises.readFile(annPath, 'utf8'));
                        if (content.layouts && content.layouts.length > 0) {
                            isAnnotated = 1;
                        }
                    } catch (e) {
                        console.error(`Failed to read annotation ${annPath}:`, e);
                    }
                }

                imagesToInsert.push([
                    imgId, datasetId, item, item,
                    `/api/files${fullPath.replace('/data/ducbm3', '')}`,
                    fullPath, stats.size, now, width, height,
                    annPath || null, isAnnotated
                ]);

                finalResults.push({ id: imgId, filename: item });

                // Update progress during scanning
                importProgress[datasetId].current++;
                if (importProgress[datasetId].current % 50 === 0) {
                    console.log(`Analyzed ${importProgress[datasetId].current} files...`);
                }
            }
        }

        console.log(`Scanning image files...`);
        // We first collect all files to get a total count for the progress bar
        const allFiles = [];
        async function collectFiles(currentPath) {
            const items = await fs.promises.readdir(currentPath);
            for (const item of items) {
                const fullPath = path.join(currentPath, item);
                const stats = await fs.promises.stat(fullPath);
                if (stats.isDirectory()) {
                    await collectFiles(fullPath);
                } else if (/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(item)) {
                    allFiles.push({ path: currentPath, item });
                }
            }
        }

        for (const name of fileNames) {
            await collectFiles(path.join(sourcePath, name));
        }

        importProgress[datasetId].total = allFiles.length;
        console.log(`Total images to process: ${allFiles.length}`);

        // Process files with controlled concurrency using our internal helper
        await pLimit(10, allFiles.map(file => () => processFile(file.path, file.item)));

        importProgress[datasetId].state = 'importing';
        importProgress[datasetId].current = 0; // Reset for DB insert phases
        importProgress[datasetId].total = imagesToInsert.length;

        console.log(`Bulk inserting ${imagesToInsert.length} images...`);
        await run('BEGIN TRANSACTION');

        const CHUNK_SIZE = 500;
        for (let i = 0; i < imagesToInsert.length; i += CHUNK_SIZE) {
            const chunk = imagesToInsert.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
            await run(`INSERT INTO images (id, datasetId, filename, originalName, path, absolutePath, size, uploadedAt, width, height, annotationPath, isAnnotated) VALUES ${placeholders}`, chunk.flat());

            importProgress[datasetId].current = Math.min(i + CHUNK_SIZE, imagesToInsert.length);
        }

        importProgress[datasetId].state = 'finalizing';
        console.log(`Finalizing dataset ${datasetId} stats...`);

        // 3. Update Dataset Stats (inside transaction)
        await run(`
            UPDATE datasets 
            SET imageCount = (SELECT COUNT(*) FROM images WHERE datasetId = ?),
                annotatedCount = (SELECT COUNT(*) FROM images WHERE datasetId = ? AND isAnnotated = 1)
            WHERE id = ?
        `, [datasetId, datasetId, datasetId]);

        await run('COMMIT');

        importProgress[datasetId].state = 'completed';
        // Clean up progress after 10 seconds
        setTimeout(() => delete importProgress[datasetId], 10000);

        res.json(finalResults);
    } catch (err) {
        console.error('Import error, rolling back:', err);
        await run('ROLLBACK').catch(() => { });
        importProgress[datasetId] = { state: 'failed', error: err.message, current: 0, total: 0 };
        setTimeout(() => delete importProgress[datasetId], 30000);
        res.status(500).json({ error: err.message });
    }
});

// --- Annotation Endpoints ---

app.get('/api/datasets/:datasetId/annotations/:imageId', async (req, res) => {
    // Prevent caching of annotation data
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    try {
        const image = await get('SELECT * FROM images WHERE id = ?', [req.params.imageId]);
        if (!image) return res.status(404).json({ error: 'Image not found' });

        const annotations = await getAnnotationsForImage(image);
        res.json(annotations);
    } catch (err) {
        console.error('Error fetching annotations:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/datasets/:datasetId/sync-annotations', async (req, res) => {
    const { imageId, annotations } = req.body;
    const datasetId = req.params.datasetId;

    try {
        // 1. Get image info
        const image = await get('SELECT * FROM images WHERE id = ?', [imageId]);
        if (!image || !image.absolutePath) {
            return res.status(404).json({ error: 'Image not found or absolute path missing' });
        }

        // 2. Identify target file paths
        const syncInfo = JSON.parse(image.sync || '{}');
        const baseDir = syncInfo.sourceBaseDir || path.dirname(path.dirname(image.absolutePath));
        const imageName = syncInfo.originalImageId || path.parse(image.absolutePath).name;

        // 3. Normalized coordinates helper
        let imgW = image.width;
        let imgH = image.height;

        if (!imgW || !imgH) {
            try {
                const dims = sizeOf(image.absolutePath);
                imgW = dims.width || 1000;
                imgH = dims.height || 1000;
                await run('UPDATE images SET width = ?, height = ? WHERE id = ?', [imgW, imgH, image.id]);
            } catch (e) {
                imgW = 1000; imgH = 1000;
            }
        }

        const normalizeX = (val) => Math.min(999, Math.max(0, Math.round((val * 1000) / imgW)));
        const normalizeY = (val) => Math.min(999, Math.max(0, Math.round((val * 1000) / imgH)));

        // 4. Create Layout JSON
        const targetFile = path.join(baseDir, 'annotations', `${imageName}.json`);
        let existingData = {};
        if (fs.existsSync(targetFile)) {
            try { existingData = JSON.parse(fs.readFileSync(targetFile, 'utf8')); } catch (e) { }
        }

        const layoutJson = {
            image_id: imageName,
            image_path: image.absolutePath,
            layouts: annotations.map(a => {
                const item = {
                    class: a.label,
                    content: a.content || null,
                    reading_order: a.reading_order || 0
                };
                if ((a.type === 'poly' || a.type === 'polygon') && a.points) {
                    item.poly = a.points.map(p => [normalizeX(p.x), normalizeY(p.y)]);
                } else {
                    item.bbox = [
                        normalizeX(a.x),
                        normalizeY(a.y),
                        normalizeX(a.x + a.width),
                        normalizeY(a.y + a.height)
                    ];
                }
                return item;
            }),
            metadata: existingData.metadata || {
                strategy: "manual_update",
                qa_status: "humanreview",
                updatedAt: new Date().toISOString()
            }
        };

        // 5. File System Sync
        const safeWrite = (subdir, ext, content) => {
            const dir = path.join(baseDir, subdir);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${imageName}.${ext}`), content);
        };

        safeWrite('annotations', 'json', JSON.stringify(layoutJson, null, 2));

        // Sync other formats
        const layoutDetections = layoutJson.layouts.map(l => {
            let coords = "";
            if (l.poly) coords = l.poly.map(p => `${p[0]} ${p[1]}`).join(' ');
            else if (l.bbox) coords = `${l.bbox[0]} ${l.bbox[1]} ${l.bbox[2]} ${l.bbox[3]}`;
            return `<|box_start|>${coords}<|box_end|><|ref_start|>${l.class}<|ref_end|>`;
        }).join('\n');
        safeWrite('layout_detections', 'txt', layoutDetections);

        const sortedItems = [...layoutJson.layouts].sort((a, b) => (a.reading_order || 0) - (b.reading_order || 0));
        const contentText = sortedItems.map(l => l.content || "").join('\n\n');
        safeWrite('texts', 'txt', contentText);
        safeWrite('markdowns', 'md', contentText);

        // 6. DB Sync (Metadata only)
        const isAnnotated = annotations.length > 0 ? 1 : 0;
        await run('UPDATE images SET isAnnotated = ?, annotationPath = ? WHERE id = ?', [isAnnotated, targetFile, imageId]);

        // Update dataset annotatedCount
        await run(`
            UPDATE datasets 
            SET annotatedCount = (SELECT COUNT(*) FROM images WHERE datasetId = ? AND isAnnotated = 1)
            WHERE id = ?
        `, [datasetId, datasetId]);

        res.json({ success: true });
    } catch (err) {
        console.error('Sync error:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Browse & Utils ---

app.post('/api/browse', (req, res) => {
    let targetPath = req.body.path || '/data/ducbm3';
    try {
        if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Path not found' });

        const items = fs.readdirSync(targetPath, { withFileTypes: true })
            .filter(item => !item.name.startsWith('.'))
            .map(item => {
                const absPath = path.join(targetPath, item.name);
                let stats = { size: 0 };
                try { stats = fs.statSync(absPath); } catch (e) { }
                return {
                    name: item.name,
                    path: absPath,
                    isDirectory: item.isDirectory(),
                    size: stats.size
                };
            }).sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name));

        res.json({
            currentPath: targetPath,
            items
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/utils/scan-labels', async (req, res) => {
    const { path: targetPath } = req.body;
    try {
        if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Path not found' });

        const labels = new Set();
        const scan = (dir) => {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullItemPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    scan(fullItemPath);
                } else if (item.name.endsWith('.json')) {
                    try {
                        const content = JSON.parse(fs.readFileSync(fullItemPath, 'utf8'));
                        if (content.layouts) {
                            content.layouts.forEach(l => {
                                if (l.class) labels.add(l.class);
                                else if (l.label) labels.add(l.label);
                            });
                        }
                    } catch (e) { }
                }
            }
        };

        scan(targetPath);
        res.json({ labels: Array.from(labels) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/datasets/:id/images/:filename', (req, res) => {
    const { id, filename } = req.params;
    get('SELECT absolutePath FROM images WHERE datasetId = ? AND filename = ?', [id, filename])
        .then(img => {
            if (!img) return res.status(404).end();
            if (!fs.existsSync(img.absolutePath)) return res.status(404).end();
            res.sendFile(img.absolutePath);
        })
        .catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/datasets/:id/thumbnails/:filename', (req, res) => {
    const { id, filename } = req.params;
    get('SELECT absolutePath FROM images WHERE datasetId = ? AND filename = ?', [id, filename])
        .then(img => {
            if (!img) return res.status(404).end();
            if (!fs.existsSync(img.absolutePath)) return res.status(404).end();

            res.type('image/jpeg');
            const proc = ffmpeg(img.absolutePath)
                .size('200x?')
                .format('mjpeg')
                .on('error', (err) => {
                    console.error(`[ERROR] ffmpeg error: ${err.message}`);
                    if (!res.headersSent) res.status(500).end();
                });

            proc.pipe(res, { end: true });
        })
        .catch(err => {
            console.error(`[ERROR] DB error for thumbnail: ${err.message}`);
            res.status(500).json({ error: err.message });
        });
});

app.post('/api/extract', async (req, res) => {
    // Proxy for VLM extraction
    // This would typically call a local Python process or an external API like Gemini
    const { image, label, model } = req.body;
    console.log(`Extracting with ${model} for label ${label}`);

    // For now, return a placeholder or implement simple proxy logic
    res.json({ content: `[Extracted ${label} content from ${model}]` });
});

app.post('/api/extract-split', async (req, res) => {
    const { image, sourceX, sourceY, sourceW, sourceH, mode } = req.body;
    const runMode = mode || 'layout';
    console.log(`Splitting layout for region: [${sourceX}, ${sourceY}, ${sourceW}, ${sourceH}] with mode: ${runMode}`);

    const { spawn } = require('child_process');
    const pythonExecutable = '/data/ducbm3/VLM/deploy_vintern/bin/python3';
    const pythonProcess = spawn(pythonExecutable, [
        path.join(__dirname, 'utils', 'mineru_split_helper.py'),
        '--mode', runMode
    ]);

    let output = '';
    let errorOutput = '';

    pythonProcess.stdout.on('data', (data) => {
        output += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
    });

    pythonProcess.on('close', (code) => {
        if (errorOutput) {
            console.log(`[SPLIT DEBUG] Stderr: ${errorOutput}`);
        }

        if (code !== 0) {
            console.error(`[ERROR] Split process exited with code ${code}: ${errorOutput}`);
            return res.status(500).json({ error: 'Split failed', message: errorOutput });
        }

        try {
            const result = JSON.parse(output);
            if (result.error) {
                return res.status(500).json({ error: result.error });
            }

            // Transform crop-relative coordinates to global image coordinates
            if (result.layouts) {
                result.layouts = result.layouts.map(l => {
                    const x1 = l.bbox[0];
                    const y1 = l.bbox[1];
                    const x2 = l.bbox[2];
                    const y2 = l.bbox[3];

                    return {
                        ...l,
                        label: l.class || l.label, // Map class to label for annotator.js
                        x: sourceX + x1,
                        y: sourceY + y1,
                        width: x2 - x1,
                        height: y2 - y1
                    };
                });
            }

            res.json(result);
        } catch (e) {
            console.error(`[ERROR] Failed to parse split output: ${e.message}. Output: ${output}`);
            res.status(500).json({ error: 'Invalid response from split process' });
        }
    });

    // Write image data to stdin
    pythonProcess.stdin.write(image);
    pythonProcess.stdin.end();
});

// --- Error Handling ---
app.use((err, req, res, next) => {
    console.error(`[FATAL ERROR] ${err.stack}`);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
});

app.get('/api/datasets/:id/labels', async (req, res) => {
    const { id } = req.params;
    try {
        const dataset = await get('SELECT labels FROM datasets WHERE id = ?', [id]);
        if (!dataset) return res.json([]);
        res.json(JSON.parse(dataset.labels || '[]'));
    } catch (err) {
        console.error(`[ERROR] Failed to fetch labels: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// --- Export Endpoints ---

// Simple consolidated download
app.get('/api/datasets/:id/export/:format', async (req, res) => {
    const { id, format } = req.params;
    try {
        const dataset = await get('SELECT * FROM datasets WHERE id = ?', [id]);
        if (!dataset) return res.status(404).json({ error: 'Dataset not found' });

        const images = await all('SELECT * FROM images WHERE datasetId = ?', [id]);
        const result = {
            dataset: dataset.name,
            export_format: format,
            export_time: new Date().toISOString(),
            images: []
        };

        for (const img of images) {
            const annotations = await getAnnotationsForImage(img);
            result.images.push({
                image_id: img.filename,
                image_path: img.absolutePath,
                width: img.width,
                height: img.height,
                annotations: annotations
            });
        }

        res.json(result);
    } catch (err) {
        console.error(`[ERROR] Export failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Full wizard-based export
app.post('/api/export', async (req, res) => {
    const { datasetId, format, mapping, mergeRules, targetPath, copyImages } = req.body;
    console.log(`Starting export for dataset ${datasetId} in ${format} format to ${targetPath}`);

    try {
        if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath, { recursive: true });
        }

        const dataset = await get('SELECT * FROM datasets WHERE id = ?', [datasetId]);
        const images = await all('SELECT * FROM images WHERE datasetId = ?', [datasetId]);

        const exportLog = [];

        for (const img of images) {
            const annotations = await getAnnotationsForImage(img);

            // Apply mapping and merging
            let processedAnns = annotations.map(a => {
                let label = a.label;
                if (mapping && mapping[label]) label = mapping[label];
                return { ...a, label };
            });

            if (mergeRules && mergeRules.length > 0) {
                // Simplified merge: if transition exists, apply it
                // Note: The UI logic for merging is more complex, but here we just apply the rules
                mergeRules.forEach(rule => {
                    processedAnns = processedAnns.map(a => {
                        if (a.label === rule.fromA || a.label === rule.fromB) {
                            return { ...a, label: rule.to };
                        }
                        return a;
                    });
                });
            }

            // Export to targetPath
            const imgBaseName = path.parse(img.filename).name;

            // Copy image if requested
            if (copyImages) {
                const destImgPath = path.join(targetPath, img.filename);
                if (fs.existsSync(img.absolutePath)) {
                    fs.copyFileSync(img.absolutePath, destImgPath);
                }
            }

            // Write annotation based on format
            if (format === 'labelme') {
                const labelme = {
                    version: "5.0.1",
                    flags: {},
                    shapes: processedAnns.map(a => {
                        let points = [];
                        if (a.type === 'poly' || a.type === 'polygon') {
                            if (Array.isArray(a.points)) {
                                points = a.points.map(p => Array.isArray(p) ? p : [p.x, p.y]);
                            } else if (typeof a.points === 'string') {
                                try {
                                    const parsed = JSON.parse(a.points);
                                    points = parsed.map(p => Array.isArray(p) ? p : [p.x, p.y]);
                                } catch (e) { points = []; }
                            }
                        } else {
                            // Default to 4-point polygon for bboxes (requested by user)
                            points = [
                                [a.x, a.y],
                                [a.x + a.width, a.y],
                                [a.x + a.width, a.y + a.height],
                                [a.x, a.y + a.height]
                            ];
                        }

                        return {
                            label: a.label,
                            points: points,
                            group_id: null,
                            shape_type: 'polygon',
                            flags: {}
                        };
                    }),
                    imagePath: img.filename,
                    imageData: null,
                    imageHeight: img.height || 0,
                    imageWidth: img.width || 0
                };

                // Late extraction for export if missing
                if (labelme.imageWidth === 0 || labelme.imageHeight === 0) {
                    try {
                        const dims = getDimensionsSync(img.absolutePath);
                        labelme.imageWidth = dims.width;
                        labelme.imageHeight = dims.height;
                        run('UPDATE images SET width = ?, height = ? WHERE id = ?', [labelme.imageWidth, labelme.imageHeight, img.id]);
                    } catch (e) { }
                }
                fs.writeFileSync(path.join(targetPath, `${imgBaseName}.json`), JSON.stringify(labelme, null, 2));
            } else {
                // Default to standard Layout JSON if others not implemented
                const layout = {
                    image_id: imgBaseName,
                    image_path: img.filename,
                    layouts: processedAnns.map(a => ({
                        class: a.label,
                        bbox: [a.x, a.y, a.x + a.width, a.y + a.height],
                        content: a.content,
                        reading_order: a.reading_order
                    }))
                };
                fs.writeFileSync(path.join(targetPath, `${imgBaseName}.json`), JSON.stringify(layout, null, 2));
            }

            exportLog.push({ image: img.filename, status: 'success' });
        }

        res.json({ success: true, count: exportLog.length });
    } catch (err) {
        console.error(`[ERROR] Wizard export failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/datasets/:id/clean', async (req, res) => {
    const datasetId = req.params.id;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const images = await all('SELECT * FROM images WHERE datasetId = ?', [datasetId]);
        let totalStats = {
            processed: 0,
            totalImages: images.length,
            removedOutOfBounds: 0,
            removedTiny: 0,
            removedWhite: 0,
            removedDuplicates: 0,
            totalRemoved: 0
        };

        if (images.length === 0) {
            sendEvent({ success: true, stats: totalStats });
            return res.end();
        }

        // Concurrency limit helper
        const CONCURRENCY = 15;
        let imageIndex = 0;

        const processNext = async () => {
            while (imageIndex < images.length) {
                const i = imageIndex++;
                const img = images[i];

                try {
                    const annPath = getActualAnnotationPath(img);
                    if (annPath) {
                        let content = JSON.parse(fs.readFileSync(annPath, 'utf8'));
                        if (content.layouts && content.layouts.length > 0) {
                            const dims = img.width && img.height ? { width: img.width, height: img.height } : getDimensionsSync(img.absolutePath);
                            const { width: imgW, height: imgH } = dims;

                            let originalCount = content.layouts.length;
                            let filtered = [];

                            // 1. Initial filter (Tiny & Out of bounds)
                            for (const item of content.layouts) {
                                if (!item.bbox || !Array.isArray(item.bbox)) {
                                    if (item.poly) filtered.push(item);
                                    continue;
                                }
                                const [x1, y1, x2, y2] = item.bbox;
                                if (x2 <= 0 || y2 <= 0 || x1 >= 1000 || y1 >= 1000) {
                                    totalStats.removedOutOfBounds++;
                                    continue;
                                }
                                const realW = ((x2 - x1) * imgW) / 1000;
                                const realH = ((y2 - y1) * imgH) / 1000;
                                if (realW <= 2 || realH <= 2) {
                                    totalStats.removedTiny++;
                                    continue;
                                }
                                filtered.push(item);
                            }

                             // 2. Clear white/empty boxes (Parallelized)
                            const boxesToCheck = filtered.filter(item => item.bbox && !(item.content && item.content.trim().length > 0));
                            const whiteResults = new Set();
                            
                            // Check boxes in parallel chunks to avoid overloading
                            // We use a small internal concurrency per-image but the overall 
                            // concurrency is high due to 15 concurrent images.
                            const checkTasks = boxesToCheck.map(item => async () => {
                                const [x1, y1, x2, y2] = item.bbox;
                                const denorm = (v, full) => (v * full) / 1000;
                                try {
                                    const isWhite = await isAlmostWhite(img.absolutePath, denorm(x1, imgW), denorm(y1, imgH), denorm(x2, imgW), denorm(y2, imgH));
                                    if (isWhite) whiteResults.add(item);
                                } catch (e) {
                                    console.error(`[Box Check Error] ${e.message}`);
                                }
                            });
                            
                            // Process boxes in parallel (max 5 boxes per image at a time)
                            await pLimit(5, checkTasks);

                            let afterWhiteFilter = [];
                            for (const item of filtered) {
                                if (whiteResults.has(item)) {
                                    totalStats.removedWhite++;
                                } else {
                                    afterWhiteFilter.push(item);
                                }
                            }

                            // 3. Remove duplicates
                            let finished = [];
                            for (let k = 0; k < afterWhiteFilter.length; k++) {
                                let duplicate = false;
                                const itemA = afterWhiteFilter[k];
                                const boxA = itemA.bbox;
                                if (boxA) {
                                    const classA = itemA.class || itemA.label;
                                    for (let m = 0; m < finished.length; m++) {
                                        const itemB = finished[m];
                                        const boxB = itemB.bbox;
                                        const classB = itemB.class || itemB.label;
                                        if (boxB && classA === classB) {
                                            const iou = getIoU(boxA, boxB);
                                            if (iou > 0.95) {
                                                duplicate = true;
                                                totalStats.removedDuplicates++;
                                                break;
                                            }
                                        }
                                    }
                                }
                                if (!duplicate) finished.push(afterWhiteFilter[k]);
                            }

                            if (finished.length !== originalCount) {
                                content.layouts = finished;
                                fs.writeFileSync(annPath, JSON.stringify(content, null, 2));
                                const removedInThisImage = originalCount - finished.length;
                                totalStats.totalRemoved += removedInThisImage;
                                
                                console.log(`[CLEANING] Saved changes to ${img.filename}. Removed ${removedInThisImage} items. (File: ${annPath})`);
                                
                                // Sync DB status
                                const isAnnotated = finished.length > 0 ? 1 : 0;
                                await run('UPDATE images SET isAnnotated = ?, annotationPath = ? WHERE id = ?', [isAnnotated, annPath, img.id]);
                            } else if (!img.annotationPath && annPath) {
                                // If path found via fallback but no changes, still update path in DB
                                await run('UPDATE images SET annotationPath = ? WHERE id = ?', [annPath, img.id]);
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[Cleaning Error for ${img.filename}] ${err.message}`);
                }

                totalStats.processed++;
                // Send progress update every 5 images or if last
                if (totalStats.processed % 5 === 0 || totalStats.processed === images.length) {
                    sendEvent({
                        progress: (totalStats.processed / images.length * 100).toFixed(1),
                        current: totalStats.processed,
                        total: images.length,
                        stats: totalStats
                    });
                }
            }
        };

        // Start workers
        const workers = Array(CONCURRENCY).fill(null).map(() => processNext());
        await Promise.all(workers);

        sendEvent({ success: true, stats: totalStats });
        res.end();
    } catch (err) {
        console.error(`[ERROR] Clean data failed: ${err.message}`);
        sendEvent({ error: err.message });
        res.end();
    }
});

app.post('/api/datasets/:id/check-duplicates', async (req, res) => {
    const { id: datasetId } = req.params;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
        console.log(`[Duplicate Check] Starting scan for dataset ID: ${datasetId}`);
        const images = await all('SELECT * FROM images WHERE datasetId = ?', [datasetId]);
        console.log(`[Duplicate Check] Found ${images.length} images for dataset ${datasetId}`);
        
        if (images.length === 0) {
            console.log(`[Duplicate Check] WARNING: No images found for dataset ${datasetId}`);
        }

        let processed = 0;
        const problematicImageIds = [];

        // Concurrency helpers
        const CONCURRENCY = 15;
        let imageCursor = 0;

        const processNext = async () => {
            while (imageCursor < images.length) {
                const img = images[imageCursor++];
                try {
                    const annPath = getActualAnnotationPath(img);
                    if (annPath && fs.existsSync(annPath)) {
                        const content = JSON.parse(fs.readFileSync(annPath, 'utf8'));
                        const layouts = content.layouts || [];
                        
                        let hasDuplicate = false;
                        
                        // Helper to get bbox from layout (supporting both bbox and poly)
                        const getBbox = (l) => {
                            if (l.bbox && l.bbox.length === 4) return l.bbox;
                            if (l.poly && Array.isArray(l.poly) && l.poly.length > 0) {
                                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                                l.poly.forEach(point => {
                                    if (Array.isArray(point) && point.length >= 2) {
                                        minX = Math.min(minX, point[0]);
                                        minY = Math.min(minY, point[1]);
                                        maxX = Math.max(maxX, point[0]);
                                        maxY = Math.max(maxY, point[1]);
                                    }
                                });
                                if (minX === Infinity) return null;
                                return [minX, minY, maxX, maxY];
                            }
                            return null;
                        };

                        // Check for duplicates/containment
                        for (let i = 0; i < layouts.length; i++) {
                            const boxA = getBbox(layouts[i]);
                            if (!boxA) continue;
                            
                            for (let j = i + 1; j < layouts.length; j++) {
                                const boxB = getBbox(layouts[j]);
                                if (!boxB) continue;
                                
                                const iou = getIoU(boxA, boxB);
                                if (iou > 0.95 || isContained(boxA, boxB) || isContained(boxB, boxA)) {
                                    hasDuplicate = true;
                                    break;
                                }
                            }
                            if (hasDuplicate) break;
                        }

                        if (hasDuplicate) {
                            problematicImageIds.push(img.id);
                        }
                    }
                } catch (err) {
                    console.error(`[Check Duplicate Error for ${img.filename}] ${err.message}`);
                }

                processed++;
                if (processed % 10 === 0 || processed === images.length) {
                    sendEvent({
                        progress: (processed / images.length * 100).toFixed(1),
                        current: processed,
                        total: images.length
                    });
                }
            }
        };

        const workers = Array(CONCURRENCY).fill(null).map(() => processNext());
        await Promise.all(workers);

        sendEvent({ success: true, problematicImageIds });
        res.end();
    } catch (err) {
        console.error(`[ERROR] Check duplicates failed: ${err.message}`);
        sendEvent({ error: err.message });
        res.end();
    }
});

// --- Start Server ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});
