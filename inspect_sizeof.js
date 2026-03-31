const sizeOf = require('image-size');
console.log("sizeOf type:", typeof sizeOf);
console.log("sizeOf contents:", Object.keys(sizeOf));
try {
   const fs = require('fs');
   const buffer = fs.readFileSync('/data/ducbm3/DocumentOCR/dataset_public/train_part3/autopass/images/10.png');
   console.log("Attempting call with buffer from 10.png...");
   const dims = sizeOf(buffer);
   console.log("Success! Dims:", dims.width, "x", dims.height);
} catch (e) {
   console.error("Failed with buffer direct call:", e.message);
}
