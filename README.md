# Frem Portfolio - Online Testimonials with LinkedIn Login + Google Sheets

This package turns the portfolio into a public website where:
- everyone can view the site and read testimonials
- only visitors who sign in with LinkedIn can submit a testimonial
- testimonials are stored in Google Sheets
- submissions can be auto-published or moderated

## Why this stack
For your requirement, a simple backend is the best fit:
- LinkedIn sign-in now uses OpenID Connect with the `openid`, `profile`, and `email` scopes.
- Google Sheets works well as a lightweight database for a portfolio-sized testimonial feature.
- Formspree is excellent for simple form submission, but it is not the best fit for enforcing "must sign in with LinkedIn before commenting".

## Folder structure
- `public/index.html` -> your portfolio frontend
- `server.js` -> Express backend
- `.env.example` -> environment variable template

## 1) Create a LinkedIn app
1. Open the LinkedIn Developer Portal.
2. Create an app.
3. Make sure **Sign In with LinkedIn using OpenID Connect** is enabled.
4. Add this redirect URL:
   - `http://localhost:3000/auth/linkedin/callback` for local testing
   - your production callback URL later, for example `https://your-domain.com/auth/linkedin/callback`

## 2) Create a Google Sheet
1. Create a new Google Sheet.
2. Copy the spreadsheet ID from the URL.
3. Create a Google Cloud service account.
4. Enable the **Google Sheets API** in your Google Cloud project.
5. Share the sheet with the service account email as **Editor**.

## 3) Configure environment variables
1. Copy `.env.example` to `.env`
2. Fill in:
   - `LINKEDIN_CLIENT_ID`
   - `LINKEDIN_CLIENT_SECRET`
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`
   - `SESSION_SECRET`

## 4) Run locally
```bash
npm install
npm run dev
```

Open:
- `http://localhost:3000`

## 5) Deploy online
You can deploy this package to:
- Render
- Railway
- Fly.io
- a small VPS with Node.js

Use these settings:
- Build command: `npm install`
- Start command: `npm start`

## 6) Moderate or auto-publish
In `.env`:
- `AUTO_PUBLISH=true` -> comments appear immediately
- `AUTO_PUBLISH=false` -> comments are saved with `pending`

If `AUTO_PUBLISH=false`, update the `status` column in the Google Sheet to `approved` or `published` when you want a testimonial to appear on the site.

## Google Sheet columns
The backend automatically prepares these columns:
- created_at
- status
- linkedin_sub
- linkedin_name
- linkedin_email
- linkedin_picture
- role
- message
- profile_url
- site_url

## Important note
This package is deployment-ready, but it is **not deployed yet**. You still need to:
- create your own LinkedIn app
- create your own Google Sheet
- set your environment variables
- deploy it to hosting
