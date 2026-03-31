const { get, all } = require('./database');

async function check() {
    try {
        const dataset = await get("SELECT id FROM datasets WHERE name = 'Scaling Fix V6'");
        if (!dataset) {
            console.log("Dataset not found");
            return;
        }
        console.log("Dataset ID:", dataset.id);

        const image = await get("SELECT * FROM images WHERE datasetId = ? LIMIT 1", [dataset.id]);
        if (!image) {
            console.log("No images found");
            return;
        }
        console.log("Image:", image.filename, "Dim:", image.width, "x", image.height);

        const annotations = await all("SELECT * FROM annotations WHERE imageId = ? LIMIT 5", [image.id]);
        console.log("Annotations for image:", image.id);
        annotations.forEach(a => {
            console.log(`- Label: ${a.label}, x: ${a.x}, y: ${a.y}, w: ${a.width}, h: ${a.height}`);
        });
    } catch (e) {
        console.error(e);
    }
}

check();
