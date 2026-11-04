// The 30 NBA teams, their page slugs, and the older codes each franchise has played under
// (so the Thunder page counts SuperSonics seasons, the Nets page counts New Jersey, and so on).

export const TEAMS = {
  ATL: { name: 'Atlanta Hawks', conf: 'East', past: ['STL', 'MLH', 'TRI'] },
  BOS: { name: 'Boston Celtics', conf: 'East', past: [] },
  BKN: { name: 'Brooklyn Nets', conf: 'East', past: ['NJN', 'NYN'] },
  CHA: { name: 'Charlotte Hornets', conf: 'East', past: ['CHH'] },
  CHI: { name: 'Chicago Bulls', conf: 'East', past: [] },
  CLE: { name: 'Cleveland Cavaliers', conf: 'East', past: [] },
  DAL: { name: 'Dallas Mavericks', conf: 'West', past: [] },
  DEN: { name: 'Denver Nuggets', conf: 'West', past: [] },
  DET: { name: 'Detroit Pistons', conf: 'East', past: ['FTW'] },
  GSW: { name: 'Golden State Warriors', conf: 'West', past: ['SFW', 'PHW', 'GOS'] },
  HOU: { name: 'Houston Rockets', conf: 'West', past: ['SDR'] },
  IND: { name: 'Indiana Pacers', conf: 'East', past: [] },
  LAC: { name: 'LA Clippers', conf: 'West', past: ['SDC', 'BUF'] },
  LAL: { name: 'Los Angeles Lakers', conf: 'West', past: ['MNL'] },
  MEM: { name: 'Memphis Grizzlies', conf: 'West', past: ['VAN'] },
  MIA: { name: 'Miami Heat', conf: 'East', past: [] },
  MIL: { name: 'Milwaukee Bucks', conf: 'East', past: [] },
  MIN: { name: 'Minnesota Timberwolves', conf: 'West', past: [] },
  NOP: { name: 'New Orleans Pelicans', conf: 'West', past: ['NOH', 'NOK'] },
  NYK: { name: 'New York Knicks', conf: 'East', past: [] },
  OKC: { name: 'Oklahoma City Thunder', conf: 'West', past: ['SEA'] },
  ORL: { name: 'Orlando Magic', conf: 'East', past: [] },
  PHI: { name: 'Philadelphia 76ers', conf: 'East', past: ['SYR'] },
  PHX: { name: 'Phoenix Suns', conf: 'West', past: [] },
  POR: { name: 'Portland Trail Blazers', conf: 'West', past: [] },
  SAC: { name: 'Sacramento Kings', conf: 'West', past: ['KCK', 'KCO', 'CIN', 'ROC'] },
  SAS: { name: 'San Antonio Spurs', conf: 'West', past: [] },
  TOR: { name: 'Toronto Raptors', conf: 'East', past: [] },
  UTA: { name: 'Utah Jazz', conf: 'West', past: ['NOJ'] },
  WAS: { name: 'Washington Wizards', conf: 'East', past: ['WSB', 'CAP', 'BAL', 'CHZ', 'CHP'] },
};
export const teamSlug = abbr => TEAMS[abbr] ? TEAMS[abbr].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null;
export const franchiseOf = code => Object.keys(TEAMS).find(k => k === code || TEAMS[k].past.includes(code)) || null;

// Names for every code that shows up in NBA.com season rows, current and historical.
export const TEAM_NAMES = {
  ...Object.fromEntries(Object.entries(TEAMS).map(([k, t]) => [k, t.name])),
  NJN: 'New Jersey Nets', NYN: 'New York Nets', SEA: 'Seattle SuperSonics', NOH: 'New Orleans Hornets', NOK: 'New Orleans/Oklahoma City Hornets',
  CHH: 'Charlotte Hornets', VAN: 'Vancouver Grizzlies', WSB: 'Washington Bullets', KCK: 'Kansas City Kings', KCO: 'Kansas City-Omaha Kings',
  CIN: 'Cincinnati Royals', ROC: 'Rochester Royals', SDC: 'San Diego Clippers', SDR: 'San Diego Rockets', BUF: 'Buffalo Braves',
  NOJ: 'New Orleans Jazz', SFW: 'San Francisco Warriors', PHW: 'Philadelphia Warriors', GOS: 'Golden State Warriors',
  MNL: 'Minneapolis Lakers', SYR: 'Syracuse Nationals', STL: 'St. Louis Hawks', MLH: 'Milwaukee Hawks', TRI: 'Tri-Cities Blackhawks',
  FTW: 'Fort Wayne Pistons', BAL: 'Baltimore Bullets', CAP: 'Capital Bullets', CHZ: 'Chicago Zephyrs', CHP: 'Chicago Packers',
  INO: 'Indianapolis Olympians', AND: 'Anderson Packers', WAT: 'Waterloo Hawks', SHE: 'Sheboygan Red Skins', PRO: 'Providence Steamrollers',
  WSC: 'Washington Capitols', CHS: 'Chicago Stags', BOM: 'St. Louis Bombers', BLT: 'Baltimore Bullets',
};
