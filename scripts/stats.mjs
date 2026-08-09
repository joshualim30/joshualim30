// Rewrites the stats block in README.md from the GitHub API.
//
// WHY NOT AN IMAGE SERVICE
// The previous README pulled four badges from three third-party hosts. Three of them are dead:
// the visit counter 404s, the trophy service returns 402 Payment Required, and
// github-readme-stats returns 503 because its public Vercel instance is rate limited — its own
// maintainers now tell people to self-host or generate cards in Actions instead. A profile that
// depends on somebody else's free tier is a profile that breaks quietly, and you find out when
// a recruiter mentions it.
//
// So nothing here is fetched at view time. This runs on a schedule, writes plain Markdown into
// the README, and commits it. The numbers are as fresh as the last run and cannot 503, cannot
// be rate limited, and render on a network that blocks third-party images.
//
// WHAT IT WILL NOT PRINT
// Private repository names, descriptions, or anything derived from them beyond a count. Private
// work is somebody else's information as much as it is yours, and a profile README is the least
// controlled surface you have. Language totals are aggregated across everything; the repository
// list is public repositories only.
//
//   node scripts/stats.mjs        (expects GITHUB_TOKEN in the environment)

import { readFileSync, writeFileSync } from 'node:fs';

const USER = process.env.GITHUB_USER ?? 'joshualim30';
const TOKEN = process.env.GITHUB_TOKEN;
const START = '<!-- stats:start -->';
const END = '<!-- stats:end -->';

if (!TOKEN) {
    console.error('stats: GITHUB_TOKEN is not set');
    process.exit(1);
}

