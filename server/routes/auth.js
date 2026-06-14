const express = require('express');
const passport = require('passport');
const router = express.Router();

// Start Google OAuth flow
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
}));

// Google callback
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: `${process.env.CLIENT_URL}/login?error=auth_failed` }),
  (req, res) => {
    req.session.save(() => {
      res.redirect(`${process.env.CLIENT_URL || 'http://localhost:5173'}/dashboard`);
    })
  }
);

// Get current user
router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { id, email, name, avatar_url } = req.user;
  res.json({ id, email, name, avatar_url });
});

// Logout
router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true });
  });
});

module.exports = router;
