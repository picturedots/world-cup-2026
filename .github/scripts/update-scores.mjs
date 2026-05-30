import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const FIFA_WC_2026_ID = 1; // API-Football tournament ID for FIFA World Cup 2026
const SEASON = 2026;

const BONUS_POINTS = {
  knockout: 5,
  r16: 5,
  qf: 8,
  sf: 12,
  final: 18,
  champion: 25
};

const ROUND_TO_BONUS = {
  'Round of 16': 'r16',
  'Quarter-finals': 'qf',
  'Semi-finals': 'sf',
  'Final': 'final'
};

async function apiFootball(endpoint) {
  const url = `https://api-football-v1.p.rapidapi.com/v3${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com'
    }
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

function normalizeTeamName(name) {
  const map = {
    'United States': 'USA',
    'Korea Republic': 'South Korea',
    'IR Iran': 'Iran',
    'Côte d\'Ivoire': 'Ivory Coast',
    'Türkiye': 'Turkey'
  };
  return map[name] || name;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
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
    return ownership[normalizeTeamName(teamName)] || ownership[teamName] || null;
  }

  function playerName(pid) {
    return draft.players.find(p => p.id === pid)?.name || pid;
  }

  // Fetch all fixtures for the tournament
  console.log('Fetching fixtures from API-Football...');
  let fixtures = [];
  try {
    const data = await apiFootball(`/fixtures?league=${FIFA_WC_2026_ID}&season=${SEASON}`);
    fixtures = data.response || [];
  } catch (e) {
    console.error('Failed to fetch fixtures:', e.message);
    process.exit(1);
  }

  const completedFixtures = fixtures.filter(f =>
    f.fixture.status.short === 'FT' || f.fixture.status.short === 'AET' || f.fixture.status.short === 'PEN'
  );

  console.log(`Found ${completedFixtures.length} completed fixtures.`);

  // Process group stage matches (win/draw/loss points + swaps)
  for (const fixture of completedFixtures) {
    const id = fixture.fixture.id;
    if (processedMatchIds.has(id)) continue;

    const round = fixture.league.round || '';
    const isGroupStage = round.toLowerCase().includes('group');

    const homeRaw = fixture.teams.home.name;
    const awayRaw = fixture.teams.away.name;
    const home = normalizeTeamName(homeRaw);
    const away = normalizeTeamName(awayRaw);
    const homeGoals = fixture.goals.home;
    const awayGoals = fixture.goals.away;

    const homeOwner = ownerOf(home);
    const awayOwner = ownerOf(away);

    if (!homeOwner && !awayOwner) {
      processedMatchIds.add(id);
      continue;
    }

    const timestamp = Date.now();

    if (homeGoals > awayGoals) {
      if (homeOwner) {
        points[homeOwner] = (points[homeOwner] || 0) + 3;
        matchLog.push({ time: timestamp, msg: `${home} beat ${away} (${homeGoals}-${awayGoals}) → +3 pts for ${playerName(homeOwner)}` });
      }
    } else if (awayGoals > homeGoals) {
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
          msg: `${home} drew ${away} (${homeGoals}-${awayGoals}) → ${playerName(homeOwner)} +1, ${playerName(awayOwner)} +1. Teams swapped: ${home} → ${playerName(awayOwner)}, ${away} → ${playerName(homeOwner)}`
        });
      } else {
        matchLog.push({
          time: timestamp,
          msg: `${home} drew ${away} (${homeGoals}-${awayGoals}) → ${homeOwner ? playerName(homeOwner) + ' +1' : ''} ${awayOwner ? playerName(awayOwner) + ' +1' : ''}`
        });
      }
    }

    processedMatchIds.add(id);
  }

  // Award knockout stage bonus (advancing past group stage)
  // Find all teams that appear in any knockout round fixture
  const knockoutRounds = new Set(['Round of 16', 'Quarter-finals', 'Semi-finals', 'Final']);
  const teamsInKnockout = new Set();
  for (const fixture of fixtures) {
    const round = fixture.league.round || '';
    if (knockoutRounds.has(round) || round.toLowerCase().includes('round of 16') || round.toLowerCase().includes('quarter') || round.toLowerCase().includes('semi') || round.toLowerCase().includes('final')) {
      teamsInKnockout.add(normalizeTeamName(fixture.teams.home.name));
      teamsInKnockout.add(normalizeTeamName(fixture.teams.away.name));
    }
  }

  for (const team of teamsInKnockout) {
    const bonusKey = `knockout:${team}`;
    if (!bonusesAwarded[bonusKey]) {
      const owner = ownerOf(team);
      if (owner) {
        points[owner] = (points[owner] || 0) + BONUS_POINTS.knockout;
        bonusesAwarded[bonusKey] = true;
        matchLog.push({ time: Date.now(), msg: `${team} advanced to knockout stage → +${BONUS_POINTS.knockout} pts for ${playerName(owner)}` });
      }
    }
  }

  // Award round-specific appearance bonuses
  for (const fixture of fixtures) {
    const round = fixture.league.round || '';
    const bonusType = ROUND_TO_BONUS[round];
    if (!bonusType) continue;

    for (const side of ['home', 'away']) {
      const teamRaw = fixture.teams[side].name;
      const team = normalizeTeamName(teamRaw);
      const bonusKey = `${bonusType}:${team}`;
      if (!bonusesAwarded[bonusKey]) {
        const owner = ownerOf(team);
        if (owner) {
          points[owner] = (points[owner] || 0) + BONUS_POINTS[bonusType];
          bonusesAwarded[bonusKey] = true;
          const label = { r16: 'Round of 16', qf: 'Quarterfinal', sf: 'Semifinal', final: 'Final' }[bonusType];
          matchLog.push({ time: Date.now(), msg: `${team} reached ${label} → +${BONUS_POINTS[bonusType]} pts for ${playerName(owner)}` });
        }
      }
    }

    // Champion bonus — Final winner
    if (round === 'Final') {
      const finalCompleted = fixture.fixture.status.short === 'FT' || fixture.fixture.status.short === 'AET' || fixture.fixture.status.short === 'PEN';
      if (finalCompleted) {
        const homeGoals = fixture.goals.home;
        const awayGoals = fixture.goals.away;
        let champion = null;
        if (homeGoals > awayGoals) champion = normalizeTeamName(fixture.teams.home.name);
        else if (awayGoals > homeGoals) champion = normalizeTeamName(fixture.teams.away.name);
        // Penalty shootout winner
        if (!champion && fixture.fixture.status.short === 'PEN') {
          const homePen = fixture.score.penalty?.home;
          const awayPen = fixture.score.penalty?.away;
          if (homePen > awayPen) champion = normalizeTeamName(fixture.teams.home.name);
          else champion = normalizeTeamName(fixture.teams.away.name);
        }
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
  }

  const updatedGamestate = {
    points,
    ownership,
    matchLog,
    bonusesAwarded,
    processedMatchIds: [...processedMatchIds],
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
