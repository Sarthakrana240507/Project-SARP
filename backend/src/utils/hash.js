const crypto = require('crypto');
const fs = require('fs');

// Computes the SHA-256 hash of a file on disk.
// This is the core of the "verification engine" — the same certificate
// re-uploaded anywhere will always produce the same hash, and any change
// to the file's bytes (even one pixel) produces a completely different hash.
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = { hashFile };
