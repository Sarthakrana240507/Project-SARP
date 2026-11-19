// Proof document handling: safe storage, content (not just name) checks, SHA-256, clean-up.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { hashFile } = require('./hash');

const uploadDir = path.resolve(__dirname, '../../uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// Configurable: MAX_PROOF_MB in the environment (default 10, allowed 1-50).
const MAX_PROOF_MB = Math.min(50, Math.max(1, Number(process.env.MAX_PROOF_MB) || 10));
const ALLOWED_TYPES = [
  { mime: 'application/pdf', exts: ['.pdf'] },
  { mime: 'image/png', exts: ['.png'] },
  { mime: 'image/jpeg', exts: ['.jpg', '.jpeg'] },
  { mime: 'image/webp', exts: ['.webp'] },
];
const ALLOWED_EXT = new Set(ALLOWED_TYPES.flatMap((t) => t.exts));
const ALLOWED_MIME = new Set(ALLOWED_TYPES.map((t) => t.mime));
const TYPE_ERROR = 'Only PDF, PNG, JPG, JPEG and WEBP proof files are allowed';

const upload = multer({
  // The stored name is random; only a whitelisted extension from the client is kept.
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_PROOF_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) return cb(Object.assign(new Error(TYPE_ERROR), { status: 400 }));
    cb(null, true);
  },
});

/** Express middleware: accepts one file in the "proof" field and turns upload errors into clean JSON. */
const uploadProof = (req, res, next) =>
  upload.single('proof')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Proof file is too large. Maximum size is ${MAX_PROOF_MB} MB.` });
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Attach exactly one proof file.' });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  });

function removeFile(p) {
  if (!p) return;
  fs.unlink(p, () => {}); // already gone is fine
}

/**
 * Every failure path (validation error, 4xx/5xx, rolled-back transaction) leaves the uploaded file orphaned.
 * Handlers set req.proofKept = true only after the database commit; otherwise the file is deleted when the response ends.
 */
const trackUpload = (req, res, next) => {
  let done = false;
  const sweep = () => {
    if (done) return;
    done = true;
    if (req.file && !req.proofKept) removeFile(req.file.path);
  };
  res.on('finish', sweep);
  res.on('close', sweep);
  next();
};

function detectMime(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(12);
    const n = fs.readSync(fd, b, 0, 12, 0);
    if (n < 4) return null;
    if (b.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
    if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (n >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Checks the real file content and the extension agree, then hashes it. */
async function inspectProof(file) {
  const mime = detectMime(file.path);
  if (!mime) return { ok: false, error: 'Invalid file format: the file content is not a valid PDF, PNG, JPG or WEBP document.' };
  const ext = path.extname(file.originalname).toLowerCase();
  const type = ALLOWED_TYPES.find((t) => t.mime === mime);
  if (!type.exts.includes(ext)) return { ok: false, error: `The file extension ${ext} does not match its content (${type.exts[0]} expected).` };
  return { ok: true, mime, hash: await hashFile(file.path) };
}

module.exports = { MAX_PROOF_MB, ALLOWED_TYPES, uploadProof, trackUpload, removeFile, inspectProof, detectMime };
