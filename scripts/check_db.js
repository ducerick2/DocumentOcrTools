const { get } = require('./database');

async function check() {
    try {
        const imgCount = await get('SELECT COUNT(*) as count FROM images');
        const annCount = await get('SELECT COUNT(*) as count FROM annotations');
        console.log(`Images: ${imgCount.count}`);
        console.log(`Annotations: ${annCount.count}`);
    } catch (e) {
        console.error(e);
    }
}
check();
