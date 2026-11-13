# Clippy status

The page behind [status.clippy.gg](https://status.clippy.gg).

- `services.json` lists what is checked.
- `.github/workflows/check.yml` checks every service every five minutes from GitHub, off the server it watches, and writes `data/`.
- A service that stays down after two retries opens an issue labelled `outage` (and posts to Discord when the `DISCORD_WEBHOOK` secret is set). The issue closes by itself when the service is back.
- `site/` is the page. It reads `data/` live from this repository, so only a change to `site/` deploys.
- A note on an incident (`title`, `note`) can be added by hand in `data/incidents.json`.