async function gh(path, { allow404 = false } = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
        headers: {
            authorization: `Bearer ${TOKEN}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'profile-stats',
        },
    });
    if (!response.ok) {
        if (allow404) return null;
        throw new Error(`${path} -> ${response.status}`);
    }
    return response.json();
}

/**
 * Every repository this account owns, private ones included where the token allows it.
 *
 * `/user/repos` means "repositories of the authenticated user" and needs a token that
 * represents a person. The token GitHub Actions injects by default is a repository-scoped
 * installation token, so it 403s there — which is exactly how this first ran in CI, green
 * locally and broken the moment it left this machine.
 *
 * So: try the private-inclusive endpoint, and fall back to the public one when the token is not
 * allowed to ask. The caller is told which happened, because the difference is not cosmetic —
 * with almost all the work in private repositories, a public-only language chart describes
 * university coursework rather than anything current.
 */
async function ownedRepos() {
    const all = [];
    for (let page = 1; page <= 10; page += 1) {
        const batch = await gh(`/user/repos?per_page=100&page=${page}&affiliation=owner`, {
            allow404: true,
        });
        if (batch === null) break;
        all.push(...batch);
        if (batch.length < 100) return { repos: all, includesPrivate: true };
    }
    if (all.length > 0) return { repos: all, includesPrivate: true };

    const publicOnly = [];
    for (let page = 1; page <= 10; page += 1) {
        const batch = await gh(`/users/${USER}/repos?per_page=100&page=${page}`);
        publicOnly.push(...batch);
        if (batch.length < 100) break;
    }
    return { repos: publicOnly, includesPrivate: false };
}

/** The contribution calendar is GraphQL-only; REST has no equivalent. */
async function graphql(query) {
    const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    if (!response.ok) throw new Error(`graphql -> ${response.status}`);
    const body = await response.json();
    if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data;
}

/* ---------------------------------------------------------------------------------------- */

const user = await gh(`/users/${USER}`);

const { repos, includesPrivate } = await ownedRepos();

const publicRepos = repos.filter((r) => !r.private && !r.fork);
const stars = publicRepos.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);

// Bytes per language across everything, public and private. Aggregated only — a language total
// says what you write in, and nothing about what you write it in for.
const bytes = new Map();
await Promise.all(
    repos.slice(0, 60).map(async (repo) => {
        try {
            const langs = await gh(`/repos/${repo.full_name}/languages`);
            for (const [name, n] of Object.entries(langs)) {
                bytes.set(name, (bytes.get(name) ?? 0) + n);
            }
        } catch {
            /* A repository that vanished between listing and reading is not an error. */
        }
    }),
);

// Under one per cent is coursework and config noise — a 0.6% HTML row says nothing except
// that a repository once had an index file in it.
const total = [...bytes.values()].reduce((a, b) => a + b, 0);
const languages = [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, share: total === 0 ? 0 : (n / total) * 100 }))
    .filter((l) => l.share >= 1)
    .slice(0, 6);

const year = new Date().getUTCFullYear();
const contributions = await graphql(`{
  user(login: "${USER}") {
    contributionsCollection(from: "${year}-01-01T00:00:00Z") {
      contributionCalendar { totalContributions }
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
    }
  }
}`).then((d) => d.user.contributionsCollection);

/* ---------------------------------------------------------------------------------------- */

/**
 * GitHub language names to skillicons.dev slugs.
 *
 * The icon row used to be a hand-written list of eight technologies, which meant it described
 * what was true the day it was typed. It is now generated from the same byte counts as the bar
 * chart below it, so the two can never disagree and neither goes stale.
 *
 * A language with no icon is simply skipped rather than substituted — a wrong icon is worse
 * than a missing one.
 */
const ICONS = {
    TypeScript: 'ts', JavaScript: 'js', Swift: 'swift', Go: 'go', Dart: 'dart',
    Python: 'py', Rust: 'rust', Java: 'java', Kotlin: 'kotlin', Ruby: 'ruby',
    PHP: 'php', 'C#': 'cs', 'C++': 'cpp', C: 'c', HTML: 'html', CSS: 'css',
    Shell: 'bash', Vue: 'vue', Svelte: 'svelte', Lua: 'lua', Elixir: 'elixir',
    Haskell: 'haskell', Scala: 'scala', Solidity: 'solidity', Zig: 'zig',
};

/** A bar drawn in block characters. Renders identically everywhere Markdown does. */
function bar(share, width = 22) {
    const filled = Math.round((share / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

// WHY THERE IS NO COMMIT OR PULL-REQUEST BREAKDOWN.
//
// GitHub reports those per-type figures only for repositories the viewer can see, and lumps
// everything else into `restrictedContributionsCount`. Almost all of this work happens in
// private organisation repositories, so the breakdown reads "26 commits, 0 pull requests"
// against a year with sixteen hundred contributions in it. A number that is technically
// accurate and leaves the reader with precisely the wrong impression is worse than no number.
//
// So: the calendar total, which does include private work, and one sentence saying where the
// rest of it lives. The share is computed rather than written down, so it cannot go stale.
const privateShare = Math.round(
    (contributions.restrictedContributionsCount /
        Math.max(1, contributions.contributionCalendar.totalContributions)) *
        100,
);

const iconSlugs = languages.map((l) => ICONS[l.name]).filter(Boolean).slice(0, 8);

const block = [
    '<div align="center">',
    '',
    `<img src="https://skillicons.dev/icons?i=${iconSlugs.join(',')}&theme=dark" alt="${languages.map((l) => l.name).join(', ')}" />`,
    '',
    '```text',
    ...languages.map(
        ({ name, share }) => `${name.padEnd(13)}${bar(share)} ${share.toFixed(1).padStart(5)}%`,
    ),
    '```',
    '',
    `**${contributions.contributionCalendar.totalContributions.toLocaleString()}** contributions this year · **${publicRepos.length}** public repositories · **${stars}** stars`,
    '',
    `<sub>${privateShare >= 99 ? 'Almost all' : `${privateShare}%`} of this year's work is in private repositories, counted here but never named.</sub>`,
    '',
    '</div>',
].join('\n');

const readme = readFileSync('README.md', 'utf8');
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1) {
    console.error(`stats: markers ${START} / ${END} not found in README.md`);
    process.exit(1);
}

const next = `${readme.slice(0, from + START.length)}\n\n${block}\n\n${readme.slice(to)}`;
if (next === readme) {
    console.log('stats: no change');
    process.exit(0);
}

writeFileSync('README.md', next);
console.log(
    `stats: updated (${languages.length} languages, ` +
        `${includesPrivate ? 'including private repos' : 'PUBLIC REPOS ONLY — set STATS_TOKEN for the full picture'})`,
);
