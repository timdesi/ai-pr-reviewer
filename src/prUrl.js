// Parse a pull-request reference into its platform + identity.
//
// Bitbucket Data Center forms (default platform "bitbucket"):
//   https://host/projects/PROJ/repos/slug/pull-requests/123/overview
//   https://host/projects/PROJ/repos/slug/pull-requests/123
//   //host/projects/PROJ/repos/slug/pull-requests/123
//   PROJ/slug#123
//   PROJ/slug/123
//
// GitHub forms (platform "github"):
//   https://github.com/owner/repo/pull/123            (also any GHES host)
//   //host/owner/repo/pull/123
//   owner/repo/pull/123
//   gh:owner/repo#123
//   gh:https://github.com/owner/repo/pull/123
//
// Bare `owner/repo#123` stays a Bitbucket ref (backward compatible); use a
// `gh:` prefix or a `/pull/` URL to select GitHub explicitly. Every returned
// ref carries `platform`, defaulting to "bitbucket".

function bitbucketRef(projectKey, repoSlug, prId) {
  return { projectKey, repoSlug, prId: Number.parseInt(prId, 10), platform: "bitbucket" };
}

function githubRef(owner, repo, prId) {
  return { projectKey: owner, repoSlug: repo, prId: Number.parseInt(prId, 10), platform: "github" };
}

export function parsePrRef(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Missing pull request reference");
  }
  const raw = input.trim();

  // Explicit GitHub marker: `gh:<ref>` — the same accepted refs, GitHub-forced.
  if (raw.startsWith("gh:")) {
    const id = parsePrRef(raw.slice(3));
    return { ...id, platform: "github" };
  }

  const bitbucketUrl = raw.match(
    /(?:^|\/\/|https?:\/\/[^/]+)\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/i,
  );
  if (bitbucketUrl) {
    return bitbucketRef(bitbucketUrl[1], bitbucketUrl[2], bitbucketUrl[3]);
  }

  const githubUrl = raw.match(
    /(?:^\/\/|https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?/i,
  );
  if (githubUrl) {
    return githubRef(githubUrl[1], githubUrl[2], githubUrl[3]);
  }

  // Host-less GitHub style `owner/repo/pull/N` (never a Bitbucket form).
  const githubHostless = raw.match(/^([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i);
  if (githubHostless) {
    return githubRef(githubHostless[1], githubHostless[2], githubHostless[3]);
  }

  const shortWithHash = raw.match(/^([^/#\s]+)\/([^/#\s]+)#(\d+)$/);
  if (shortWithHash) {
    return bitbucketRef(shortWithHash[1], shortWithHash[2], shortWithHash[3]);
  }

  const shortSlash = raw.match(/^([^/#\s]+)\/([^/#\s]+)\/(\d+)$/);
  if (shortSlash) {
    return bitbucketRef(shortSlash[1], shortSlash[2], shortSlash[3]);
  }

  throw new Error(
    `Unrecognized pull request reference: "${raw}"\n` +
      "Use a PR URL (https://host/projects/KEY/repos/slug/pull-requests/ID or " +
      "https://github.com/owner/repo/pull/ID) or KEY/slug#ID (Bitbucket) / gh:owner/repo#ID (GitHub).",
  );
}
