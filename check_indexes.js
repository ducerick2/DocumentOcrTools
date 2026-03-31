const { db } = require('./database');
db.all("SELECT name FROM sqlite_master WHERE type='index'", (err, rows) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log('Indexes found:');
    rows.forEach(row => console.log(`- ${row.name}`));
    process.exit(0);
});
