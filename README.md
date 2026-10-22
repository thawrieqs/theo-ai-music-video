# Theo — Image to Music Video AI (Supabase login edition)

## What changed
- Email/password signup and login via Supabase Auth.
- `/api/*` endpoints require a valid Supabase access token.
- Daily quota is stored by Supabase user ID in `public.daily_usage`.
- Token reservation/refund is performed by server-only database functions.
- The server exposes only the Project URL and Publishable key to the browser. The secret key stays server-side.

## Setup checklist
1. In Supabase SQL Editor, run the complete contents of `supabase-setup.sql`. It creates/updates `daily_usage` and installs the quota functions.
2. Configure these environment variables in the hosting provider. For local development, create `.env` from `.env.example`.
   - `SUPABASE_URL`: your Supabase Project URL, e.g. `https://xxxx.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY`: your `sb_publishable_...` key
   - `SUPABASE_SERVICE_ROLE_KEY`: the Supabase secret/service-role key (server environment only)
   - `FAL_KEY`: your fal.ai key
   - `ANTHROPIC_API_KEY`: optional, for reference-video mode
3. In Supabase Authentication settings, Email provider should be enabled. For production, configure Site URL and Redirect URLs to the deployed Theo URL. Email confirmation can be enabled for safer account registration.
4. Install and run with Node.js 20.6+: `npm install`, then `npm start`.
5. Test: register an account, confirm email if required, log in, and check that Theo shows 100 tokens left. Each generation costs 10 tokens.

## Important security notes
- Never put `SUPABASE_SERVICE_ROLE_KEY` in `public/index.html`, any browser code, or a public repository. It bypasses RLS.
- Never commit `.env`; `.gitignore` excludes it.
- Set spending limits on fal.ai. A per-account quota does not prevent someone from creating multiple accounts.
- Job tracking is in server memory, so a server restart can interrupt in-progress jobs. This is an initial implementation, not a full production audit.
- Refunds on failures are best-effort and apply to the current Jakarta date.
