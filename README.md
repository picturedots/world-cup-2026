# World Cup 2026 Fantasy

A self-hosted fantasy World Cup game for 8 players, [hosted on GitHub Pages](https://picturedots.github.io/world-cup-2026/) and GitHub Actions.

## Setup

### 1. Create the repository
- Create a new GitHub repo (e.g. `world-cup-2026-fantasy`)
- Upload all files from this project maintaining the folder structure
- Go to **Settings → Pages** → set source to **Deploy from branch: main, / (root)**

### 2. Get a football-data.org API key for match data
- Register at [football-data.org](https://www.football-data.org/client/register) (the free tier includes the FIFA World Cup)
- Copy your API token ([API docs](https://docs.football-data.org/general/v4/index.html))

### 3. Add the API key as a GitHub secret
- Go to your repo → **Settings → Secrets and variables → Actions**
- Click **New repository secret**
- Name: `FOOTBALLDATA_KEY`
- Value: your football-data.org API token

### 4. Update the repo config in index.html
Open `index.html` and update these two lines near the top of the script:
```js
const REPO_OWNER = 'picturedots';
const REPO_NAME  = 'world-cup-2026';
```

### 5. Enable GitHub Actions write permissions
- Go to **Settings → Actions → General**
- Under **Workflow permissions**, select **Read and write permissions**
- Click Save

### 6. Create a Personal Access Token (PAT)
The person running the draft needs a PAT to write game data back to the repo.
- GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic)**
- Click **Generate new token (classic)**
- Select the **repo** scope
- Copy the token — paste it into the app when prompted

### 7. Share the game URL
Share your GitHub Pages URL with all players:
`https://picturedots.github.io/world-cup-2026/`

Viewers can see standings without a PAT. Only the person with the PAT can run the draft.

---

## File structure

```
├── index.html                          # Game UI (GitHub Pages)
├── data/
│   ├── draft.json                      # Team selections (written during draft, then locked)
│   └── gamestate.json                  # Points, ownership after swaps, match log
└── .github/
    ├── workflows/
    │   └── update-scores.yml           # Runs every 4 hours
    └── scripts/
        └── update-scores.mjs           # Fetches football-data.org data, recalculates standings
```

## How it works

- **Draft phase**: The app UI handles player setup and team selection. Each pick is committed to `data/draft.json` via the GitHub API. Once the draft is locked, the file is frozen.
- **Tournament phase**: Every 4 hours, the GitHub Action fetches all World Cup matches from [football-data.org](https://www.football-data.org), awards points for completed matches (win = 3pts, draw = 1pt each + team swap), awards advancement bonuses automatically, and commits the updated `data/gamestate.json`. Group finishing positions (for Round of 32 bonuses) are computed from the group-stage results using points, goal difference, goals for, and head-to-head as tiebreakers.
- **Viewing**: Anyone with the GitHub Pages URL sees live standings. The page reads `data/gamestate.json` directly from the repo.

## Triggering manually
You can run the GitHub Action manually at any time:
- Go to **Actions → Update World Cup Scores → Run workflow**

Alternatively you run the API fetcher locally like

```bash
node .github/scripts/update-scores.mjs
```

## Points system
| Event | Points |
|---|---|
| Win | 3 |
| Draw | 1 (+ teams swap owners) |
| Advance to Round of 32 as group winner | 7 |
| Advance to Round of 32 as 2nd place | 5 |
| Advance to Round of 32 as 3rd place | 3 |
| Advance to Round of 16 | 4 |
| Advance to Round of 8 | 5 |
| Advance to Semis | 6 |
| Advance to Final | 7 |
| Champion | 8 |

## Notes for next time
- the match log should contain more data besides `time` and `msg` so that it can be parsed without reading the text (for example, country and points for each award.) -- see [MATCHLOG.md](MATCHLOG.md)
- knockout round penalty kicks are draws, so we should not award +3 points for victory, but +1 instead.  Should we also have a switcheroo at penalty kicks? There should definitely be something ridiculous that happens on penalty kicks.  Liz says we should switch after over time before penality kicks, so you would end up switching your allegiance as the team goes into penalty kicks.
- the knockout bonus points are too high since they are awarded on top of 3 points for victory and thus give too much weight to the last few teams surviving.
