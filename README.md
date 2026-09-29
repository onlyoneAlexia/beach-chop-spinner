# Beach Chop Spinner

A potluck spinner for the beach get-together. Spin for a name, then spin for the food. Whatever lands leaves the wheel, so nobody brings the same thing.

- `index.html`: the website. Guests add their name, spin, and see the full lineup.
- `api/spinner.js`: a Vercel function that stores names and picks in Redis (Upstash REST or any `redis://` connection). Claims are atomic, so two phones spinning at once can't land on the same item. The 30-item menu is added automatically on first load.
- `claude-artifact.html`: the claude.ai version of the same page (not deployed to Vercel).

## Deploy on Vercel

1. On vercel.com, choose **Add New → Project** and import this repository. Keep the default settings and click **Deploy**.
2. In the project, open **Storage** and connect a Redis database: **Upstash for Redis** (free plan) or an existing Redis database from your team. Leave the variable prefix empty.
3. Open **Deployments** and **Redeploy** the latest deployment so it picks up the database settings.

## Host tools

Open the site once with the host link (`https://<your-site>/#host=<key>`). That device then shows Host tools: add or remove menu items, put a pick back on the wheels, and clear all picks. To use a different key, set a `HOST_KEY` environment variable in Vercel and redeploy.

Opening `index.html` straight from your computer runs an offline copy that saves picks on that device only.
