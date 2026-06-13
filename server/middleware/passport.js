const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const pool = require('../db/pool');

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    const googleId = profile.id;
    const name = profile.displayName;
    const avatarUrl = profile.photos?.[0]?.value;

    const existing = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    if (existing.rows.length > 0) return done(null, existing.rows[0]);

    const byEmail = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (byEmail.rows.length > 0) {
      const updated = await pool.query(
        'UPDATE users SET google_id = $1, name = $2, avatar_url = $3 WHERE email = $4 RETURNING *',
        [googleId, name, avatarUrl, email]
      );
      return done(null, updated.rows[0]);
    }

    const newUser = await pool.query(
      'INSERT INTO users (email, google_id, name, avatar_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, googleId, name, avatarUrl]
    );
    return done(null, newUser.rows[0]);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, result.rows[0] || false);
  } catch (err) {
    done(err);
  }
});
