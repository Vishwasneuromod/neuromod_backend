# neuromod-api

Backend for the NEUROMOD website (separate project from the React app `my-app`).

| Endpoint | Auth | |
| --- | --- | --- |
| `GET /api/blog`, `?slug=` | none | Blog posts from Hashnode (RSS) |
| `GET /api/faq` | none | Published patient questions |
| `POST /api/auth/login` `{username, password}` | none | Returns a session token (8h) |
| `GET/POST /api/faq/admin`, `PUT/DELETE /api/faq/admin/:id`, `POST /api/faq/admin/reorder` | `Authorization: Bearer <token>` | Editor actions |
| `GET /healthz` | none | Health check |

## Run locally
```bash
cp .env.example .env     # fill in MONGODB_URI, HASHNODE_HOST, SESSION_SECRET
npm install
npm run seed             # loads the 6 starter questions (safe to re-run)
npm run editor -- add <username>   # create an editor; the password is prompted (12+ chars), stored hashed
npm run dev              # http://localhost:8787
npm test                 # in-memory MongoDB, no setup needed
```
The React app (`npm start` in my-app) proxies `/api/*` to port 8787 in development, so no CORS is involved locally.

## Deploy (pick any)
- **Container (Cloud Run, ECS/Fargate, Fly, Render):** `docker build -t neuromod-api .`; set the env vars from `.env.example`; set `TRUST_PROXY=true`.
- **AWS Lambda / Function URL / API Gateway:** handler `lambda.handler`.
- **Second Netlify site:** deploy this folder as its own site; `netlify.toml` and `netlify/functions/api.js` are already set up.

## CORS (browser calls from the website)
- `CORS_ORIGINS` is an exact allowlist, e.g. `https://neuromod.in,https://www.neuromod.in`. No wildcards, no trailing slash. Include `http://localhost:3000` only in development.
- Build the website with `REACT_APP_API_BASE=https://api.neuromod.in`.
- Login uses an `Authorization` header, not cookies, so it works whether the API is on a subdomain or a different domain.
- If you see a CORS error in the browser: check the exact origin (scheme + host + port) is listed, that the API is reachable (a 5xx from a proxy has no CORS headers, which looks like a CORS error), and that you restarted the API after editing env vars.

## Managing editors
```bash
npm run editor -- add <username>      # create, or reset the password of an existing editor
npm run editor -- remove <username>
npm run editor -- list
```
Removing an editor or changing their password signs them out everywhere immediately. Run these with the same `.env` as the API (they talk to the same MongoDB).

## Security notes
- Passwords are salted scrypt hashes in the `editors` collection. Minimum 12 characters. No password is stored in any file or environment variable.
- A wrong username and a wrong password give the identical response, and take the same time.
- Rate limits: 10 attempts per username and 30 per IP per 15 minutes. A successful login clears the username counter.
- Sessions are signed tokens sent in an `Authorization` header and expire after `SESSION_HOURS` (default 8).
- Use a MongoDB user limited to this database. Never commit `.env`. Always serve the site and API over HTTPS, because passwords travel in the login request.
