import fs from 'fs';
import path from 'path';

const FOOTBALLDATA_KEY = process.env.FOOTBALLDATA_KEY;
const COMPETITION = 'WC'; // football-data.org code for the FIFA World Cup
const SEASON = 2026;

const BONUS_POINTS = {
  r32_winner: 7,  // Advance to Round of 32 as group winner
  r32_runner: 5,  // Advance to Round of 32 as 2nd place
  r32_third: 3,   // Advance to Round of 32 as 3rd place (best third)
  r16: 4,         // Advance to Round of 16
  qf: 5,          // Advance to Round of 8
  sf: 6,          // Advance to Semis
  final: 7,       // Advance to Final
  champion: 8     // Champion
};

const STAGE_TO_BONUS = {
  'LAST_16': 'r16',
  'QUARTER_FINALS': 'qf',
  'SEMI_FINALS': 'sf',
  'FINAL': 'final'
};

async function footballData(endpoint) {
  const url = `https://api.football-data.org/v4${endpoint}`;
  const res = await fetch(url, {
    headers: { 'X-Auth-Token': FOOTBALLDATA_KEY }
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// Map football-data.org team names to the names used in data/draft.json
function normalizeTeamName(name) {
  const map = {
    'Bosnia-Herzegovina': 'Bosnia and Herzegovina',
    'Cape Verde Islands': 'Cape Verde',
    'Congo DR': 'DR Congo',
    'Turkey': 'Türkiye'
  };
  return map[name] || name;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Static match id -> host city map. football-data.org does not return a venue
// for the World Cup, so cities come from the published fixture schedule.
const VENUE_CITIES = readJson(path.resolve('data/venues.json')).cities;

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Build group tables from finished group-stage matches.
// Returns teamName -> { rank, played, groupComplete }.
// Tiebreakers: points, goal difference, goals for, then head-to-head result.
function computeGroupRanks(matches) {
  const groups = {}; // group -> { teams: Set, results: [] }
  for (const m of matches) {
    if (m.stage !== 'GROUP_STAGE' || !m.group) continue;
    if (!m.homeTeam?.name || !m.awayTeam?.name) continue;
    const g = (groups[m.group] ||= { teams: new Set(), results: [] });
    const home = normalizeTeamName(m.homeTeam.name);
    const away = normalizeTeamName(m.awayTeam.name);
    g.teams.add(home);
    g.teams.add(away);
    if (m.status === 'FINISHED') {
      g.results.push({
        home, away,
        homeGoals: m.score.fullTime.home,
        awayGoals: m.score.fullTime.away,
        winner: m.score.winner
      });
    }
  }

  const rankMap = {};
  for (const g of Object.values(groups)) {
    const table = [...g.teams].map(team => ({ team, pts: 0, gd: 0, gf: 0, played: 0 }));
    const row = team => table.find(r => r.team === team);
    for (const r of g.results) {
      const h = row(r.home), a = row(r.away);
      h.played++; a.played++;
      h.gf += r.homeGoals; a.gf += r.awayGoals;
      h.gd += r.homeGoals - r.awayGoals; a.gd += r.awayGoals - r.homeGoals;
      if (r.winner === 'HOME_TEAM') h.pts += 3;
      else if (r.winner === 'AWAY_TEAM') a.pts += 3;
      else { h.pts += 1; a.pts += 1; }
    }
    table.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
    // Head-to-head tiebreak for adjacent teams that are exactly tied
    for (let i = 0; i < table.length - 1; i++) {
      const a = table[i], b = table[i + 1];
      if (a.pts === b.pts && a.gd === b.gd && a.gf === b.gf) {
        const h2h = g.results.find(r =>
          (r.home === a.team && r.away === b.team) || (r.home === b.team && r.away === a.team)
        );
        const h2hWinner = h2h?.winner === 'HOME_TEAM' ? h2h.home
          : h2h?.winner === 'AWAY_TEAM' ? h2h.away : null;
        if (h2hWinner === b.team) {
          table[i] = b;
          table[i + 1] = a;
        }
      }
    }
    const groupComplete = table.length === 4 && table.every(r => r.played === 3);
    table.forEach((r, i) => {
      rankMap[r.team] = { rank: i + 1, played: r.played, groupComplete };
    });
  }
  return rankMap;
}

async function main() {
  if (!FOOTBALLDATA_KEY) {
    console.error('FOOTBALLDATA_KEY environment variable is not set.');
    process.exit(1);
  }

  const now = new Date();
  const tournamentStart = new Date('2026-06-11');
  const tournamentEnd = new Date('2026-07-20');
  if (now < tournamentStart || now > tournamentEnd) {
    console.log('Outside tournament window (Jun 11 – Jul 20, 2026) — skipping API call.');
    return;
  }

  const draftPath = path.resolve('data/draft.json');
  const gamestatePath = path.resolve('data/gamestate.json');

  const draft = readJson(draftPath);
  const gamestate = readJson(gamestatePath);

  if (!draft.draftComplete) {
    console.log('Draft not complete yet — skipping update.');
    return;
  }

  // Merge ownership: gamestate.ownership overrides draft (accounts for swaps)
  // On first run, gamestate.ownership is empty so we seed from draft
  let ownership = Object.keys(gamestate.ownership).length > 0
    ? { ...gamestate.ownership }
    : { ...draft.ownership };

  const points = { ...gamestate.points };
  const processedMatchIds = new Set(gamestate.processedMatchIds || []);
  const bonusesAwarded = { ...gamestate.bonusesAwarded };
  const matchLog = [...gamestate.matchLog];

  // Seed points for players who have none yet
  draft.players.forEach(p => {
    if (points[p.id] === undefined) points[p.id] = 0;
  });

  // Helper: find player id that owns a team
  function ownerOf(teamName) {
    return ownership[teamName] || null;
  }

  function playerName(pid) {
    return draft.players.find(p => p.id === pid)?.name || pid;
  }

  // Fetch all matches for the tournament
  console.log('Fetching matches from football-data.org...');
  let matches = [];
  try {
    const data = await footballData(`/competitions/${COMPETITION}/matches?season=${SEASON}`);
    matches = data.matches || [];
  } catch (e) {
    console.error('Failed to fetch matches:', e.message);
    process.exit(1);
  }

  const completedMatches = matches.filter(m => m.status === 'FINISHED');
  console.log(`Found ${completedMatches.length} completed matches.`);

  // Build upcoming-match schedule (everything not finished), in chronological order.
  // Team names are null for knockout slots not yet decided; the UI shows those as TBD.
  const upcoming = matches
    .filter(m => m.status !== 'FINISHED')
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .map(m => ({
      id: m.id,
      utcDate: m.utcDate,
      stage: m.stage,
      group: m.group || null,
      home: m.homeTeam?.name ? normalizeTeamName(m.homeTeam.name) : null,
      away: m.awayTeam?.name ? normalizeTeamName(m.awayTeam.name) : null,
      city: VENUE_CITIES[m.id] || null
    }));
  writeJson(path.resolve('data/schedule.json'), {
    matches: upcoming,
    lastUpdated: new Date().toISOString()
  });
  console.log(`schedule.json updated: ${upcoming.length} upcoming matches.`);

  // Process completed matches (win/draw/loss points + swaps)
  for (const match of completedMatches) {
    const id = match.id;
    if (processedMatchIds.has(id)) continue;
    if (!match.homeTeam?.name || !match.awayTeam?.name) continue;

    const home = normalizeTeamName(match.homeTeam.name);
    const away = normalizeTeamName(match.awayTeam.name);
    const homeGoals = match.score.fullTime.home;
    const awayGoals = match.score.fullTime.away;
    const winner = match.score.winner; // HOME_TEAM | AWAY_TEAM | DRAW (includes ET/penalty winners)

    const homeOwner = ownerOf(home);
    const awayOwner = ownerOf(away);

    if (!homeOwner && !awayOwner) {
      processedMatchIds.add(id);
      continue;
    }

    const timestamp = Date.now();

    if (winner === 'HOME_TEAM') {
      if (homeOwner) {
        points[homeOwner] = (points[homeOwner] || 0) + 3;
        matchLog.push({ time: timestamp, msg: `${home} beat ${away} (${homeGoals}-${awayGoals}) → +3 pts for ${playerName(homeOwner)}` });
      }
    } else if (winner === 'AWAY_TEAM') {
      if (awayOwner) {
        points[awayOwner] = (points[awayOwner] || 0) + 3;
        matchLog.push({ time: timestamp, msg: `${away} beat ${home} (${awayGoals}-${homeGoals}) → +3 pts for ${playerName(awayOwner)}` });
      }
    } else {
      // Draw — award 1 pt each and swap teams if both are owned
      if (homeOwner) points[homeOwner] = (points[homeOwner] || 0) + 1;
      if (awayOwner) points[awayOwner] = (points[awayOwner] || 0) + 1;

      if (homeOwner && awayOwner && homeOwner !== awayOwner) {
        ownership[home] = awayOwner;
        ownership[away] = homeOwner;
        matchLog.push({
          time: timestamp,
          msg: `SWITCHEROO! ${home} drew ${away} (${homeGoals}-${awayGoals}) → ${playerName(homeOwner)} +1, ${playerName(awayOwner)} +1. Teams swapped: ${home} → ${playerName(awayOwner)}, ${away} → ${playerName(homeOwner)}`
        });
      } else {
        matchLog.push({
          time: timestamp,
          msg: `SWITCHEROO! ${home} drew ${away} (${homeGoals}-${awayGoals}) → ${homeOwner ? playerName(homeOwner) + ' +1' : ''} ${awayOwner ? playerName(awayOwner) + ' +1' : ''}`
        });
      }
    }

    processedMatchIds.add(id);
  }

  // Award group advancement bonuses (Round of 32) based on group finish position.
  // Group tables are computed from finished group-stage matches.
  const groupRankMap = computeGroupRanks(matches);

  // Find 3rd-place teams that actually advanced (appear in Round of 32 matches)
  const teamsInR32 = new Set();
  for (const match of matches) {
    if (match.stage !== 'LAST_32') continue;
    if (match.homeTeam?.name) teamsInR32.add(normalizeTeamName(match.homeTeam.name));
    if (match.awayTeam?.name) teamsInR32.add(normalizeTeamName(match.awayTeam.name));
  }

  // Track eliminated teams so the UI can strike them out. A team is out when:
  //   - its group is complete and it did not advance, or
  //   - it lost a knockout match.
  const eliminated = new Set(gamestate.eliminated || []);

  // Group-stage eliminations. Rank 4 is always out once the group finishes.
  // Rank 3 advances only as one of the 8 best third-place teams, so it is only
  // safe to call out once every Round-of-32 slot is filled (32 teams).
  const r32SlotsFilled = teamsInR32.size >= 32;
  for (const [team, info] of Object.entries(groupRankMap)) {
    if (!info.groupComplete) continue;
    if (info.rank === 4) eliminated.add(team);
    else if (info.rank === 3 && r32SlotsFilled && !teamsInR32.has(team)) eliminated.add(team);
  }

  // Knockout eliminations: the loser of any finished knockout match is out.
  // SEMI_FINALS is excluded here on purpose — its losers drop into the
  // third-place game, so they stay in until THIRD_PLACE is played (below).
  const KNOCKOUT_STAGES = new Set([
    'LAST_32', 'LAST_16', 'QUARTER_FINALS', 'FINAL'
  ]);
  for (const match of matches) {
    if (match.status !== 'FINISHED') continue;
    if (!match.homeTeam?.name || !match.awayTeam?.name) continue;
    const home = normalizeTeamName(match.homeTeam.name);
    const away = normalizeTeamName(match.awayTeam.name);
    if (KNOCKOUT_STAGES.has(match.stage)) {
      if (match.score.winner === 'HOME_TEAM') eliminated.add(away);
      else if (match.score.winner === 'AWAY_TEAM') eliminated.add(home);
    } else if (match.stage === 'THIRD_PLACE') {
      // Both participants (the two semi-final losers) are out once it's decided.
      eliminated.add(home);
      eliminated.add(away);
    }
  }

  for (const [team, info] of Object.entries(groupRankMap)) {
    if (!info.groupComplete) continue; // Group stage not complete for this group yet

    const owner = ownerOf(team);
    if (!owner) continue;

    let bonusType;
    if (info.rank === 1) {
      bonusType = 'r32_winner'; // Group winners always advance
    } else if (info.rank === 2) {
      bonusType = 'r32_runner'; // Runners-up always advance
    } else if (info.rank === 3 && teamsInR32.has(team)) {
      bonusType = 'r32_third'; // Only best 8 third-place teams advance
    } else {
      continue;
    }

    const bonusKey = `${bonusType}:${team}`;
    if (!bonusesAwarded[bonusKey]) {
      points[owner] = (points[owner] || 0) + BONUS_POINTS[bonusType];
      bonusesAwarded[bonusKey] = true;
      const label = { r32_winner: 'group winner', r32_runner: '2nd place', r32_third: '3rd place' }[bonusType];
      matchLog.push({ time: Date.now(), msg: `${team} advanced to Round of 32 as ${label} → +${BONUS_POINTS[bonusType]} pts for ${playerName(owner)}` });
    }
  }

  // Award round-specific appearance bonuses
  for (const match of matches) {
    const bonusType = STAGE_TO_BONUS[match.stage];
    if (!bonusType) continue;

    for (const side of ['homeTeam', 'awayTeam']) {
      if (!match[side]?.name) continue; // Bracket slot not decided yet
      const team = normalizeTeamName(match[side].name);
      const bonusKey = `${bonusType}:${team}`;
      if (!bonusesAwarded[bonusKey]) {
        const owner = ownerOf(team);
        if (owner) {
          points[owner] = (points[owner] || 0) + BONUS_POINTS[bonusType];
          bonusesAwarded[bonusKey] = true;
          const label = { r16: 'Round of 16', qf: 'Round of 8', sf: 'Semis', final: 'Final' }[bonusType];
          matchLog.push({ time: Date.now(), msg: `${team} reached ${label} → +${BONUS_POINTS[bonusType]} pts for ${playerName(owner)}` });
        }
      }
    }

    // Champion bonus — Final winner (score.winner covers extra time and penalties)
    if (match.stage === 'FINAL' && match.status === 'FINISHED') {
      let champion = null;
      if (match.score.winner === 'HOME_TEAM') champion = normalizeTeamName(match.homeTeam.name);
      else if (match.score.winner === 'AWAY_TEAM') champion = normalizeTeamName(match.awayTeam.name);
      if (champion) {
        const bonusKey = `champion:${champion}`;
        if (!bonusesAwarded[bonusKey]) {
          const owner = ownerOf(champion);
          if (owner) {
            points[owner] = (points[owner] || 0) + BONUS_POINTS.champion;
            bonusesAwarded[bonusKey] = true;
            matchLog.push({ time: Date.now(), msg: `${champion} are World Cup Champions → +${BONUS_POINTS.champion} pts for ${playerName(owner)}` });
          }
        }
      }
    }
  }

  const updatedGamestate = {
    points,
    ownership,
    matchLog,
    bonusesAwarded,
    processedMatchIds: [...processedMatchIds],
    eliminated: [...eliminated],
    lastUpdated: new Date().toISOString()
  };

  writeJson(gamestatePath, updatedGamestate);
  console.log('gamestate.json updated successfully.');
  console.log('Points:', points);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
