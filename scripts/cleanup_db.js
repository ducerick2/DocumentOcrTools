const { run } = require('./database');

async function cleanup() {
    try {
        console.log('Cleaning up database...');
        await run('DELETE FROM datasets');
        console.log('Cleanup complete.');
    } catch (e) {
        console.error(e);
    }
}
cleanup();
