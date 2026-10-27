import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function authorize({ repository, sha, ref, event, main, pulls }) {
  if (repository !== 'palcertcom/palcert' || ref !== 'refs/heads/main' || event !== 'push') {
    throw new Error('Automatic production promotion requires a push to palcertcom/palcert main');
  }
  if (!/^[a-f0-9]{40}$/.test(sha) || main.sha !== sha) {
    throw new Error('This release is no longer the current main commit');
  }
  const merged = pulls.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === sha &&
      pr.base?.ref === 'main' &&
      pr.base?.repo?.full_name === repository,
  );
  if (merged.length !== 1 || !merged[0].merged_by?.login) {
    throw new Error('Main must be the merge commit of exactly one verified merged PR');
  }
  return {
    repository,
    commit: sha,
    pullRequest: merged[0].number,
    mergedBy: merged[0].merged_by.login,
    mergedAt: merged[0].merged_at,
  };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository !== 'palcertcom/palcert') throw new Error('Unexpected repository');
  const sha = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Invalid commit');
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GitHub API authentication is required');
  async function get(path) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub authorization lookup failed (${response.status})`);
    return response.json();
  }
  const current = await get('commits/main');
  const associated = await get(`commits/${sha}/pulls?per_page=100`);
  // The list response does not always include merged_by; verify full PR records.
  const pulls = await Promise.all(
    associated.filter((pr) => pr.merge_commit_sha === sha).map((pr) => get(`pulls/${pr.number}`)),
  );
  const result = authorize({
    repository,
    sha,
    ref: process.env.GITHUB_REF,
    event: process.env.GITHUB_EVENT_NAME,
    main: current,
    pulls,
  });
  writeFileSync('merge-authorization.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Verified merged PR #${result.pullRequest} at current main ${sha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
