import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs/promises';
import express from 'express';
import session from 'express-session';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeJwt } from 'jose';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const {
  BASE_URL = `http://localhost:${PORT}`,
  SESSION_SECRET = 'change-this-session-secret',
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_SERVICE_ACCOUNT_FILE,
  TESTIMONIAL_SHEET_NAME = 'Testimonials',
  AUTO_PUBLISH = 'true',
} = process.env;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'frem.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    unset: 'destroy',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// Safer default for LinkedIn OIDC.
// If your LinkedIn app explicitly supports email scope, you can change this to:
// ['openid', 'profile', 'email']
const LINKEDIN_SCOPES = ['openid', 'profile'];

const LINKEDIN_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

function getRedirectUri() {
  return `${BASE_URL.replace(/\/$/, '')}/auth/linkedin/callback`;
}

async function getGoogleCredentials() {
  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  if (GOOGLE_SERVICE_ACCOUNT_FILE) {
    const raw = await fs.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, 'utf-8');
    return JSON.parse(raw);
  }

  throw new Error('Missing Google service account credentials.');
}

async function getSheetsClient() {
  const credentials = await getGoogleCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

async function ensureTestimonialsSheet(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEET_ID,
  });

  const existing = (spreadsheet.data.sheets || []).find(
    (sheet) => sheet.properties && sheet.properties.title === TESTIMONIAL_SHEET_NAME
  );

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title: TESTIMONIAL_SHEET_NAME },
            },
          },
        ],
      },
    });
  }

  const headerRange = `${TESTIMONIAL_SHEET_NAME}!A1:J1`;
  const headerCheck = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: headerRange,
  });

  const headers = (headerCheck.data.values || [])[0];
  if (!headers || !headers.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: headerRange,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'created_at',
          'status',
          'linkedin_sub',
          'linkedin_name',
          'linkedin_email',
          'linkedin_picture',
          'role',
          'message',
          'profile_url',
          'site_url',
        ]],
      },
    });
  }
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

async function listTestimonials() {
  const sheets = await getSheetsClient();
  await ensureTestimonialsSheet(sheets);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${TESTIMONIAL_SHEET_NAME}!A:J`,
  });

  const rows = response.data.values || [];
  if (rows.length <= 1) return [];

  const headers = rows[0];
  const body = rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] || '';
    });
    return record;
  });

  return body
    .filter((item) => ['published', 'approved'].includes(normalizeStatus(item.status)))
    .reverse()
    .map((item) => ({
      createdAt: item.created_at,
      status: normalizeStatus(item.status),
      name: item.linkedin_name,
      email: item.linkedin_email,
      role: item.role,
      message: item.message,
      picture: item.linkedin_picture,
      profileUrl: item.profile_url,
    }));
}

async function appendTestimonial({ user, role, message, siteUrl }) {
  const sheets = await getSheetsClient();
  await ensureTestimonialsSheet(sheets);

  const status = AUTO_PUBLISH === 'true' ? 'published' : 'pending';

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${TESTIMONIAL_SHEET_NAME}!A:J`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        new Date().toISOString(),
        status,
        user.sub || '',
        user.name || '',
        user.email || '',
        user.picture || '',
        role,
        message,
        user.profile || '',
        siteUrl || '',
      ]],
    },
  });

  return status;
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Please sign in with LinkedIn first.' });
  }
  next();
}

app.get('/auth/linkedin', (req, res) => {
  if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
    return res.status(500).send('LinkedIn is not configured yet.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  req.session.oauthState = state;
  req.session.oauthNonce = nonce;

  req.session.save((err) => {
    if (err) {
      console.error('Failed to save OAuth session:', err);
      return res.status(500).send('Unable to start LinkedIn login.');
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: LINKEDIN_CLIENT_ID,
      redirect_uri: getRedirectUri(),
      scope: LINKEDIN_SCOPES.join(' '),
      state,
      nonce,
    });

    return res.redirect(`${LINKEDIN_AUTHORIZE_URL}?${params.toString()}`);
  });
});

app.get('/auth/linkedin/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res
        .status(400)
        .send(`LinkedIn login failed: ${error_description || error}`);
    }

    const savedState = req.session?.oauthState;
    const savedNonce = req.session?.oauthNonce;

    if (!code || !state || !savedState || state !== savedState) {
      return res.status(400).send('Invalid login state.');
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      client_id: LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_CLIENT_SECRET,
      redirect_uri: getRedirectUri(),
    });

    const tokenResponse = await axios.post(
      LINKEDIN_TOKEN_URL,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const { id_token: idToken, access_token: accessToken } = tokenResponse.data || {};

    if (!idToken) {
      return res.status(500).send('LinkedIn did not return an ID token.');
    }

    const claims = decodeJwt(idToken);

    if (savedNonce && claims.nonce && claims.nonce !== savedNonce) {
      return res.status(400).send('Invalid OIDC nonce.');
    }

    req.session.user = {
      sub: claims.sub,
      name:
        claims.name ||
        [claims.given_name, claims.family_name].filter(Boolean).join(' ') ||
        'LinkedIn member',
      email: claims.email || '',
      picture: claims.picture || '',
      profile: claims.profile || '',
      accessToken,
    };

    delete req.session.oauthState;
    delete req.session.oauthNonce;

    req.session.save((err) => {
      if (err) {
        console.error('Failed to save login session:', err);
        return res.status(500).send('Unable to complete LinkedIn login.');
      }

      return res.redirect('/#testimonials');
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Unable to complete LinkedIn login.');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) {
    return res.json({ authenticated: false, user: null });
  }

  const { sub, name, email, picture, profile } = req.session.user;

  res.json({
    authenticated: true,
    user: { sub, name, email, picture, profile },
  });
});

app.get('/api/testimonials', async (req, res) => {
  try {
    const testimonials = await listTestimonials();
    res.json({ testimonials });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Unable to load testimonials.' });
  }
});

app.post('/api/testimonials', requireAuth, async (req, res) => {
  try {
    const role = String(req.body.role || '').trim();
    const message = String(req.body.message || '').trim();

    if (!role || !message) {
      return res
        .status(400)
        .json({ error: 'Role/company and message are required.' });
    }

    const status = await appendTestimonial({
      user: req.session.user,
      role,
      message,
      siteUrl: BASE_URL,
    });

    res.json({ ok: true, status });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Unable to save testimonial.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Portfolio app listening on http://localhost:${PORT}`);
});
