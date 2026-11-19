// "My profile photo". Every route acts on req.user only: there is no id in the URL, so a user cannot touch anyone else's picture.
// The database stores a file reference; the image itself is served only to its owner through an authenticated request.
const express = require('express');
const fs = require('fs');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { uploadPhoto, inspectPhoto, insideAvatarDir, removeFile } = require('../utils/avatarFiles');

const router = express.Router();
router.use(requireAuth);

const photoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  keyFn: (req) => `photo|${req.user?.id || req.ip}`,
  message: 'Too many photo changes. Please try again later.',
});

const summary = (row) => ({ has_photo: Boolean(row.profile_image_path), photo_version: row.profile_image_updated_at ? new Date(row.profile_image_updated_at).getTime() : null });

/** PUT /auth/profile/photo  (multipart, field "photo") - upload or replace. */
router.put('/', photoLimiter, (req, res, next) => {
  // A file that is not committed to the database is always deleted again.
  let kept = false;
  const sweep = () => { if (req.file && !kept) removeFile(req.file.path); };
  res.on('finish', sweep); res.on('close', sweep);
  req.markPhotoKept = () => { kept = true; };
  next();
}, uploadPhoto, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a photo to upload.' });
    const check = inspectPhoto(req.file);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const old = (await pool.query('SELECT profile_image_path FROM users WHERE id = $1', [req.user.id])).rows[0];
    const r = await pool.query(
      `UPDATE users SET profile_image_path = $1, profile_image_mime = $2, profile_image_updated_at = NOW() WHERE id = $3
       RETURNING profile_image_path, profile_image_updated_at`, [req.file.path, check.mime, req.user.id]);
    req.markPhotoKept();
    if (old?.profile_image_path && old.profile_image_path !== req.file.path && insideAvatarDir(old.profile_image_path)) removeFile(old.profile_image_path);
    res.json({ ...summary(r.rows[0]), message: old?.profile_image_path ? 'Profile photo replaced.' : 'Profile photo uploaded.' });
  } catch (err) {
    console.error('Profile photo upload error:', err.message);
    res.status(500).json({ error: 'Could not save the photo. Please try again.' });
  }
});

/** DELETE /auth/profile/photo - back to the initials avatar. */
router.delete('/', photoLimiter, async (req, res) => {
  try {
    const old = (await pool.query('SELECT profile_image_path FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!old?.profile_image_path) return res.status(404).json({ error: 'There is no profile photo to remove.' });
    await pool.query('UPDATE users SET profile_image_path = NULL, profile_image_mime = NULL, profile_image_updated_at = NULL WHERE id = $1', [req.user.id]);
    if (insideAvatarDir(old.profile_image_path)) removeFile(old.profile_image_path);
    res.json({ has_photo: false, photo_version: null, message: 'Profile photo removed.' });
  } catch (err) {
    console.error('Profile photo removal error:', err.message);
    res.status(500).json({ error: 'Could not remove the photo. Please try again.' });
  }
});

/** GET /auth/profile/photo - the signed-in user's own photo (404 when there is none). */
router.get('/', async (req, res) => {
  try {
    const row = (await pool.query('SELECT profile_image_path, profile_image_mime FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!row?.profile_image_path || !insideAvatarDir(row.profile_image_path) || !fs.existsSync(row.profile_image_path)) {
      return res.status(404).json({ error: 'No profile photo' });
    }
    res.setHeader('Content-Type', row.profile_image_mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(row.profile_image_path).pipe(res);
  } catch (err) {
    console.error('Profile photo read error:', err.message);
    res.status(500).json({ error: 'Could not load the photo' });
  }
});

module.exports = router;
