require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const profilePhotoRoutes = require('./routes/profilePhoto');
const activityRoutes = require('./routes/activities');
const analyticsRoutes = require('./routes/analytics');
const portfolioRoutes = require('./routes/portfolio');
const adminRoutes = require('./routes/admin');
const adminOnboardingRoutes = require('./routes/adminOnboarding');
const adminFacultyRoutes = require('./routes/adminFaculty');
const adminAcademicRoutes = require('./routes/adminAcademic');
const notificationRoutes = require('./routes/notifications');
const supportRoutes = require('./routes/support');
const { initSchema } = require('./models/schema');
const { checkEnv } = require('./config/env');

const app = express();

// Set TRUST_PROXY=1 when running behind a reverse proxy so rate limiting sees real client IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const allowedOrigin = process.env.FRONTEND_URL || true;
app.use(cors({ origin: allowedOrigin, credentials: true, exposedHeaders: ['Content-Disposition'] })); // lets the browser read download file names
app.use(express.json({ limit: '1mb' }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'sarp-api',
    timestamp: new Date().toISOString(),
  });
});

// Application Routes
app.use('/auth/profile/photo', profilePhotoRoutes);
app.use('/auth', authRoutes);
app.use('/activities', activityRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/portfolio', portfolioRoutes);
app.use('/support', supportRoutes.userRouter);
app.use('/admin/support', supportRoutes.adminRouter);
app.use('/admin', adminOnboardingRoutes);
app.use('/admin', adminFacultyRoutes);
app.use('/admin', adminAcademicRoutes);
app.use('/admin', adminRoutes);
app.use('/notifications', notificationRoutes);

// Centralized Error Handling Middleware
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }
  console.error('Unhandled API error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Proof file is too large. Maximum size is 10 MB.' });
  }
  if (err.message?.includes('proof files')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Unexpected server error' });
});

const PORT = process.env.PORT || 5000;

// Initialize database schema and start server when run directly
if (require.main === module) {
  Promise.resolve()
    .then(checkEnv)
    .then(initSchema)
    .then(() => {
      app.listen(PORT, () => {
        console.log(`SARP API running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Startup failed:', err);
      process.exit(1);
    });
}

module.exports = app;
