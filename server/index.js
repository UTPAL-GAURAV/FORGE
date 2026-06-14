require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const pool = require('./db/pool');

require('./middleware/passport');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const sessionRoutes = require('./routes/sessions');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions' }),
  secret: process.env.SESSION_SECRET || process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  },
}));

app.use(passport.initialize());
app.use(passport.session());

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok', db: 'ok' })
  } catch (err) {
    res.status(500).json({ status: 'error', db: err.message })
  }
});
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/sessions', sessionRoutes);

// Band webhook — Band fires this when an agent receives a message in a room.
// We drive agents through our own /turn endpoint, not Band's execution engine,
// so we acknowledge immediately with an empty result to keep executions clean.
app.post('/api/band/webhook', (req, res) => {
  res.json({})
})

async function ensureTables() {
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS outcome_logged BOOLEAN DEFAULT false`)
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS queues_ready BOOLEAN DEFAULT true`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_debriefs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      verdict TEXT,
      weaknesses JSONB,
      gaps JSONB,
      recommended_focus JSONB,
      session_stats JSONB,
      end_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_outcomes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      meeting_happened BOOLEAN,
      outcome TEXT,
      main_objection TEXT,
      caught_off_guard TEXT,
      wished_prepared TEXT,
      investor_feedback TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
}

ensureTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`)
    })
  })
  .catch(err => {
    console.error('Failed to initialise tables:', err.message)
    process.exit(1)
  })
