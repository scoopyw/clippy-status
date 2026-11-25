# Clippy status

The page behind [status.clippy.gg](https://status.clippy.gg).

- `services.json` lists what is checked.
- `.github/workflows/check.yml` checks every service every five minutes from GitHub, off the server it watches, and writes `data/`. One run loops for close to six hours and then starts the next one itself, because GitHub's own schedule is best effort; the schedule is only the safety net that restarts the chain.
- A service that stays down after two retries opens an issue labelled `outage` (and posts to Discord when the `DISCORD_WEBHOOK` secret is set). The issue closes by itself when the service is back.
- `site/` is the page. It reads `data/` live from this repository, so only a change to `site/` deploys.
- The page looks like clippy.gg. Its colours and wordmark come from the brand kit the site publishes at `https://clippy.gg/clippy-brand-kit/` (`tokens.json`, `logo/clippy-logo-horizontal-*.svg`, the favicons), and the two typefaces (Outfit, Unbounded, both SIL OFL) are cut down and carried inside `index.html`, so the page loads nothing from anywhere else. When the brand changes, copy it over from the kit; nothing about it is decided here.
- A planned interruption is written by hand as one entry with a `title`, in place of the automatic ones the check made, as on 2026-11-25. The check only ever touches entries that have a `service` and no `end`, so a hand-written entry is left alone.
- A note on an incident (`title`, `note`) can be added by hand in `data/incidents.json`.
