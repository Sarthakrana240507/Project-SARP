// Profile photo handling: same safe-storage approach as proof files, but images only and a fixed 5 MB limit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { detectMime, removeFile } = require('./proofFiles');

const avatarDir = path.resolve(__dirname, '../../uploads/avatars');
fs.mkdirSync(avatarDir, { recursive: true });

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const TYPES = { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'] };
const TYPE_ERROR = 'Profile photos must be JPG, JPEG, PNG or WEBP images';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!TYPES[file.mimetype] || !TYPES[file.mimetype].includes(ext)) return cb(Object.assign(new Error(TYPE_ERROR), { status: 400 }));
    cb(null, true);
  },
});

/** Accepts one file in the "photo" field; upload errors become clean JSON. */
const uploadPhoto = (req, res, next) =>
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The photo is too large. Maximum size is 5 MB.' });
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Choose exactly one photo.' });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  });

/** The real file content must be an allowed image AND agree with the extension (a renamed PDF or script is refused). */
function inspectPhoto(file) {
  const mime = detectMime(file.path);
  if (!mime || !TYPES[mime]) return { ok: false, error: 'This file is not a valid JPG, PNG or WEBP image.' };
  if (!TYPES[mime].includes(path.extname(file.originalname).toLowerCase())) return { ok: false, error: 'The file extension does not match the image content.' };
  return { ok: true, mime };
}

/** A stored avatar path is only trusted if it is inside the avatar folder. */
function insideAvatarDir(p) {
  if (!p) return false;
  const rel = path.relative(avatarDir, path.resolve(p));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { uploadPhoto, inspectPhoto, insideAvatarDir, removeFile, MAX_AVATAR_BYTES, avatarDir };
